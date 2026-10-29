'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { pipeline } = require('node:stream/promises');
const { spawn } = require('node:child_process');
const yazl = require('yazl');

const { analyzeApp } = require('./analyzer');
const { DEFAULT_ELECTRON_FLAGS, detectElectronApp, findHostAdb } = require('./electron');
const { buildAppIcon } = require('./icons');
const { buildInfoPlist } = require('./plist');
const { generateRegistryKeys } = require('./registry');
const { resolveEngine } = require('./resolver');
const { downloadFile } = require('./download');
const {
  bundleIdentifier,
  clamp,
  copyFilePreserve,
  ensureDir,
  formatBytes,
  isPathInside,
  nameSimilarity,
  normalizeForCompare,
  pathExists,
  payloadRelativeForWindowsPath,
  readJson,
  safeRemove,
  sanitizeFilename,
  sha256File,
  shellQuote,
  toPosix,
  walkFiles,
  writeJson,
  xmlEscape,
} = require('./util');

const PKG = require('../package.json');
const RESOURCES = path.join(__dirname, '..', 'resources');
const TEMPLATES = path.join(RESOURCES, 'templates');
const SCRIPTS = path.join(RESOURCES, 'scripts');
const VERIFY_SCRIPT = path.join(SCRIPTS, 'verify-signature.ps1');
const POWERSHELL = process.env.SystemRoot
  ? path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  : 'powershell.exe';
const REG_EXE = process.env.SystemRoot
  ? path.join(process.env.SystemRoot, 'System32', 'reg.exe')
  : 'reg.exe';

const VC_REDIST = {
  x64: {
    url: 'https://aka.ms/vs/17/release/vc_redist.x64.exe',
    name: 'vc_redist.x64.exe',
    label: 'Visual C++ 2015–2022 (x64)',
  },
  x86: {
    url: 'https://aka.ms/vs/17/release/vc_redist.x86.exe',
    name: 'vc_redist.x86.exe',
    label: 'Visual C++ 2015–2022 (x86)',
  },
};
const WINE_MONO = {
  version: '11.3.0',
  url: 'https://dl.winehq.org/wine/wine-mono/11.3.0/wine-mono-11.3.0-x86.msi',
  name: 'wine-mono-11.3.0-x86.msi',
  label: 'Wine Mono 11.3.0',
};
const UNSUPPORTED_ROOTS = new Set(
  ['c:\\', 'c:\\program files', 'c:\\program files (x86)', 'c:\\users', 'c:\\windows'].map(normalizeForCompare),
);

function prettyEngineName(meta) {
  if (!meta) return 'Wine';
  const name = String(meta.name || '');
  const version = String(meta.version || meta.release || '').replace(/^v/, '');
  if (/wine-staging/i.test(name)) return `Wine Staging${version ? ` ${version}` : ''}`;
  if (/wine-devel/i.test(name)) return `Wine Devel${version ? ` ${version}` : ''}`;
  if (/crossover/i.test(name)) return `CrossOver${version ? ` ${version}` : ''}`;
  if (/game[- ]?porting/i.test(name)) return `Apple GPTK${version ? ` ${version}` : ''}`;
  return name || version || 'Wine';
}

function emit(onProgress, stage, message, extra = {}) {
  if (onProgress) onProgress({ stage, message, ...extra });
}

function localDataDir(sub) {
  const base = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  return path.join(base, 'Win2Mac', sub);
}

function parseCommandLine(commandLine) {
  const args = [];
  const input = String(commandLine || '');
  let i = 0;
  while (i < input.length) {
    while (i < input.length && /\s/.test(input[i])) i += 1;
    if (i >= input.length) break;
    let arg = '';
    let inQuotes = false;
    while (i < input.length) {
      const ch = input[i];
      if (ch === '\\' && inQuotes && input[i + 1] === '"') {
        arg += '"';
        i += 2;
        continue;
      }
      if (ch === '"') {
        if (inQuotes && input[i + 1] === '"') {
          arg += '"';
          i += 2;
          continue;
        }
        inQuotes = !inQuotes;
        i += 1;
        continue;
      }
      if (!inQuotes && /\s/.test(ch)) break;
      arg += ch;
      i += 1;
    }
    args.push(arg);
  }
  return args;
}


const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

function normalizeAdvanced(input = {}) {
  const env = new Map();
  const addEnv = (name, value) => {
    const clean = String(name || '').trim();
    if (!ENV_NAME_RE.test(clean)) throw new Error(`环境变量名无效：${clean || '(空)'}`);
    env.set(clean, String(value ?? ''));
  };
  if (input.metalHud) addEnv('MTL_HUD_ENABLED', '1');
  if (input.dxvkHud) addEnv('DXVK_HUD', 'fps');
  const envText = String(input.envText || '');
  for (const rawLine of envText.split(String.fromCharCode(10))) {
    const line = rawLine.endsWith(String.fromCharCode(13)) ? rawLine.slice(0, -1) : rawLine;
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) throw new Error(`环境变量格式应为 KEY=VALUE：${trimmed}`);
    addEnv(trimmed.slice(0, eq).trim(), trimmed.slice(eq + 1));
  }
  const wineDebug = ['off', 'warn', 'all'].includes(input.wineDebug) ? input.wineDebug : 'off';
  const electronCompat = input.electronCompat !== false;
  const electronFlags = electronCompat
    ? parseCommandLine(String(input.electronFlags || '').trim() || DEFAULT_ELECTRON_FLAGS.join(' '))
    : [];
  return {
    env: [...env.entries()].map(([name, value]) => ({ name, value })),
    verifyIntegrity: Boolean(input.verifyIntegrity),
    preventSleep: Boolean(input.preventSleep),
    wineDebug,
    launchArgs: String(input.launchArgs || ''),
    electronCompat,
    electronFlags,
  };
}


function defaultInstallerAnalysis(appName) {
  return {
    grade: 'C',
    gradeLabel: '需要调校',
    gradeTone: 'amber',
    gradeSummary: '实验性安装器模式：目标程序尚未安装，兼容性未知。',
    score: 55,
    blocked: false,
    gameLikely: false,
    reasonSummary: '安装器模式 · 未验证目标程序',
    reasons: [
      {
        severity: 'warn',
        code: 'installer-mode',
        title: '实验性安装器模式',
        detail: '首次在 Mac 启动时会先运行安装程序。安装完成后启动器会尝试自动查找主程序，推荐填写“预期主程序名”。',
      },
      {
        severity: 'info',
        code: 'installer-interactive',
        title: '安装程序可能需要交互或网络',
        detail: '安装向导、服务注册、重启步骤在 Wine 中可能不可用；静默安装参数只在确认安装器类型后使用。',
      },
    ],
    dependencies: {
      vcrun: false, dotnetFramework: false, dotnetCore: false, webview2: false,
      directx: [], openGL: false, vulkan: false, input: false, audio: false,
      kernel: false, antiCheat: false, drm: false,
    },
    recommendedEngine: 'wine',
    engineReason: '安装器兼容性取决于安装后的目标程序；先用 Wine 尝试，失败时在 Mac 上复用 CrossOver/GPTK。',
    directory: { scannedFiles: 0, scannedBytes: 0, truncated: false, antiCheatHits: [], kernelDrivers: [], drmHits: [], warnings: [] },
    services: [],
    analyzedAt: new Date().toISOString(),
  };
}

