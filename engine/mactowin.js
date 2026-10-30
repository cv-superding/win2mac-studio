'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { downloadFile } = require('./download');
const { extractZip } = require('./archive');
const { ensureDir, isPathInside, safeRemove, sanitizeFilename, sha256File, formatBytes } = require('./util');
const { writeZip } = require('./packager');

const ELECTRON_RELEASE = 'https://github.com/electron/electron/releases/download';
const RUNTIME_FLAVOR = 'win32-x64';

function electronCacheRoot() {
  const base = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  return path.join(base, 'Win2Mac', 'electron-win');
}

function hasElectronExe(dir) {
  try {
    return fs.statSync(path.join(dir, 'electron.exe')).isFile();
  } catch {
    return false;
  }
}

function normalizeElectronVersion(value) {
  const version = String(value || '').trim().replace(/^v/i, '');
  return /^\d+\.\d+\.\d+$/.test(version) ? version : '';
}

async function readShasum(text, fileName) {
  for (const line of String(text).split(/\r?\n/)) {
    const match = line.trim().match(/^([a-f0-9]{64})\s+\*?(.+)$/i);
    if (match && match[2].trim() === fileName) return match[1].toLowerCase();
  }
  return '';
}

async function resolveElectronRuntime({ version, proxy = '', onProgress, manualZip = '' } = {}) {
  const emit = (stage, message, extra = {}) => {
    if (onProgress) onProgress({ stage, message, ...extra });
  };
  await ensureDir(electronCacheRoot());
  if (manualZip) {
    const st = await fsp.stat(manualZip).catch(() => null);
    if (!st || !st.isFile()) throw new Error('指定的 Electron Windows 压缩包不存在');
    const key = `manual-${(await sha256File(manualZip)).slice(0, 12)}`;
    const target = path.join(electronCacheRoot(), key);
    if (hasElectronExe(target)) return { dir: target, version: 'manual', reused: true };
    emit('runtime', '正在解压本地 Electron Windows 运行时…');
    const tmp = `${target}.tmp`;
    await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {});
    try {
      await extractZip(manualZip, tmp);
      if (!hasElectronExe(tmp)) throw new Error('该压缩包不是 electron-vX-win32-x64.zip（缺少 electron.exe）');
      // 旧缓存目录可能只残留了部分文件；先清掉，否则 Windows 上 rename 会失败，用户永远无法恢复。
      await fsp.rm(target, { recursive: true, force: true }).catch(() => {});
      await fsp.rename(tmp, target);
    } catch (error) {
      // 校验失败时不要留下 .tmp，否则缓存目录会累积无法复用的半成品。
      await safeRemove(tmp).catch(() => {});
      throw error;
    }
    return { dir: target, version: 'manual', reused: false };
  }

  const normalized = normalizeElectronVersion(version);
  if (!normalized) {
    throw new Error('无法识别原应用的 Electron 版本，请在高级选项里手动选择 Electron Windows 运行时压缩包');
  }
  const target = path.join(electronCacheRoot(), `v${normalized}-${RUNTIME_FLAVOR}`);
  if (hasElectronExe(target)) {
    emit('runtime', `复用 Electron ${normalized} Windows 运行时`);
    return { dir: target, version: normalized, reused: true };
  }
  const fileName = `electron-v${normalized}-${RUNTIME_FLAVOR}.zip`;
  const url = `${ELECTRON_RELEASE}/v${normalized}/${fileName}`;
  const shasumsUrl = `${ELECTRON_RELEASE}/v${normalized}/SHASUMS256.txt`;
  const downloads = path.join(electronCacheRoot(), 'downloads');
  await ensureDir(downloads);
  const zipPath = path.join(downloads, fileName);
  const shasumsPath = path.join(downloads, `SHASUMS256-v${normalized}.txt`);

  emit('runtime', `正在获取 Electron ${normalized} 校验清单…`);
  if (!fs.existsSync(shasumsPath)) {
    await downloadFile(shasumsUrl, shasumsPath, { proxy });
  }
  const expected = await readShasum(await fsp.readFile(shasumsPath, 'utf8'), fileName);
  if (!expected) throw new Error(`Electron ${normalized} 的 SHASUMS256.txt 中没有 ${fileName}`);
  if (fs.existsSync(zipPath) && (await sha256File(zipPath)) !== expected) {
    await fsp.rm(zipPath, { force: true });
  }
  if (!fs.existsSync(zipPath)) {
    emit('runtime', `正在下载 Electron ${normalized} Windows 运行时…`);
    await downloadFile(url, zipPath, {
      proxy,
      expectedSha256: expected,
      onProgress: (progress) => {
        emit('runtime', `Electron 运行时 ${progress.percent || 0}%（${formatBytes(progress.received)} / ${formatBytes(progress.total)}）`, {
          percent: progress.percent || 0,
        });
      },
    });
  }
  emit('runtime', '正在解压 Electron Windows 运行时…');
  const tmp = `${target}.tmp`;
  await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {});
  try {
    await extractZip(zipPath, tmp);
    const nested = path.join(tmp, `electron-v${normalized}-${RUNTIME_FLAVOR}`);
    const root = hasElectronExe(tmp) ? tmp : nested;
    if (!hasElectronExe(root)) throw new Error('Electron 运行时解压后缺少 electron.exe');
    await fsp.rm(target, { recursive: true, force: true }).catch(() => {});
    await fsp.rename(root, target);
    if (root !== tmp) await safeRemove(tmp).catch(() => {});
  } catch (error) {
    await safeRemove(tmp).catch(() => {});
    throw error;
  }
  emit('runtime', `Electron ${normalized} 运行时就绪`);
  return { dir: target, version: normalized, reused: false };
}

// 重组时只允许复制源 .app 内部的文件：渲染层/构建记录里的 analysis 字段不能指向任意路径。
async function resolvePayloadSource(analysis, target, label) {
  const rawBundle = String(analysis?.path || '');
  if (!rawBundle || !path.isAbsolute(rawBundle)) throw new Error('源 .app 路径无效，无法重组');
  const bundle = path.resolve(rawBundle);
  const resolved = path.resolve(String(target || ''));
  let bundleReal;
  let targetReal;
  try {
    [bundleReal, targetReal] = await Promise.all([fsp.realpath(bundle), fsp.realpath(resolved)]);
  } catch {
    throw new Error(`${label} 不存在或无法访问`);
  }
  // 词法路径可能通过符号链接指向包外，必须用 realpath 再确认一次。
  if (!isPathInside(targetReal, bundleReal)) throw new Error(`${label} 不在源 .app 内，已拒绝复制`);
  return targetReal;
}

async function assertMacBundle(bundlePath) {
  const raw = String(bundlePath || '');
  if (!raw || !path.isAbsolute(raw)) throw new Error('源 .app 路径无效，无法重组');
  const bundle = path.resolve(raw);
  const [bundleStat, infoStat] = await Promise.all([
    fsp.stat(bundle).catch(() => null),
    fsp.stat(path.join(bundle, 'Contents', 'Info.plist')).catch(() => null),
  ]);
  if (!bundleStat?.isDirectory() || !infoStat?.isFile()) {
    throw new Error('源路径不是有效的 macOS .app（缺少 Contents/Info.plist），无法重组');
  }
  return bundle;
}

async function copyAppPayload(analysis, resourcesDir) {
  if (analysis.asarPath) {
    const asarPath = await resolvePayloadSource(analysis, analysis.asarPath, 'app.asar');
    await fsp.copyFile(asarPath, path.join(resourcesDir, 'app.asar'));
    const unpacked = path.join(resourcesDir, 'app.asar.unpacked');
    if (analysis.unpackedRoot) {
      const unpackedRoot = await resolvePayloadSource(analysis, analysis.unpackedRoot, 'app.asar.unpacked');
      await fsp.cp(unpackedRoot, unpacked, { recursive: true, force: true });
    }
    return 'app.asar';
  }
  if (analysis.appDir) {
    const appDir = await resolvePayloadSource(analysis, analysis.appDir, 'Resources/app');
    await fsp.cp(appDir, path.join(resourcesDir, 'app'), { recursive: true, force: true });
    return 'app';
  }
  throw new Error('该 .app 没有 app.asar 或 Resources/app，无法重组');
}