function normalizeExpectedExe(value) {
  const raw = String(value || '').trim().replace(/^"|"$/g, '');
  if (!raw) return '';
  let base = raw.split(String.fromCharCode(92)).join('/').split('/').pop();
  if (!base.toLowerCase().endsWith('.exe')) base += '.exe';
  return base;
}

async function copyFileWithProgress(source, dest, { onBytes, onProgress } = {}) {
  await ensureDir(path.dirname(dest));
  const hash = crypto.createHash('sha256');
  let bytes = 0;
  const sourceStream = fs.createReadStream(source);
  sourceStream.on('data', (chunk) => {
    hash.update(chunk);
    bytes += chunk.length;
    if (onBytes) onBytes(chunk.length, bytes);
    if (onProgress) onProgress({ fileBytes: bytes });
  });
  await pipeline(sourceStream, fs.createWriteStream(dest));
  const st = await fsp.stat(source);
  await fsp.utimes(dest, st.atime, st.mtime);
  return { sha256: hash.digest('hex'), size: bytes, mtime: st.mtime };
}

async function copyPayloadTree({ installPath, payloadRoot, manifest, index, warnings, onProgress }) {
  emit(onProgress, 'enumerate', '正在枚举应用文件…');
  const walk = await walkFiles(installPath);
  if (walk.truncated) {
    throw new Error('应用文件超过 200,000 个，无法保证无损复制。请先清理缓存/日志目录，或选择更具体的安装目录。');
  }
  const totalBytes = walk.files.reduce((sum, file) => sum + file.size, 0);
  emit(onProgress, 'payload', `正在原样复制 ${walk.files.length} 个文件（${formatBytes(totalBytes)}）…`, {
    percent: 0,
    totalBytes,
  });
  const baseRel = payloadRelativeForWindowsPath(installPath);
  let copiedBytes = 0;
  let copiedFiles = 0;
  let failedFiles = 0;
  const failedPaths = [];
  let lastProgressAt = 0;

  for (const file of walk.files) {
    const relative = path.relative(installPath, file.path);
    const relativePosix = toPosix(relative || path.basename(file.path));
    const payloadRel = path.posix.join(baseRel, relativePosix);
    const dest = path.join(payloadRoot, ...payloadRel.split('/'));
    if (!isPathInside(dest, payloadRoot)) {
      warnings.push({ severity: 'warn', message: `跳过越界路径：${file.path}` });
      continue;
    }
    try {
      const copied = await copyFileWithProgress(file.path, dest, {
        onBytes: (delta) => {
          copiedBytes += delta;
          const now = Date.now();
          if (now - lastProgressAt >= 180) {
            lastProgressAt = now;
            emit(onProgress, 'payload', `正在复制：${relativePosix}`, {
              percent: clamp(Math.round((copiedBytes / Math.max(totalBytes, 1)) * 100), 0, 100),
              copiedBytes,
              totalBytes,
              copiedFiles,
              totalFiles: walk.files.length,
            });
          }
        },
      });
      manifest.push(`${copied.sha256}  ${toPosix(path.relative(payloadRoot, dest))}`);
      if (index) index.push(`${copied.sha256}\t${copied.size}\t${toPosix(path.relative(payloadRoot, dest))}`);
      copiedFiles += 1;
    } catch (error) {
      failedFiles += 1;
      failedPaths.push(relativePosix);
      warnings.push({ severity: 'warn', message: `复制失败：${file.path}（${error.message}）` });
    }
  }

  if (failedFiles > 0) {
    throw new Error(`有 ${failedFiles} 个文件复制失败（例如：${failedPaths.slice(0, 5).join('、')}）。请关闭占用这些文件的应用后重试。`);
  }

  for (const warning of walk.warnings) {
    warnings.push({ severity: 'warn', message: warning.message, path: warning.path });
  }
  return {
    baseRel,
    copiedBytes,
    copiedFiles,
    failedFiles,
    totalFiles: walk.files.length,
    truncated: walk.truncated,
  };
}

function registryKeyExists(key) {
  return new Promise((resolve) => {
    const child = spawn(REG_EXE, ['query', key], { windowsHide: true });
    child.on('error', () => resolve(false));
    child.on('close', (code) => resolve(code === 0));
  });
}

async function exportRegistryKeys(keys, registryDir, warnings, { skipMissing = false } = {}) {
  await ensureDir(registryDir);
  const files = [];
  for (const rawKey of keys) {
    const key = String(rawKey || '').trim();
    if (!key) continue;
    if (skipMissing && !(await registryKeyExists(key))) continue;
    const dest = path.join(registryDir, `${files.length + 1}.reg`);
    await new Promise((resolve) => {
      const child = spawn(REG_EXE, ['export', key, dest, '/y'], { windowsHide: true });
      let stderr = '';
      child.stderr.on('data', (chunk) => {
        stderr += chunk.toString('utf8');
      });
      child.on('error', (error) => {
        warnings.push({ severity: 'warn', message: `导出注册表失败：${key}（${error.message}）` });
        resolve(false);
      });
      child.on('close', (code) => {
        if (code === 0 && fs.existsSync(dest)) {
          files.push({ key, file: path.basename(dest) });
          resolve(true);
        } else {
          warnings.push({ severity: 'warn', message: `导出注册表失败：${key}${stderr ? `（${stderr.trim().slice(0, 200)}）` : ''}` });
          resolve(false);
        }
      });
    });
  }
  return files;
}