async function assembleWindowsApp({ analysis, electronDir, outputDir, onProgress } = {}) {
  if (!analysis?.isElectron) throw new Error('只有 Electron 的 macOS 应用可以重组为 Windows 版');
  if (analysis.nativeModuleCount > 0) {
    throw new Error(`该应用含 ${analysis.nativeModuleCount} 个 macOS 原生模块（.node），Windows 版无法加载。请先在 Windows 上找对应版本，或联系应用作者提供 Windows 版`);
  }
  // 渲染层传入的 analysis 不可信：必须确认源路径真的是 .app，避免把任意目录当作载荷复制。
  await assertMacBundle(analysis.path);
  const emit = (stage, message, extra = {}) => {
    if (onProgress) onProgress({ stage, message, ...extra });
  };
  const safeName = sanitizeFilename(analysis.name || 'Mac App', 'MacApp');
  const rootName = `${safeName}-Windows-x64`;
  const base = path.resolve(outputDir);
  await ensureDir(base);
  let folder = path.join(base, rootName);
  if (fs.existsSync(folder)) {
    const marker = path.join(folder, 'Win2Mac-build.json');
    if (fs.existsSync(marker)) {
      await fsp.rm(folder, { recursive: true, force: true });
    } else {
      folder = path.join(base, `${rootName}-${Date.now().toString(36)}`);
    }
  }
  const zipPath = `${folder}.zip`;
  let created = false;
  try {
    created = true;
    emit('assemble', '正在复制 Electron Windows 运行时…');
    await fsp.cp(electronDir, folder, { recursive: true });
    const resourcesDir = path.join(folder, 'resources');
    const electronExe = path.join(folder, 'electron.exe');
    if (!fs.existsSync(electronExe)) throw new Error('Electron 运行时缺少 electron.exe');
    await fsp.rm(path.join(resourcesDir, 'default_app.asar'), { force: true }).catch(() => {});
    emit('assemble', '正在写入应用载荷…');
    const payloadKind = await copyAppPayload(analysis, resourcesDir);
    const exeName = `${safeName}.exe`;
    await fsp.rename(electronExe, path.join(folder, exeName));

    await fsp.writeFile(path.join(folder, 'Win2Mac-build.json'), `${JSON.stringify({
      format: 'win2mac-mactowin/1',
      createdAt: new Date().toISOString(),
      source: { path: analysis.path, bundleId: analysis.bundleId, version: analysis.version, platform: 'mac' },
      runtime: { kind: 'electron', arch: 'win32-x64' },
      payload: payloadKind,
      executable: exeName,
    }, null, 2)}\n`, 'utf8');

    await fsp.writeFile(path.join(folder, 'README-运行说明.txt'), [
      `Win2Mac Studio：${analysis.name}（Windows 版）`,
      '',
      '这个目录由 macOS 应用的 Electron 载荷重组而成，不是原生重编译。',
      '',
      `1. 双击 ${exeName} 运行；首次可能被 SmartScreen 拦截，选“更多信息 → 仍要运行”。`,
      '2. 这是免安装版，整个目录可拷贝到其他 Windows 电脑。',
      '3. 如果应用依赖 macOS 原生模块、系统钥匙串或 Apple 专属接口，仍可能无法运行；',
      '   可把 Win2Mac Studio 的“AI 修复”诊断结果发给开发者。',
      '',
      '原始应用版权归其发布者所有，请仅在授权范围内使用。',
      '',
    ].join('\r\n'), 'utf8');

    emit('zip', '正在压缩 Windows 免安装包…');
    await fsp.rm(zipPath, { force: true }).catch(() => {});
    const stats = await writeZip({
      rootDir: base,
      rootName: path.basename(folder),
      zipPath,
      onProgress,
      onlyEntries: [path.basename(folder)],
    });
    const zipSha256 = await sha256File(zipPath);
    emit('done', 'Windows 应用已生成');
    return {
      platform: 'windows',
      folderPath: folder,
      zipPath,
      zipSize: (await fsp.stat(zipPath)).size,
      zipSha256,
      executable: exeName,
      fileCount: stats.files,
      runtime: { kind: 'electron', arch: 'win32-x64' },
    };
  } catch (error) {
    // 失败时不要留下半成品目录/ZIP，否则下次构建会生成带时间戳的重复目录。
    if (created) await safeRemove(folder).catch(() => {});
    await safeRemove(zipPath).catch(() => {});
    throw error;
  }
}

module.exports = {
  resolveElectronRuntime,
  assembleWindowsApp,
  normalizeElectronVersion,
  readShasum,
  electronCacheRoot,
};