async function verifyMicrosoftSignature(file) {
  return new Promise((resolve) => {
    const child = spawn(POWERSHELL, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', VERIFY_SCRIPT, '-Path', file], {
      windowsHide: true,
      timeout: 30000,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', () => resolve({ valid: false, error: '无法启动 PowerShell 验签' }));
    child.on('close', (code) => {
      const [status, subject] = stdout.trim().split('|');
      const valid = code === 0 && status === 'Valid' && /Microsoft Corporation/i.test(subject || '');
      resolve({ valid, status, subject, error: valid ? null : stderr.trim() || `签名状态 ${status || '未知'}` });
    });
  });
}

async function downloadCached(url, fileName, { proxy, onProgress, label }) {
  const cacheDir = localDataDir('runtimes');
  await ensureDir(cacheDir);
  const dest = path.join(cacheDir, fileName);
  if (fs.existsSync(dest)) {
    const st = await fsp.stat(dest);
    if (st.size > 1024 * 1024) return { path: dest, cached: true, size: st.size };
    await fsp.rm(dest, { force: true });
  }
  emit(onProgress, 'runtime', `正在下载 ${label}…`, { percent: 0 });
  const result = await downloadFile(url, dest, {
    proxy,
    onProgress: (progress) => {
      emit(onProgress, 'runtime', `正在下载 ${label} ${progress.percent || 0}%`, { percent: progress.percent || 0 });
    },
  });
  return { path: dest, cached: false, size: result.size };
}

async function buildRuntimePlan({ analysis, options, runtimesDir, warnings, onProgress }) {
  await ensureDir(runtimesDir);
  const runtimes = [];
  if (options.includeRuntimes === false) return runtimes;

  const importList = analysis?.dependencies || {};
  if (importList.vcrun) {
    const arch = analysis?.pe?.arch;
    const targets = arch === 'x86' ? ['x86'] : arch === 'x64' ? ['x64'] : ['x64', 'x86'];
    for (const target of targets) {
      const def = VC_REDIST[target];
      try {
        const downloaded = await downloadCached(def.url, def.name, {
          proxy: options.proxy,
          onProgress,
          label: def.label,
        });
        const signature = await verifyMicrosoftSignature(downloaded.path);
        if (!signature.valid) {
          warnings.push({
            severity: 'warn',
            message: `${def.label} 未通过微软签名校验，已跳过：${signature.error || signature.status}`,
          });
          continue;
        }
        const dest = path.join(runtimesDir, def.name);
        await fsp.copyFile(downloaded.path, dest);
        runtimes.push({
          file: `runtimes/${def.name}`,
          kind: 'exe',
          args: '/install /quiet /norestart',
          label: def.label,
          sha256: await sha256File(dest),
        });
      } catch (error) {
        warnings.push({ severity: 'warn', message: `${def.label} 下载失败：${error.message}。应用可能仍可使用 Wine 内置运行库。` });
      }
    }
  }

  if (importList.dotnetFramework && options.includeWineMono !== false) {
    try {
      const downloaded = await downloadCached(WINE_MONO.url, WINE_MONO.name, {
        proxy: options.proxy,
        onProgress,
        label: WINE_MONO.label,
      });
      const dest = path.join(runtimesDir, WINE_MONO.name);
      await fsp.copyFile(downloaded.path, dest);
      runtimes.push({
        file: `runtimes/${WINE_MONO.name}`,
        kind: 'msi',
        args: '/qn /norestart',
        label: WINE_MONO.label,
        sha256: await sha256File(dest),
      });
    } catch (error) {
      warnings.push({
        severity: 'warn',
        message: `Wine Mono 下载失败：${error.message}。.NET Framework 应用可能无法启动，建议在 Mac 上使用 CrossOver 或 winetricks dotnet48。`,
      });
    }
  }
  return runtimes;
}

async function copyUserData({ app, win2macDir, warnings, onProgress, extraNames = [] }) {
  const roaming = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  const candidates = new Set(
    [app.name, path.win32.basename(app.exePath || '', '.exe'), app.publisher, ...extraNames]
      .map((value) => String(value || '').trim())
      .filter((value) => value.length >= 3 && !/^(microsoft|google|common|adobe)$/i.test(value)),
  );
  const found = [];
  for (const [kind, root] of [
    ['Roaming', roaming],
    ['Local', local],
  ]) {
    if (!fs.existsSync(root)) continue;
    const entries = await fsp.readdir(root, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const match = [...candidates].some((candidate) => nameSimilarity(entry.name, candidate) >= 0.8);
      if (!match) continue;
      const source = path.join(root, entry.name);
      if (isPathInside(source, app.installPath)) continue;
      found.push({ kind, name: entry.name, source });
    }
  }
  if (!found.length) {
    warnings.push({ severity: 'info', message: '未发现可选的用户数据目录（可忽略）。' });
    return [];
  }

  const entries = [];
  for (const item of found) {
    const targetRel = path.posix.join('userdata', item.kind, item.name);
    const dest = path.join(win2macDir, ...targetRel.split('/'));
    emit(onProgress, 'userdata', `正在复制用户数据：${item.kind}/${item.name}`);
    const walk = await walkFiles(item.source, { maxFiles: 100000 });
    if (walk.truncated) {
      warnings.push({ severity: 'warn', message: `用户数据 ${item.name} 超过 100,000 个文件，复制内容已截断。` });
    }
    let bytes = 0;
    for (const file of walk.files) {
      const rel = path.relative(item.source, file.path);
      const target = path.join(dest, rel);
      try {
        await copyFilePreserve(file.path, target);
        bytes += file.size;
      } catch (error) {
        warnings.push({ severity: 'warn', message: `复制用户数据失败：${file.path}（${error.message}）` });
      }
    }
    if (bytes > 2 * 1024 * 1024 * 1024) {
      warnings.push({ severity: 'warn', message: `用户数据 ${item.name} 超过 2GB，安装包会很大。` });
    }
    entries.push({
      source: targetRel,
      target: `${item.kind}/${item.name}`,
      files: walk.files.length,
      bytes,
    });
  }
  return entries;
}

async function copyLargeFileWithProgress(source, dest, { onProgress, label } = {}) {
  await ensureDir(path.dirname(dest));
  const st = await fsp.stat(source);
  let copied = 0;
  const sourceStream = fs.createReadStream(source);
  sourceStream.on('data', (chunk) => {
    copied += chunk.length;
    emit(onProgress, 'engine', `${label} ${formatBytes(copied)} / ${formatBytes(st.size)}`, {
      percent: clamp(Math.round((copied / Math.max(st.size, 1)) * 100), 0, 100),
    });
  });
  await pipeline(sourceStream, fs.createWriteStream(dest));
  return { size: st.size, sha256: await sha256File(dest) };
}

function renderReadme(data) {
  let html = fs.readFileSync(path.join(TEMPLATES, 'readme.html'), 'utf8');
  for (const [key, value] of Object.entries(data)) {
    html = html.split(`{{${key}}}`).join(value == null ? '' : String(value));
  }
  return html;
}

async function addDirectoryToZip(zip, absoluteDir, zipDir, stats) {
  const entries = await fsp.readdir(absoluteDir, { withFileTypes: true });
  zip.addEmptyDirectory(zipDir, { mode: 0o755 });
  for (const entry of entries) {
    const absolute = path.join(absoluteDir, entry.name);
    const zipPath = `${zipDir}/${entry.name}`;
    if (entry.isDirectory()) {
      await addDirectoryToZip(zip, absolute, zipPath, stats);
    } else if (entry.isFile()) {
      const st = await fsp.stat(absolute);
      const compress = !/\.(xz|zip|png|jpe?g|icns|gz|7z)$/i.test(entry.name);
      const executable = /(^|\/)(launcher|Open-Win2Mac-App\.command|Verify-Integrity\.command|Reset-Runtime\.command)$/.test(zipPath);
      zip.addFile(absolute, zipPath, {
        mode: executable ? 0o755 : 0o644,
        mtime: st.mtime,
        compress,
      });
      stats.files += 1;
      stats.bytes += st.size;
      if (stats.onFile) stats.onFile(zipPath);
    }
  }
}

async function writeZip({ rootDir, rootName, zipPath, onProgress, expectedFiles = 0 }) {
  await ensureDir(path.dirname(zipPath));
  const resolvedZip = path.resolve(zipPath);
  // 先枚举再创建目标文件：ZIP 若位于 rootDir 内，否则会把自己写进包里（yazl 尺寸校验会失败）。
  const topEntries = (await fsp.readdir(rootDir, { withFileTypes: true }))
    .filter((entry) => path.resolve(rootDir, entry.name) !== resolvedZip);
  const zip = new yazl.ZipFile();
  const stats = { files: 0, bytes: 0, onFile: null };
  stats.onFile = (file) => {
    const percent = expectedFiles ? Math.min(99, Math.round((stats.files / expectedFiles) * 100)) : undefined;
    emit(onProgress, 'zip', `正在压缩：${path.basename(file)}`, percent === undefined ? {} : { percent });
  };
  const output = fs.createWriteStream(zipPath);
  const finished = new Promise((resolve, reject) => {
    output.on('close', resolve);
    output.on('error', reject);
    zip.outputStream.on('error', reject);
  });
  zip.outputStream.pipe(output);

  const total = topEntries.length;
  let index = 0;
  for (const entry of topEntries) {
    const absolute = path.join(rootDir, entry.name);
    const target = `${rootName}/${entry.name}`;
    if (entry.isDirectory()) {
      await addDirectoryToZip(zip, absolute, target, stats);
    } else if (entry.isFile()) {
      const st = await fsp.stat(absolute);
      const executable = /\.command$/.test(entry.name);
      zip.addFile(absolute, target, { mode: executable ? 0o755 : 0o644, mtime: st.mtime });
      stats.files += 1;
      stats.bytes += st.size;
    }
    index += 1;
    emit(onProgress, 'zip', `正在打包 ${index}/${total} 个顶层条目…`);
  }
  zip.end({ forceZip64Format: true });
  await finished;
  return stats;
}

function buildConfigLines({ app, bundleId, buildId, payloadVersion, payloadInfo, args, installer, installerArgs, installerPayload, installerWin, engineInfo, runtimes, registryFiles, userData, advanced, dirs, electron, hostAdb }) {
  const lines = [];
  const put = (key, value) => lines.push(`${key}=${shellQuote(value == null ? '' : String(value))}`);
  put('WIN2MAC_FORMAT', '1');
  put('WIN2MAC_APP_NAME', app.name);
  put('WIN2MAC_APP_ID', buildId);
  put('WIN2MAC_BUNDLE_ID', bundleId);
  put('WIN2MAC_APP_VERSION', app.version || '1.0');
  put('WIN2MAC_PUBLISHER', app.publisher || '');
  put('WIN2MAC_PAYLOAD_VERSION', payloadVersion);
  put('WIN2MAC_EXE_PAYLOAD', dirs.exePayload);
  put('WIN2MAC_WORKDIR_PAYLOAD', dirs.workdirPayload);
  put('WIN2MAC_PAYLOAD_BYTES', payloadInfo.copiedBytes);
  put('WIN2MAC_INSTALLER_MODE', installer ? '1' : '0');
  put('WIN2MAC_INSTALLER_PAYLOAD', installerPayload || '');
  put('WIN2MAC_INSTALLER_WIN', installerWin || '');
  put('WIN2MAC_INSTALLER_TYPE', installer?.type || 'exe');
  put('WIN2MAC_EXPECTED_EXE', installer?.expectedExe || '');
  put('WIN2MAC_INSTALLER_ARG_COUNT', installerArgs.length);
  installerArgs.forEach((arg, index) => put(`WIN2MAC_INSTALLER_ARG_${index + 1}`, arg));
  put('WIN2MAC_EXTRA_DRIVES', dirs.extraDrives.join(','));
  put('WIN2MAC_ARG_COUNT', args.length);
  args.forEach((arg, index) => put(`WIN2MAC_ARG_${index + 1}`, arg));
  const electronFlags = electron?.isElectron ? advanced.electronFlags : [];
  put('WIN2MAC_ELECTRON', electron?.isElectron ? '1' : '0');
  put('WIN2MAC_ELECTRON_COMPAT', advanced.electronCompat ? '1' : '0');
  put('WIN2MAC_ELECTRON_NAME', electron?.packageName || '');
  put('WIN2MAC_ELECTRON_ARG_COUNT', electronFlags.length);
  electronFlags.forEach((arg, index) => put(`WIN2MAC_ELECTRON_ARG_${index + 1}`, arg));
  put('WIN2MAC_HOST_ADB_ARM', hostAdb?.arm64 || '');
  put('WIN2MAC_HOST_ADB_X86', hostAdb?.x86_64 || '');
  put('WIN2MAC_REGISTRY_COUNT', registryFiles.length);
  registryFiles.forEach((item, index) => put(`WIN2MAC_REGISTRY_${index + 1}`, `registry/${item.file}`));
  put('WIN2MAC_RUNTIME_COUNT', runtimes.length);
  runtimes.forEach((item, index) => {
    put(`WIN2MAC_RUNTIME_${index + 1}_FILE`, item.file);
    put(`WIN2MAC_RUNTIME_${index + 1}_KIND`, item.kind);
    put(`WIN2MAC_RUNTIME_${index + 1}_ARGS`, item.args);
    put(`WIN2MAC_RUNTIME_${index + 1}_LABEL`, item.label);
  });
  put('WIN2MAC_RUNTIME_VERSION', runtimes.map((item) => `${item.kind}:${item.file}:${item.sha256}`).join('|') || 'none');
  put('WIN2MAC_USERDATA_COUNT', userData.length);
  userData.forEach((item, index) => {
    put(`WIN2MAC_USERDATA_${index + 1}_SOURCE`, item.source);
    put(`WIN2MAC_USERDATA_${index + 1}_TARGET`, item.target);
  });
  put('WIN2MAC_DLL_OVERRIDES', 'mshtml=');
  put('WIN2MAC_WINEDEBUG', advanced.wineDebug === 'all' ? '+all' : advanced.wineDebug === 'warn' ? 'warn' : '-all');
  put('WIN2MAC_ENV_COUNT', advanced.env.length);
  advanced.env.forEach((item, index) => {
    put(`WIN2MAC_ENV_${index + 1}_NAME`, item.name);
    put(`WIN2MAC_ENV_${index + 1}_VALUE`, item.value);
  });
  put('WIN2MAC_VERIFY_ON_LAUNCH', advanced.verifyIntegrity ? '1' : '0');
  put('WIN2MAC_PREVENT_SLEEP', advanced.preventSleep ? '1' : '0');
  put('WIN2MAC_WINEARCH', 'win64');
  put('WIN2MAC_ENGINE_POLICY', engineInfo.policy);
  put('WIN2MAC_ENGINE_ORDER', engineInfo.order);
  put('WIN2MAC_ENGINE_ARCHIVE', engineInfo.archiveRel || '');
  put('WIN2MAC_ENGINE_URL', engineInfo.url || '');
  put('WIN2MAC_ENGINE_SHA256', engineInfo.sha256 || '');
  put('WIN2MAC_ENGINE_VERSION', engineInfo.version || 'Wine');
  put('WIN2MAC_PROXY', '');
  return lines;
}

async function buildBundle(input, onProgress) {
  const options = {
    outputDir: input.outputDir,
    engineMode: input.engineMode || 'auto',
    includeUserData: Boolean(input.includeUserData),
    includeRuntimes: input.includeRuntimes !== false,
    includeWineMono: input.includeWineMono !== false,
    proxy: input.proxy || '',
    manualEngineArchive: input.manualEngineArchive || '',
    minMacOS: input.minMacOS || '11.0',
    advanced: normalizeAdvanced(input.advanced),
  };
  if (process.platform !== 'win32') throw new Error('打包器目前只能在 Windows 上运行');
  if (!options.outputDir) throw new Error('缺少输出目录');
  const app = input.app;
  if (!app?.name) throw new Error('缺少应用名称');
  let installer = null;
  if (input.installer) {
    const installerPath = path.resolve(String(input.installer.path || ''));
    let stat;
    try {
      stat = await fsp.stat(installerPath);
    } catch {
      throw new Error('安装包文件不存在或无法访问');
    }
    if (!stat.isFile()) throw new Error('安装包路径不是文件');
    const ext = path.extname(installerPath).toLowerCase();
    if (ext !== '.exe' && ext !== '.msi') throw new Error('安装包仅支持 .exe 或 .msi');
    installer = {
      path: installerPath,
      type: ext === '.msi' ? 'msi' : 'exe',
      args: String(input.installer.args || ''),
      expectedExe: normalizeExpectedExe(input.installer.expectedExe),
      size: stat.size,
      name: path.basename(installerPath),
    };
    app.source = 'installer';
    if (!app.installPath) app.installPath = path.dirname(installerPath);
    if (!app.estimatedSizeBytes) app.estimatedSizeBytes = stat.size;
  } else {
    if (!app.installPath || !(await pathExists(app.installPath))) throw new Error('应用安装目录不存在');
    const installRoot = path.win32.parse(app.installPath).root;
    const isLocalDrivePath = installRoot.length >= 2 && /^[a-zA-Z]$/.test(installRoot[0]) && installRoot[1] === ':';
    if (!isLocalDrivePath) {
      throw new Error('暂不支持网络路径/UNC 安装目录。请先把应用复制到本地磁盘再打包。');
    }
    if (!app.exePath || !(await pathExists(app.exePath))) throw new Error('未找到可启动的 .exe');
    if (!isPathInside(app.exePath, app.installPath)) {
      throw new Error('主程序不在安装目录内。请重新扫描，或选择包含主程序的应用目录。');
    }
    if (installRoot[0].toUpperCase() === 'Z') {
      throw new Error('暂不支持安装在 Z: 盘的应用：Z: 与 Wine 的 macOS 根目录映射冲突。');
    }
    const installRootKey = normalizeForCompare(app.installPath);
    if (UNSUPPORTED_ROOTS.has(installRootKey)) {
      throw new Error('安装目录范围过大（磁盘根目录或系统目录），请手动选择具体的应用文件夹。');
    }
    if (isPathInside(options.outputDir, app.installPath)) {
      throw new Error('输出目录不能位于应用安装目录内，请换一个输出位置。');
    }
  }

  const outputDir = path.resolve(options.outputDir);
  await ensureDir(outputDir);
  const warnings = [];
  const bundleId = bundleIdentifier(app.name, app.publisher, installer ? installer.path : app.installPath);
  const buildId = crypto.createHash('sha1').update(bundleId).digest('hex').slice(0, 16);
  const buildNonce = crypto.createHash('sha1').update(`${Date.now()}|${Math.random()}`).digest('hex').slice(0, 10);
  const safeName = sanitizeFilename(app.name, 'WindowsApp').slice(0, 60);
  let baseName = `${safeName}-macOS`;
  let suffix = 2;
  while (fs.existsSync(path.join(outputDir, baseName)) || fs.existsSync(path.join(outputDir, `${baseName}.zip`))) {
    baseName = `${safeName}-macOS-${suffix}`;
    suffix += 1;
  }
  const bundleName = `${safeName}.app`;
  const rootDir = path.join(outputDir, baseName);
  const stagingRoot = path.join(outputDir, `.win2mac-build-${buildId}-${buildNonce}`);
  const appDir = path.join(stagingRoot, bundleName);
  const contentsDir = path.join(appDir, 'Contents');
  const macosDir = path.join(contentsDir, 'MacOS');
  const resourcesDir = path.join(contentsDir, 'Resources');
  const win2macDir = path.join(resourcesDir, 'win2mac');
  const payloadRoot = path.join(win2macDir, 'payload');
  const registryDir = path.join(win2macDir, 'registry');
  const runtimesDir = path.join(win2macDir, 'runtimes');
  const engineDir = path.join(win2macDir, 'engine');
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'win2mac-build-'));

  try {
    emit(onProgress, 'analyze', installer ? '正在准备安装器项目…' : '正在分析兼容性与运行时依赖…');
    const analysis = input.analysis || (installer ? defaultInstallerAnalysis(app.name) : await analyzeApp(app, { services: input.services || [] }));

    await ensureDir(macosDir);
    await ensureDir(resourcesDir);
    await ensureDir(win2macDir);
    await ensureDir(payloadRoot);
    await ensureDir(registryDir);
    await ensureDir(runtimesDir);

    const manifest = [];
    const payloadIndex = [];
    let payloadInfo;
    let exePayload = '';
    let workdirPayload = '';
    let extraDrives = [];
    let installerPayload = '';
    let installerWin = '';

    if (installer) {
      let installerFileName = sanitizeFilename(installer.name, `setup.${installer.type}`);
      if (!installerFileName.toLowerCase().endsWith(`.${installer.type}`)) installerFileName += `.${installer.type}`;
      installerPayload = path.posix.join('C', 'win2mac-installer', installerFileName);
      const installerDest = path.join(payloadRoot, ...installerPayload.split('/'));
      let copiedBytes = 0;
      const copied = await copyFileWithProgress(installer.path, installerDest, {
        onBytes: (delta) => {
          copiedBytes += delta;
          emit(onProgress, 'payload', `正在复制安装包：${installerFileName}`, {
            percent: Math.min(99, Math.round((copiedBytes / Math.max(installer.size, 1)) * 100)),
          });
        },
      });
      manifest.push(`${copied.sha256}  ${installerPayload}`);
      payloadInfo = { baseRel: 'C', copiedBytes: copied.size, copiedFiles: 1, failedFiles: 0, totalFiles: 1 };
      installerWin = `C:\\win2mac-installer\\${installerFileName}`;
    } else {
      if (app.externalWorkingDirectory) {
        warnings.push({
          severity: 'warn',
          message: `原应用工作目录 ${app.externalWorkingDirectory} 不在安装目录内，未随载荷复制；启动器会改用主程序所在目录。`,
        });
      }
      payloadInfo = await copyPayloadTree({ installPath: app.installPath, payloadRoot, manifest, index: payloadIndex, warnings, onProgress });
      if (payloadInfo.copiedFiles === 0) throw new Error('没有复制到任何应用文件，请检查安装目录权限。');

      const exeRel = path.relative(app.installPath, app.exePath);
      exePayload = path.posix.join(payloadInfo.baseRel, toPosix(exeRel));
      const exeDest = path.join(payloadRoot, ...exePayload.split('/'));
      if (!fs.existsSync(exeDest)) {
        throw new Error('主程序未能复制到安装包中，可能文件被占用或权限不足。');
      }
      const workdirWindows = app.workingDirectory && isPathInside(app.workingDirectory, app.installPath)
        ? app.workingDirectory
        : path.win32.dirname(app.exePath);
      const workdirRel = path.relative(app.installPath, workdirWindows);
      workdirPayload = workdirRel && workdirRel !== '.' && !workdirRel.startsWith('..')
        ? path.posix.join(payloadInfo.baseRel, toPosix(workdirRel))
        : path.posix.dirname(exePayload);
      extraDrives = [...new Set(manifest.map((line) => line.split('  ')[1]?.split('/')[0]).filter((drive) => drive && /^[A-Z]$/.test(drive) && drive !== 'C'))];
    }

    manifest.sort((a, b) => a.localeCompare(b));
    const manifestText = `${manifest.join('\n')}\n`;
    await fsp.writeFile(path.join(win2macDir, 'manifest.sha256'), manifestText, 'utf8');
    payloadIndex.sort((a, b) => (a.split('\t')[2] || '').localeCompare(b.split('\t')[2] || ''));
    if (payloadIndex.length) {
      const indexLines = ['sha256\tbytes\tpath', ...payloadIndex];
      await fsp.writeFile(path.join(win2macDir, 'payload-index.tsv'), `${indexLines.join('\n')}\n`, 'utf8');
      const indexJson = {
        format: 1,
        generatedAt: new Date().toISOString(),
        files: payloadIndex.map((line) => {
          const [sha256, bytes, filePath] = line.split('\t');
          return { path: filePath, bytes: Number(bytes), sha256 };
        }),
      };
      await fsp.writeFile(path.join(win2macDir, 'payload-index.json'), `${JSON.stringify(indexJson, null, 2)}\n`, 'utf8');
    }
    const payloadVersion = `${crypto.createHash('sha1').update(manifestText).digest('hex').slice(0, 12)}-${Date.now().toString(36)}`;

    let electronInfo = { isElectron: false };
    let hostAdb = { arm64: '', x86_64: '' };
    if (!installer) {
      electronInfo = await detectElectronApp(app.installPath);
      if (electronInfo.isElectron) {
        const label = electronInfo.productName || electronInfo.packageName;
        warnings.push({
          severity: 'info',
          message: `检测到 Electron 应用${label ? `（${label}）` : ''}：启动时自动加入 ${options.advanced.electronFlags.join(' ') || '无额外参数'}。`,
        });
        if (electronInfo.nativeModuleCount) {
          if (analysis.dependencies) analysis.dependencies.vcrun = true;
          warnings.push({
            severity: 'info',
            message: `检测到 ${electronInfo.nativeModuleCount} 个原生模块（.node）：已加入 VC++ 运行库，避免 better-sqlite3 等模块在 Wine 中加载失败。`,
          });
        }
      }
      const hostAdbRaw = await findHostAdb(app.installPath);
      if (hostAdbRaw.arm64 || hostAdbRaw.x86_64) {
        const installPayload = toPosix(payloadRelativeForWindowsPath(app.installPath)).replace(/\/+$/, '');
        const toPayload = (rel) => (rel ? `${installPayload}/${rel}` : '');
        hostAdb = {
          arm64: toPayload(hostAdbRaw.arm64),
          x86_64: toPayload(hostAdbRaw.x86_64),
        };
        warnings.push({
          severity: 'info',
          message: '检测到 macOS 版 adb：启动时会尝试在本机启动 ADB 服务，并让 Wine 内的 adb/scrcpy 通过 localhost 连接。该桥接为实验性功能。',
        });
      }
    }

    let registryFiles = [];
    if (!installer) {
      emit(onProgress, 'registry', '正在导出注册表快照（用于保持应用配置）…');
      const registryCandidates = generateRegistryKeys({ app, electron: electronInfo });
      registryFiles = await exportRegistryKeys(registryCandidates, registryDir, warnings, { skipMissing: true });
      if (registryFiles.length > (app.registryKeys || []).length) {
        warnings.push({
          severity: 'info',
          message: `已额外捕获 ${registryFiles.length - (app.registryKeys || []).length} 个应用相关注册表键；其中可能含许可证或账号信息，请只在可信设备间传递安装包。`,
        });
      }
    }

    let userData = [];
    if (!installer && options.includeUserData) {
      emit(onProgress, 'userdata', '正在包含用户数据（可选）…');
      userData = await copyUserData({
        app,
        win2macDir,
        warnings,
        onProgress,
        extraNames: [electronInfo.packageName, electronInfo.productName].filter(Boolean),
      });
    }

    emit(onProgress, 'runtime', '正在准备运行时组件…');
    const runtimes = await buildRuntimePlan({ analysis, options, runtimesDir, warnings, onProgress });

    emit(onProgress, 'engine', '正在准备 Wine 引擎配置…');
    let engineResolution = null;
    let engineMeta = null;
    try {
      engineResolution = await resolveEngine({
        mode: options.engineMode,
        proxy: options.proxy,
        manualArchive: options.manualEngineArchive,
        onProgress,
      });
      engineMeta = engineResolution.meta;
    } catch (error) {
      if (options.engineMode === 'bundled') throw error;
      warnings.push({
        severity: 'warn',
        message: `无法预取 Wine 引擎信息：${error.message}。应用首次运行时将尝试在线获取。`,
      });
    }
    let engineArchiveRel = '';
    let engineSha = engineMeta?.sha256 || '';
    let engineUrl = engineMeta?.url || '';
    let engineVersion = prettyEngineName(engineMeta);
    const shouldBundleEngine = options.engineMode === 'bundled' || Boolean(options.manualEngineArchive && engineResolution?.archivePath);
    if (shouldBundleEngine) {
      if (!engineResolution?.archivePath) throw new Error('内置引擎模式缺少引擎压缩包');
      await ensureDir(engineDir);
      const engineFileName = sanitizeFilename(path.basename(engineResolution.archivePath), 'wine.tar.xz');
      const dest = path.join(engineDir, engineFileName);
      const copied = await copyLargeFileWithProgress(engineResolution.archivePath, dest, {
        onProgress,
        label: '正在写入内置引擎：',
      });
      engineArchiveRel = `engine/${engineFileName}`;
      engineSha = copied.sha256;
      engineVersion = prettyEngineName(engineMeta);
      warnings.push({ severity: 'info', message: `已内置 ${engineVersion}，离线可用。安装包约增加 ${formatBytes(copied.size)}。` });
    }
    if (options.engineMode === 'reuse') {
      engineUrl = '';
      engineSha = '';
    }
    const engineInfo = {
      policy: shouldBundleEngine ? 'bundled' : options.engineMode === 'reuse' ? 'reuse' : 'auto',
      order: analysis.gameLikely ? 'gptk,crossover,whisky,wine' : 'crossover,gptk,whisky,wine',
      archiveRel: engineArchiveRel,
      url: engineUrl,
      sha256: engineSha,
      version: engineVersion,
      meta: engineMeta || null,
    };

    emit(onProgress, 'icon', '正在生成 macOS 应用图标…');
    let iconSource = null;
    let iconFile = path.join(resourcesDir, 'icon.icns');
    try {
      const icon = await buildAppIcon({ exe: installer ? installer.path : app.exePath, name: app.name, workDir: tempDir });
      await fsp.writeFile(iconFile, icon.icns);
      iconSource = icon.source;
      if (icon.bySize?.[512]) await fsp.writeFile(path.join(resourcesDir, 'icon-512.png'), icon.bySize[512]);
    } catch (error) {
      warnings.push({ severity: 'warn', message: `图标提取失败，使用默认图标：${error.message}` });
      const fallback = path.join(RESOURCES, 'fallback.icns');
      if (fs.existsSync(fallback)) {
        await fsp.copyFile(fallback, iconFile);
      } else {
        throw new Error('图标生成失败，且缺少默认图标资源');
      }
    }

    const args = parseCommandLine(options.advanced.launchArgs.trim() || app.launchArgs || app.shortcut?.arguments || '');
    const installerArgs = installer ? parseCommandLine(installer.args) : [];
    const configLines = buildConfigLines({
      app,
      bundleId,
      buildId,
      payloadVersion,
      payloadInfo,
      args,
      installer,
      installerArgs,
      installerPayload,
      installerWin,
      engineInfo,
      runtimes,
      registryFiles,
      userData,
      advanced: options.advanced,
      dirs: { exePayload, workdirPayload, extraDrives },
      electron: electronInfo,
      hostAdb,
    });
    const configText = `${configLines.join('\n')}\n`;
    await fsp.writeFile(path.join(win2macDir, 'config.env'), configText, 'utf8');

    const infoPlist = buildInfoPlist({
      name: safeName,
      displayName: app.name,
      identifier: bundleId,
      version: app.version || '1.0',
      iconFile: 'icon',
      minimumSystemVersion: options.minMacOS,
      copyright: `Packaged by Win2Mac Studio ${PKG.version}. Windows application © its publisher.`,
    });
    await fsp.writeFile(path.join(contentsDir, 'Info.plist'), infoPlist, 'utf8');
    await fsp.writeFile(path.join(contentsDir, 'PkgInfo'), 'APPL????', 'utf8');
    const launcherDest = path.join(macosDir, 'launcher');
    await fsp.copyFile(path.join(TEMPLATES, 'launcher.sh'), launcherDest);
    await fsp.chmod(launcherDest, 0o755);

    const createdAt = new Date();
    const prefixPath = `~/Library/Application Support/Win2Mac/prefixes/${buildId}`;
    const reasonsHtml = (analysis.reasons || [])
      .map((reason) => {
        const cls = reason.severity === 'block' ? 'block' : reason.severity === 'warn' ? 'warn' : '';
        return `<div class="reason ${cls}"><b>${xmlEscape(reason.title)}</b><p>${xmlEscape(reason.detail)}</p></div>`;
      })
      .join('');
    const runtimeLabels = runtimes.length ? runtimes.map((item) => xmlEscape(item.label)).join('、') : '无（使用 Wine 内置运行库）';
    const warningsBlock = warnings.length
      ? `<section><h2>打包警告（${warnings.length}）</h2><div class="warn"><ul>${warnings.map((warning) => `<li>${xmlEscape(warning.message)}</li>`).join('')}</ul></div></section>`
      : '';
    const installerBlock = installer
      ? `<section><h2>安装器模式（实验性）</h2><p>这是一个 Windows 安装程序，不是已经安装好的应用目录。首次在 Mac 启动时，启动器会先在 Wine 中运行安装程序，然后自动查找主程序并启动。</p><div class="warn"><ul><li>安装包：<code>${xmlEscape(installer.name)}</code>（${installer.type === 'msi' ? 'MSI' : 'EXE'}）</li><li>安装参数：<code>${xmlEscape(installer.args || '交互式（无参数）')}</code></li><li>预期主程序：<code>${xmlEscape(installer.expectedExe || '自动发现（启发式）')}</code></li></ul></div><p>建议在 macOS 上完成安装向导后等待自动启动。如果提示找不到主程序，请重置运行环境，并在打包时填写准确的“预期主程序名”。</p></section>`
      : '';
    const engineNote = [
      `推荐引擎：${analysis.recommendedEngine === 'gptk' ? 'Apple GPTK / CrossOver' : analysis.recommendedEngine === 'vm' ? '虚拟机（Wine 不适合）' : 'Wine'}。`,
      analysis.engineReason || '',
      engineMeta ? `当前打包引用：${engineVersion}。` : '',
      options.engineMode === 'reuse' ? '此安装包被设置为只复用 Mac 已安装的引擎，不会自动下载。' : '',
    ].filter(Boolean).join(' ');
    const readme = renderReadme({
      APP_NAME: xmlEscape(app.name),
      APP_VERSION: xmlEscape(app.version || (installer ? '安装器模式' : '未知')),
      PUBLISHER: xmlEscape(app.publisher || '未知发布者'),
      APP_ID: xmlEscape(buildId),
      BUNDLE_ID: xmlEscape(bundleId),
      BUILD_DATE: createdAt.toLocaleString('zh-CN', { hour12: false }),
      FILE_COUNT: String(payloadInfo.copiedFiles),
      PAYLOAD_SIZE: formatBytes(payloadInfo.copiedBytes),
      GRADE: analysis.grade,
      GRADE_LABEL: xmlEscape(analysis.gradeLabel),
      GRADE_SUMMARY: xmlEscape(analysis.gradeSummary),
      REASONS: reasonsHtml || '<div class="reason"><b>没有发现明显兼容性阻断项</b><p>仍建议在目标 Mac 上做一次启动与核心功能验证。</p></div>',
      ENGINE: xmlEscape(`${engineInfo.version} · ${engineInfo.policy}`),
      ENGINE_NOTE: xmlEscape(engineNote),
      MANIFEST_LINE: `${payloadInfo.copiedFiles} 个文件 · ${formatBytes(payloadInfo.copiedBytes)} · 逐文件 SHA-256`,
      REGISTRY_COUNT: String(registryFiles.length),
      RUNTIME_LIST: runtimeLabels,
      PREFIX_PATH: xmlEscape(prefixPath),
      SOURCE_PATH: xmlEscape(installer ? installer.path : app.installPath),
      APP_PATH: xmlEscape(bundleName),
      INSTALLER_BLOCK: installerBlock,
      PACKAGER_VERSION: PKG.version,
      WARNINGS: warnings.map((warning) => xmlEscape(warning.message)).join('；'),
      WARNINGS_BLOCK: warningsBlock,
    });
    const readmePath = path.join(stagingRoot, 'README-使用说明.html');
    await fsp.writeFile(readmePath, readme, 'utf8');
    for (const [template, name, mode] of [
      ['open-me.command', 'Open-Win2Mac-App.command', 0o755],
      ['verify-integrity.command', 'Verify-Integrity.command', 0o755],
      ['reset-runtime.command', 'Reset-Runtime.command', 0o755],
      ['mac-check.command', 'Start-Mac-Validation.command', 0o755],
    ]) {
      const dest = path.join(stagingRoot, name);
      await fsp.copyFile(path.join(TEMPLATES, template), dest);
      await fsp.chmod(dest, mode);
    }

    const bundleJson = {
      format: 1,
      generator: { name: 'Win2Mac Studio', version: PKG.version },
      createdAt: createdAt.toISOString(),
      mode: installer ? 'installer' : 'app',
      installer: installer ? { name: installer.name, type: installer.type, args: installer.args, expectedExe: installer.expectedExe, size: installer.size } : null,
      app: {
        name: app.name,
        publisher: app.publisher,
        version: app.version,
        sourcePath: installer ? installer.path : app.installPath,
        exePath: installer ? null : app.exePath,
        source: app.source,
      },
      bundleId,
      buildId,
      compatibility: {
        grade: analysis.grade,
        label: analysis.gradeLabel,
        score: analysis.score,
        summary: analysis.gradeSummary,
        recommendedEngine: analysis.recommendedEngine,
        reasons: analysis.reasons,
        dependencies: analysis.dependencies,
        pe: analysis.pe ? { arch: analysis.pe.arch, bits: analysis.pe.bits, subsystem: analysis.pe.subsystem, isDotNet: analysis.pe.isDotNet } : null,
      },
      payload: {
        files: payloadInfo.copiedFiles,
        bytes: payloadInfo.copiedBytes,
        failedFiles: payloadInfo.failedFiles,
        manifestVersion: payloadVersion,
        exePayload,
        workdirPayload,
        extraDrives,
        installerPayload,
        installerWin,
        indexFile: payloadIndex.length ? 'payload-index.tsv' : '',
      },
      engine: engineInfo,
      registry: registryFiles,
      runtimes,
      userData,
      electron: electronInfo.isElectron
        ? {
            detected: true,
            packageName: electronInfo.packageName,
            productName: electronInfo.productName,
            appId: electronInfo.appId,
            version: electronInfo.version,
            asarPath: electronInfo.asarPath ? toPosix(path.relative(app.installPath, electronInfo.asarPath)) : '',
            nativeModules: electronInfo.nativeModuleCount || 0,
            flags: options.advanced.electronFlags,
          }
        : { detected: false },
      hostAdb: hostAdb.arm64 || hostAdb.x86_64 ? hostAdb : null,
      advanced: options.advanced,
      icon: { source: iconSource },
      warnings,
      paths: { prefix: prefixPath, logs: `~/Library/Logs/Win2Mac/${buildId}.log` },
    };
    await writeJson(path.join(win2macDir, 'bundle.json'), bundleJson);

    emit(onProgress, 'zip', '正在生成 macOS 安装包 ZIP…');
    const zipPath = path.join(outputDir, `${baseName}.zip`);
    const zipPart = `${zipPath}.part`;
    await writeZip({ rootDir: stagingRoot, rootName: baseName, zipPath: zipPart, onProgress, expectedFiles: payloadInfo.copiedFiles + 13 });
    await fsp.rename(zipPart, zipPath);
    const zipSha256 = await sha256File(zipPath);
    await fsp.writeFile(`${zipPath}.sha256`, `${zipSha256}  ${path.basename(zipPath)}\n`, 'utf8');
    const zipStat = await fsp.stat(zipPath);

    await fsp.rename(stagingRoot, rootDir);
    const appPath = path.join(rootDir, bundleName);
    emit(onProgress, 'done', '打包完成', { percent: 100 });
    return {
      ok: true,
      mode: installer ? 'installer' : 'app',
      installer: installer ? { name: installer.name, type: installer.type, expectedExe: installer.expectedExe } : null,
      baseName,
      outputDir,
      folderPath: rootDir,
      appPath,
      zipPath,
      zipSha256,
      zipSize: zipStat.size,
      bundleId,
      buildId,
      fileCount: payloadInfo.copiedFiles,
      payloadBytes: payloadInfo.copiedBytes,
      grade: analysis.grade,
      engine: {
        mode: options.engineMode,
        policy: engineInfo.policy,
        version: engineVersion,
        archiveRel: engineArchiveRel,
        url: engineUrl,
        sha256: engineSha,
        meta: engineMeta,
      },
      runtimes: runtimes.map(({ file, label, kind }) => ({ file, label, kind })),
      registryCount: registryFiles.length,
      electron: electronInfo.isElectron
        ? { detected: true, packageName: electronInfo.packageName, flags: options.advanced.electronFlags, nativeModules: electronInfo.nativeModuleCount || 0 }
        : { detected: false },
      hostAdb: hostAdb.arm64 || hostAdb.x86_64 ? hostAdb : null,
      warnings,
      createdAt: createdAt.toISOString(),
      iconSource,
      advanced: options.advanced,
      prefixPath,
    };
  } catch (error) {
    await safeRemove(stagingRoot).catch(() => {});
    await safeRemove(`${path.join(outputDir, `${baseName}.zip`)}.part`).catch(() => {});
    throw error;
  } finally {
    await safeRemove(tempDir).catch(() => {});
  }
}

module.exports = {
  buildBundle,
  parseCommandLine,
  normalizeAdvanced,
  defaultInstallerAnalysis,
  normalizeExpectedExe,
  copyPayloadTree,
  exportRegistryKeys,
  buildRuntimePlan,
  prettyEngineName,
  sha256File,
  writeZip,
  renderReadme,
};
