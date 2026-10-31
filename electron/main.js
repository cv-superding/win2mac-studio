'use strict';

// The app is shipped without asar; avoid Electron parsing .asar files found inside scanned apps.
process.noAsar = true;

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { pipeline } = require('node:stream/promises');
const yazl = require('yazl');
const { app, BrowserWindow, dialog, ipcMain, Menu, shell } = require('electron');

const { runScanner, analyzePortableTarget } = require('../engine/scanner');
const { analyzeApp } = require('../engine/analyzer');
const { buildBundle, defaultInstallerAnalysis } = require('../engine/packager');
const { buildIconCache } = require('../engine/icons');
const { loadPinnedEngine } = require('../engine/resolver');
const { buildRecipe, normalizeRecipe, MAX_RECIPE_BYTES } = require('../engine/recipe');
const { resolveDroppedFolder, classifyDroppedPath } = require('../engine/drop');
const { extractZip, findAppRoot } = require('../engine/archive');
const { collectCacheStats, clearCaches } = require('../engine/cache');
const { readJson, writeJson, ensureDir, isPathInside, sanitizeFilename, nameSimilarity, formatBytes, sha256File } = require('../engine/util');
const { analyzeMacApp } = require('../engine/macapp');
const { resolveElectronRuntime, assembleWindowsApp } = require('../engine/mactowin');
const { testConnection } = require('../engine/ai/client');
const { runAgent } = require('../engine/ai/agent');
const { createFixerTools, buildFixerPrompt } = require('../engine/ai/fixer');
const { patchConfigText } = require('../engine/ai/config');
const { DEFAULT_AI, normalizeAiSettings, publicAiSettings } = require('../engine/ai/settings');
const PKG = require('../package.json');

const winBuild = Number(String(os.release()).split('.')[2] || 0);
const supportsMica = process.platform === 'win32' && winBuild >= 22000;
const isDev = process.argv.includes('--dev');
const isSmokeScan = process.argv.includes('--smoke-scan');
const isSmoke = process.argv.includes('--smoke-test') || isSmokeScan;
if (isSmoke) {
  app.setPath('userData', path.join(app.getPath('temp'), 'win2mac-smoke-userdata'));
}
let mainWindow = null;
let scanCache = null;
let iconJob = null;
let currentBuild = null;
let aiRunActive = false;
let closePromptOpen = false;
let forceClose = false;

async function withAiLock(task) {
  if (aiRunActive) throw new Error('已有 AI 修复任务在运行');
  aiRunActive = true;
  try {
    return await task();
  } finally {
    aiRunActive = false;
  }
}

function appDataDir() {
  return path.join(app.getPath('appData'), 'Win2Mac');
}

function settingsFile() {
  return path.join(appDataDir(), 'settings.json');
}

function historyFile() {
  return path.join(appDataDir(), 'history.json');
}

function importsRoot() {
  const base = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  return path.join(base, 'Win2Mac', 'imports');
}

function defaultSettings() {
  const documents = app.getPath('documents');
  return {
    outputDir: path.join(documents, 'Win2Mac'),
    proxy: process.env.HTTPS_PROXY || process.env.HTTP_PROXY || '',
    engineMode: 'auto',
    includeRuntimes: true,
    includeUserData: false,
    includeWineMono: true,
    ai: { ...DEFAULT_AI },
  };
}

async function readSettings() {
  try {
    const stored = await readJson(settingsFile());
    const merged = { ...defaultSettings(), ...stored };
    merged.ai = { ...DEFAULT_AI, ...(stored?.ai || {}) };
    return merged;
  } catch {
    return defaultSettings();
  }
}

function publicSettings(settings) {
  const { ai, ...rest } = settings;
  return { ...rest, ai: publicAiSettings(ai) };
}

async function saveSettings(patch) {
  const source = patch && typeof patch === 'object' ? patch : {};
  const current = await readSettings();
  const next = { ...current, ...pickSettings(source) };
  if (source.ai !== undefined && source.ai !== null) next.ai = normalizeAiSettings(source.ai, current.ai);
  await writeJson(settingsFile(), next);
  return next;
}

function pickSettings(patch = {}) {
  const source = patch && typeof patch === 'object' ? patch : {};
  const allowed = ['outputDir', 'proxy', 'engineMode', 'includeRuntimes', 'includeUserData', 'includeWineMono'];
  const next = {};
  for (const key of allowed) {
    if (source[key] !== undefined) next[key] = source[key];
  }
  return next;
}

async function readHistory() {
  try {
    const data = await readJson(historyFile());
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

async function appendHistory(record) {
  const history = await readHistory();
  history.unshift(record);
  await writeJson(historyFile(), history.slice(0, 40));
}

function buildContextDir() {
  return path.join(appDataDir(), 'build-contexts');
}

function safeBuildId(buildId) {
  return String(buildId || '').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 100) || 'unknown';
}

async function recordBuildContext(buildId, context) {
  if (!buildId) return;
  await ensureDir(buildContextDir());
  await writeJson(path.join(buildContextDir(), `${safeBuildId(buildId)}.json`), context);
}

async function readBuildContext(buildId) {
  try {
    return await readJson(path.join(buildContextDir(), `${safeBuildId(buildId)}.json`));
  } catch {
    return null;
  }
}

async function importDiagnostics(targetPath) {
  if (!targetPath) throw new Error('缺少诊断包路径');
  const st = await fsp.stat(targetPath).catch(() => null);
  if (!st) throw new Error('诊断包不存在');
  let dir = targetPath;
  if (st.isFile()) {
    if (!/\.zip$/i.test(targetPath)) throw new Error('只支持诊断 ZIP 或解压后的诊断文件夹');
    const digest = (await sha256File(targetPath)).slice(0, 12);
    dir = path.join(process.env.LOCALAPPDATA || os.tmpdir(), 'Win2Mac', 'diagnostics', digest);
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
    await extractZip(targetPath, dir);
  }
  const dirReal = await fsp.realpath(dir).catch(() => '');
  if (!dirReal) throw new Error('诊断包路径不存在或无法访问');
  // 诊断目录来自用户/渲染层，所有后续读取都必须落在 realpath 之后的范围里，防止目录联接逃逸。
  const resolveInside = async (candidate) => {
    const real = await fsp.realpath(candidate).catch(() => '');
    return real && isPathInside(real, dirReal) ? real : '';
  };
  let root = dirReal;
  const reportCandidate = path.join(dirReal, 'Report.json');
  if (!fs.existsSync(reportCandidate)) {
    const entries = await fsp.readdir(dirReal, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const nested = path.join(dirReal, entry.name);
      if (!fs.existsSync(path.join(nested, 'Report.json'))) continue;
      const nestedReal = await resolveInside(nested);
      if (nestedReal) {
        root = nestedReal;
        break;
      }
    }
  }
  const reportReal = await resolveInside(path.join(root, 'Report.json'));
  const reportStat = reportReal ? await fsp.stat(reportReal).catch(() => null) : null;
  if (!reportStat?.isFile()) throw new Error('诊断包里没有 Report.json，可能不是 Win2Mac 生成的诊断包');
  let report = null;
  if (reportStat.size <= 4 * 1024 * 1024) {
    try {
      report = JSON.parse(await fsp.readFile(reportReal, 'utf8'));
    } catch { /* keep null */ }
  }
  const logs = [];
  const logsDir = path.join(root, 'Logs');
  const logEntries = await fsp.readdir(logsDir, { withFileTypes: true }).catch(() => []);
  for (const entry of logEntries) {
    if (logs.length >= 80) break;
    if (!entry.isFile()) continue;
    const real = await resolveInside(path.join(logsDir, entry.name));
    if (real) logs.push(real);
  }
  return { dir: root, report, logs };
}

function diagnosticsSummaryText(diag) {
  if (!diag) return '';
  const report = diag.report || {};
  const lines = [
    `诊断包：${diag.dir}`,
    `状态：${report.run?.status || '未知'} / 阶段：${report.run?.stage || '未知'}`,
    `错误：${report.run?.error || '未记录'}`,
    `缺失文件：${report.payload?.missingCount ?? '?'}，大小不符：${report.payload?.sizeMismatchCount ?? '?'}`,
    diag.logs.length ? `日志：${diag.logs.slice(0, 8).map((file) => path.basename(file)).join('、')}` : '',
  ];
  return lines.filter(Boolean).join('\n');
}

function configPathFor(record) {
  if (record.platform === 'windows') return '';
  return path.join(record.result.appPath, 'Contents', 'Resources', 'win2mac', 'config.env');
}

async function buildFixerContext({ buildId, diagnostics, rebuild }) {
  const record = await readBuildContext(buildId);
  if (!record) throw new Error('找不到该构建的记录，请先完成一次转换再让 AI 修复');
  const appRoot = record.platform === 'windows' ? record.result.folderPath : record.result.appPath;
  const configPath = configPathFor(record);
  const allowedRoots = [appRoot, diagnostics?.dir].filter(Boolean);
  const allowedRealRoots = [];
  for (const root of allowedRoots) {
    try {
      allowedRealRoots.push(fs.realpathSync(root));
    } catch { /* 根目录不存在时由候选检查兜底 */ }
  }
  const resolveReadable = (input) => {
    const raw = String(input || '').trim();
    if (!raw) throw new Error('缺少文件路径');
    const candidates = [];
    if (path.isAbsolute(raw)) candidates.push(path.resolve(raw));
    else {
      if (configPath) candidates.push(path.join(path.dirname(configPath), raw));
      candidates.push(path.join(appRoot, raw));
      if (diagnostics?.dir) candidates.push(path.join(diagnostics.dir, raw));
    }
    for (const candidate of candidates) {
      if (!fs.existsSync(candidate)) continue;
      let real;
      try {
        real = fs.realpathSync(candidate);
      } catch {
        continue;
      }
      // 词法路径可能在允许根内，但符号链接/目录联接会指向根外；按 realpath 再判断。
      if (!allowedRealRoots.some((root) => isPathInside(real, root))) continue;
      try {
        if (fs.statSync(real).isFile()) return real;
      } catch { /* ignore */ }
    }
    throw new Error(`路径不在允许范围或不存在：${raw}`);
  };

  const readTextCapped = async (file, maxBytes = 60000) => {
    const limit = Math.min(Math.max(Number(maxBytes) || 60000, 512), 300000);
    const handle = await fsp.open(file, 'r');
    try {
      const buffer = Buffer.alloc(limit);
      const read = await handle.read(buffer, 0, limit, 0);
      const text = buffer.subarray(0, read.bytesRead).toString('utf8');
      return read.bytesRead >= limit ? `${text}\n…（已截断，文件更大）` : text;
    } finally {
      await handle.close().catch(() => {});
    }
  };

  const textCorpus = async () => {
    const files = [];
    if (configPath && fs.existsSync(configPath)) files.push(configPath);
    for (const root of [diagnostics?.dir, appRoot].filter(Boolean)) {
      for (const name of ['Report.md', 'Report.json', 'Missing.txt', 'README.txt']) {
        const file = path.join(root, name);
        if (fs.existsSync(file)) files.push(file);
      }
    }
    for (const log of diagnostics?.logs || []) files.push(log);
    const corpus = [];
    for (const file of files.slice(0, 40)) {
      try {
        corpus.push({ path: file, text: await readTextCapped(file, 200000) });
      } catch { /* ignore */ }
    }
    return corpus;
  };

  return {
    appName: record.app?.name,
    buildId,
    platform: record.platform,
    analysisSummary: record.analysis ? `${record.analysis.grade} · ${record.analysis.gradeSummary}` : '',
    diagnosticsSummary: diagnosticsSummaryText(diagnostics),
    status: async () => ({
      platform: record.platform,
      app: record.app,
      analysis: record.analysis ? { grade: record.analysis.grade, summary: record.analysis.gradeSummary, reasons: record.analysis.reasons } : null,
      options: record.options,
      result: record.result,
      config: configPath && fs.existsSync(configPath) ? await readTextCapped(configPath, 30000) : '(无 config.env)',
      diagnostics: diagnostics?.report || null,
    }),
    readFile: async (input, maxBytes) => {
      const file = resolveReadable(input);
      return { path: file, text: await readTextCapped(file, maxBytes) };
    },
    searchLogs: async (query, limit = 30) => {
      const needle = String(query || '').trim();
      if (!needle) throw new Error('缺少搜索关键字');
      const max = Math.min(Math.max(Number(limit) || 30, 1), 80);
      const hits = [];
      for (const file of await textCorpus()) {
        const lines = file.text.split(/\r?\n/);
        for (let i = 0; i < lines.length && hits.length < max; i += 1) {
          if (lines[i].toLowerCase().includes(needle.toLowerCase())) {
            hits.push(`${path.basename(file.path)}:${i + 1}: ${lines[i].slice(0, 400)}`);
          }
        }
        if (hits.length >= max) break;
      }
      return { query: needle, hits, truncated: hits.length >= max };
    },
    patchConfig: async (changes) => {
      if (!configPath || !fs.existsSync(configPath)) throw new Error('当前产物的 config.env 不存在，无法补丁；可直接 rebuild');
      const original = await fsp.readFile(configPath, 'utf8');
      const { text, applied } = patchConfigText(original, changes);
      if (!Object.keys(applied).length) return { changed: false, applied };
      const backup = `${configPath}.bak-${Date.now().toString(36)}`;
      await fsp.writeFile(backup, original, 'utf8');
      await fsp.writeFile(configPath, text, 'utf8');
      return { changed: true, applied, backup, note: '已修改产物内 config.env；需要调用 rebuild 才会生成包含新配置的 ZIP' };
    },
    rebuild,
  };
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: isSmokeScan ? 1440 : 1320,
    height: isSmokeScan ? 900 : 860,
    minWidth: 1040,
    minHeight: 680,
    show: false,
    frame: false,
    backgroundColor: supportsMica ? '#00000000' : '#f3f3f3',
    backgroundMaterial: supportsMica ? 'mica' : undefined,
    title: 'Win2Mac Studio',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      offscreen: isSmokeScan,
    },
  });
  mainWindow.loadFile(path.join(__dirname, '..', 'app', 'index.html'), isSmoke ? { query: { smoke: '1' } } : undefined);
  if (isSmoke) {
    mainWindow.webContents.once('did-finish-load', async () => {
      await new Promise((resolve) => setTimeout(resolve, 900));
      try {
        const bridge = await mainWindow.webContents.executeJavaScript('Boolean(window.win2mac && window.win2mac.isDesktop)');
        const navCount = await mainWindow.webContents.executeJavaScript("document.querySelectorAll('.nav-item').length");
        const title = await mainWindow.webContents.executeJavaScript("document.querySelector('#page-title')?.textContent || ''");
        const result = { bridge, navCount, title, version: app.getVersion(), electron: process.versions.electron };
        const smokeFixture = path.join(appDataDir(), 'smoke-fixture');
        try {
          await ensureDir(smokeFixture);
          await fsp.writeFile(path.join(smokeFixture, 'Smoke Fixture.exe'), Buffer.alloc(5000, 7));
          await fsp.writeFile(path.join(smokeFixture, 'Uninstall Smoke Fixture.exe'), Buffer.alloc(7000, 8));
          result.cacheGroups = await mainWindow.webContents.executeJavaScript('window.win2mac.cacheStats().then((stats) => stats.groups.length)');
          result.aiSettings = await mainWindow.webContents.executeJavaScript('Promise.all([window.win2mac.getSettings(), window.win2mac.info()]).then(([s, info]) => ({ hasKey: Boolean(s.ai && s.ai.hasKey), leaked: Boolean(s.ai && Object.prototype.hasOwnProperty.call(s.ai, "apiKey")) || Boolean(info.settings?.ai && Object.prototype.hasOwnProperty.call(info.settings.ai, "apiKey")) }))');
          result.ui = await mainWindow.webContents.executeJavaScript(`(() => {
            const link = Boolean(document.querySelector('link[href$="theme-winui.css"]'));
            const toggle = document.querySelector('[data-action="toggle-nav"]');
            if (toggle) toggle.click();
            const collapsed = document.body.classList.contains('nav-collapsed');
            if (toggle) toggle.click();
            const restored = !document.body.classList.contains('nav-collapsed');
            return { link, collapsed, restored };
          })()`);
          const dropped = await mainWindow.webContents.executeJavaScript(`window.win2mac.inspectPath(${JSON.stringify(smokeFixture)}).then((payload) => ({ name: payload?.app?.name || '', kind: payload?.kind || '', exe: payload?.app?.exePath || '' }))`);
          result.drop = dropped;
          const smokeZip = path.join(appDataDir(), 'smoke-fixture.zip');
          const archive = new yazl.ZipFile();
          archive.addFile(path.join(smokeFixture, 'Smoke Fixture.exe'), 'Smoke Fixture.exe');
          archive.addFile(path.join(smokeFixture, 'Uninstall Smoke Fixture.exe'), 'Uninstall Smoke Fixture.exe');
          archive.end();
          await pipeline(archive.outputStream, fs.createWriteStream(smokeZip));
          const archived = await mainWindow.webContents.executeJavaScript(`window.win2mac.inspectPath(${JSON.stringify(smokeZip)}).then((payload) => ({ name: payload?.app?.name || '', kind: payload?.kind || '', source: payload?.app?.source || '', files: payload?.archive?.files || 0, exe: payload?.app?.exePath || '', extractedPath: payload?.archive?.extractedPath || '' }))`);
          result.archive = archived;
          await fsp.rm(smokeZip, { force: true }).catch(() => {});
          if (archived.extractedPath) await fsp.rm(path.dirname(archived.extractedPath), { recursive: true, force: true }).catch(() => {});
        } catch (featureError) {
          result.featureError = featureError.message;
        } finally {
          await fsp.rm(smokeFixture, { recursive: true, force: true }).catch(() => {});
        }
        if (isSmokeScan) {
          if (!bridge) throw new Error('preload bridge missing');
          await mainWindow.webContents.executeJavaScript("document.querySelector('[data-action=\"scan\"]')?.click(); true");
          const deadline = Date.now() + 90000;
          let appCount = 0;
          while (Date.now() < deadline) {
            appCount = await mainWindow.webContents.executeJavaScript("document.querySelectorAll('[data-app-row]').length");
            if (appCount > 0) break;
            await new Promise((resolve) => setTimeout(resolve, 500));
          }
          const iconDeadline = Date.now() + 45000;
          let iconCount = 0;
          while (Date.now() < iconDeadline) {
            iconCount = await mainWindow.webContents.executeJavaScript("document.querySelectorAll('.app-icon.has-image').length");
            if (iconCount >= 5) break;
            await new Promise((resolve) => setTimeout(resolve, 500));
          }
          const analysisDeadline = Date.now() + 180000;
          let pendingAnalysis = 0;
          while (Date.now() < analysisDeadline) {
            pendingAnalysis = await mainWindow.webContents.executeJavaScript("document.querySelectorAll('.grade.neutral, .grade.error').length");
            if (pendingAnalysis === 0) break;
            await new Promise((resolve) => setTimeout(resolve, 1000));
          }
          result.pendingAnalysis = pendingAnalysis;
          await new Promise((resolve) => setTimeout(resolve, 1200));
          const image = await mainWindow.webContents.capturePage({ x: 0, y: 0, width: 1440, height: 900 });
          fs.writeFileSync(path.join(appDataDir(), 'smoke-real.png'), image.toPNG());
          result.appCount = appCount;
          result.iconCount = iconCount;
          result.scanError = await mainWindow.webContents.executeJavaScript("document.querySelector('.error-state')?.textContent || ''");
        }
        fs.writeFileSync(path.join(appDataDir(), 'smoke.log'), JSON.stringify(result, null, 2));
        console.log('SMOKE_RESULT ' + JSON.stringify(result));
        const ok = bridge
          && navCount >= 4
          && result.cacheGroups >= 3
          && result.aiSettings?.leaked === false
          && result.ui?.link === true
          && result.ui?.collapsed === true
          && result.ui?.restored === true
          && result.drop?.name
          && result.archive?.source === 'archive'
          && /Smoke Fixture\.exe$/.test(result.archive?.exe || '')
          && !/Uninstall/i.test(result.archive?.exe || '')
          && (!isSmokeScan || result.appCount > 0);
        app.exit(ok ? 0 : 1);
      } catch (error) {
        console.error('SMOKE_ERROR', error);
        app.exit(1);
      }
    });
    return;
  }
  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    if (isDev) mainWindow.webContents.openDevTools({ mode: 'detach' });
  });
  mainWindow.on('maximize', () => mainWindow?.webContents.send('window:state', { maximized: true }));
  mainWindow.on('unmaximize', () => mainWindow?.webContents.send('window:state', { maximized: false }));
  mainWindow.on('close', async (event) => {
    if (!currentBuild || forceClose) return;
    event.preventDefault();
    if (closePromptOpen) return;
    closePromptOpen = true;
    try {
      const { response } = await dialog.showMessageBox(mainWindow, {
        type: 'warning',
        title: '转换仍在进行',
        message: '关闭窗口会中止当前转换。',
        detail: '已经写入的临时文件可能不完整。建议等待转换完成后再关闭。',
        buttons: ['继续转换', '退出并中止'],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      });
      if (response === 1) {
        forceClose = true;
        mainWindow.destroy();
      }
    } finally {
      closePromptOpen = false;
    }
  });
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('file://')) event.preventDefault();
  });
}

function prettifyInstallerName(file) {
  const base = path.basename(file, path.extname(file));
  const cleaned = base
    .replace(/[._-]+/g, ' ')
    .replace(/(^|\s)(setup|installer|install|web|online|offline|x64|x86|64-bit|32-bit)(\s|$)/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned || 'Windows Installer App';
}

function enrichAppWithAnalysis(appInfo, analysis) {
  return {
    ...appInfo,
    ...analysis,
    arch: analysis.pe?.arch || appInfo.arch,
    archLabel: analysis.pe?.machineLabel || appInfo.archLabel,
    bits: analysis.pe?.bits || appInfo.bits,
    isDotNet: Boolean(analysis.pe?.isDotNet),
    analysis,
    fullAnalysis: true,
  };
}

function send(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
}

async function installerSelection(installerPath) {
  const ext = path.extname(installerPath).toLowerCase();
  if (ext !== '.exe' && ext !== '.msi') throw new Error('仅支持 .exe 或 .msi 安装包');
  const stat = await fsp.stat(installerPath).catch(() => null);
  if (!stat?.isFile()) throw new Error('安装包文件不存在');
  const name = prettifyInstallerName(installerPath);
  const analysis = defaultInstallerAnalysis(name);
  const app = {
    id: `installer-${Date.now().toString(36)}`,
    name,
    publisher: '',
    version: '',
    installPath: path.win32.dirname(installerPath),
    exePath: '',
    displayIcon: installerPath,
    estimatedSizeBytes: stat.size,
    source: 'installer',
    analysis,
    fullAnalysis: true,
    warnings: [],
  };
  return {
    app,
    analysis,
    installer: { path: installerPath, name: path.basename(installerPath), type: ext === '.msi' ? 'msi' : 'exe', args: '', expectedExe: '', size: stat.size },
    services: [],
  };
}

async function appSelectionFromExe(exePath, { displayName = '', installPath = '' } = {}) {
  const normalized = path.win32.normalize(exePath);
  const appInfo = analyzePortableTarget(normalized, displayName || undefined);
  if (installPath) {
    appInfo.installPath = path.win32.normalize(installPath);
    appInfo.workingDirectory = path.win32.dirname(normalized);
  }
  const analysis = await analyzeApp(appInfo, { services: [] });
  if (!appInfo.estimatedSizeBytes) appInfo.estimatedSizeBytes = analysis.directory?.scannedBytes || 0;
  return { app: enrichAppWithAnalysis(appInfo, analysis), services: [] };
}

const GENERIC_FOLDER = /^(downloads?|desktop|program files( \(x86\))?|apps?|bin|release|win(32|64)|x64|x86|portable)$/i;

async function importArchive(archivePath) {
  const ext = path.extname(archivePath).toLowerCase();
  if (ext !== '.zip') throw new Error('目前仅支持导入 .zip 压缩包');
  const stat = await fsp.stat(archivePath).catch(() => null);
  if (!stat?.isFile()) throw new Error('压缩包文件不存在');
  const archiveName = path.basename(archivePath);
  const dest = path.join(importsRoot(), `zip-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`);
  try {
    send('archive:progress', { stage: 'extract', message: '正在解压压缩包…', files: 0, bytes: 0 });
    let lastProgress = 0;
    const extracted = await extractZip(archivePath, dest, {
      onProgress: (progress) => {
        const now = Date.now();
        if (now - lastProgress < 180) return;
        lastProgress = now;
        send('archive:progress', {
          stage: 'extract',
          message: `已解压 ${progress.files.toLocaleString('zh-CN')} 个文件…`,
          files: progress.files,
          bytes: progress.bytes,
        });
      },
    });
    if (!extracted.files) throw new Error('压缩包里没有文件');
    if (isMacAppBundle(extracted.root)) {
      send('archive:progress', { stage: 'analyze', message: '正在识别 macOS 应用…', files: extracted.files, bytes: extracted.bytes });
      const mac = await macAppSelection(extracted.root);
      mac.app.source = 'mac-archive';
      mac.app.archivePath = archivePath;
      mac.app.archiveName = archiveName;
      mac.app.importedAt = new Date().toISOString();
      mac.archive = { path: archivePath, name: archiveName, extractedPath: extracted.root, files: extracted.files, bytes: extracted.bytes };
      return mac;
    }
    send('archive:progress', { stage: 'analyze', message: '正在识别应用主程序…', files: extracted.files, bytes: extracted.bytes });
    const macNested = await findMacAppIn(extracted.root);
    if (macNested) {
      const mac = await macAppSelection(macNested);
      mac.app.source = 'mac-archive';
      mac.app.archivePath = archivePath;
      mac.app.archiveName = archiveName;
      mac.app.importedAt = new Date().toISOString();
      mac.archive = { path: archivePath, name: archiveName, extractedPath: macNested, files: extracted.files, bytes: extracted.bytes };
      return mac;
    }
    const appRoot = await findAppRoot(extracted.root);
    let resolved;
    try {
      resolved = await resolveDroppedFolder(appRoot);
    } catch {
      throw new Error('压缩包里没有找到已解包应用的主程序。请把安装后的应用文件夹（包含 .exe）压缩成 ZIP，而不是只放安装器。');
    }
    const folderName = path.basename(appRoot);
    const exeBase = path.win32.basename(resolved.exePath, path.win32.extname(resolved.exePath));
    const displayName = GENERIC_FOLDER.test(folderName) || nameSimilarity(folderName, exeBase) < 0.2 ? exeBase : folderName;
    const result = await appSelectionFromExe(resolved.exePath, { displayName, installPath: appRoot });
    result.app.source = 'archive';
    result.app.archivePath = archivePath;
    result.app.archiveName = archiveName;
    result.app.importedAt = new Date().toISOString();
    result.app.estimatedSizeBytes = extracted.bytes;
    result.kind = 'app';
    result.archive = {
      path: archivePath,
      name: archiveName,
      extractedPath: appRoot,
      files: extracted.files,
      bytes: extracted.bytes,
    };
    return result;
  } catch (error) {
    await fsp.rm(dest, { recursive: true, force: true }).catch(() => {});
    throw new Error(`导入压缩包失败：${error.message}`);
  }
}

function isMacAppBundle(target) {
  try {
    return fs.statSync(target).isDirectory() && fs.existsSync(path.join(target, 'Contents', 'Info.plist'));
  } catch {
    return false;
  }
}

async function findMacAppIn(dir) {
  const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
  const apps = entries.filter((entry) => entry.isDirectory() && /\.app$/i.test(entry.name));
  if (apps.length === 1) return path.join(dir, apps[0].name);
  if (apps.length > 1) throw new Error(`压缩包里有 ${apps.length} 个 .app，请只保留要转换的那一个`);
  const dirs = entries.filter((entry) => entry.isDirectory() && !entry.name.startsWith('__MACOSX'));
  if (dirs.length === 1) {
    const nested = path.join(dir, dirs[0].name);
    const nestedApps = await fsp.readdir(nested, { withFileTypes: true }).catch(() => []);
    const found = nestedApps.filter((entry) => entry.isDirectory() && /\.app$/i.test(entry.name));
    if (found.length === 1) return path.join(nested, found[0].name);
    if (found.length > 1) throw new Error(`压缩包里有 ${found.length} 个 .app，请只保留要转换的那一个`);
  }
  return '';
}

const MAC_GRADE_LABELS = { A: '可直接重组', B: '可直接重组', C: '可能无法启动', D: '暂不支持' };

async function macAppSelection(bundlePath) {
  const mac = await analyzeMacApp(bundlePath);
  const id = `mac-${crypto.createHash('sha1').update(mac.path).digest('hex').slice(0, 12)}`;
  const analysis = {
    grade: mac.grade,
    gradeLabel: MAC_GRADE_LABELS[mac.grade] || '待评估',
    gradeSummary: mac.summary,
    score: mac.grade === 'A' ? 95 : mac.grade === 'C' ? 60 : 20,
    reasons: mac.reasons,
    recommendedEngine: 'native',
    engineReason: 'Electron 重组为 Windows 原生应用，不使用 Wine',
    pe: null,
    blocked: mac.grade === 'D',
  };
  return {
    kind: 'mac-app',
    app: {
      id,
      name: mac.name,
      publisher: mac.bundleId,
      version: mac.version,
      installPath: mac.path,
      exePath: mac.exePath,
      workingDirectory: mac.path,
      displayIcon: '',
      launchArgs: '',
      registryKeys: [],
      source: 'mac-app',
      platform: 'mac',
      arch: (mac.exeArchs || []).join('/'),
      archLabel: (mac.exeArchs || []).join(' / ') || '未知',
      isDotNet: false,
      warnings: [],
      macAnalysis: mac,
      analysis,
      fullAnalysis: true,
    },
    analysis,
  };
}

async function inspectDroppedPath(target) {
  assertString(target, '拖入路径');
  const abs = path.resolve(target);
  const stat = await fsp.stat(abs).catch(() => null);
  if (!stat) throw new Error('拖入的文件或文件夹不存在');
  if (stat.isDirectory()) {
    if (isMacAppBundle(abs)) return macAppSelection(abs);
    const nestedMac = await findMacAppIn(abs);
    if (nestedMac) return macAppSelection(nestedMac);
    const resolved = await resolveDroppedFolder(abs);
    const folderName = path.basename(abs);
    const exeBase = path.win32.basename(resolved.exePath, path.win32.extname(resolved.exePath));
    const displayName = GENERIC_FOLDER.test(folderName) || nameSimilarity(folderName, exeBase) < 0.2 ? exeBase : folderName;
    const result = await appSelectionFromExe(resolved.exePath, { displayName, installPath: abs });
    return {
      ...result,
      kind: 'app',
      drop: {
        kind: 'folder',
        folder: abs,
        chosenExe: resolved.exePath,
        candidateCount: resolved.candidates.length,
        truncated: resolved.truncated,
      },
    };
  }
  if (!stat.isFile()) throw new Error('只支持拖入 .exe、.msi 或应用文件夹');
  const classification = classifyDroppedPath(abs);
  if (classification.kind === 'installer') return { ...(await installerSelection(abs)), kind: 'installer' };
  if (classification.kind === 'zip') return importArchive(abs);
  if (classification.kind === 'exe') {
    if (classification.suspiciousInstaller) {
      const { response } = await dialog.showMessageBox(mainWindow, {
        type: 'question',
        title: '这是安装程序吗？',
        message: path.basename(abs),
        detail: '文件名看起来像安装程序。作为“应用”打包会直接复制现有文件；作为“安装程序”打包会在目标 Mac 首次启动时才安装。',
        buttons: ['作为应用打包', '作为安装程序打包', '取消'],
        defaultId: 0,
        cancelId: 2,
        noLink: true,
      });
      if (response === 2) return null;
      if (response === 1) return { ...(await installerSelection(abs)), kind: 'installer' };
    }
    return { ...(await appSelectionFromExe(abs)), kind: 'app', drop: { kind: 'file', chosenExe: abs } };
  }
  throw new Error('不支持的文件类型。请拖入 .exe、.msi 或应用文件夹。');
}

async function assertFileSize(file, max, label) {
  const stat = await fsp.stat(file);
  if (stat.size > max) throw new Error(`${label}过大（${formatBytes(stat.size)}），上限为 ${formatBytes(max)}`);
  return stat;
}

function assertString(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} 无效`);
  return value;
}

function setupIpc() {
  ipcMain.handle('app:info', async () => {
    const settings = await readSettings();
    const pinned = await loadPinnedEngine();
    return {
      name: app.getName(),
      version: PKG.version,
      electron: process.versions.electron,
      node: process.versions.node,
      platform: process.platform,
      arch: process.arch,
      mica: supportsMica,
      maximized: Boolean(mainWindow?.isMaximized()),
      userData: appDataDir(),
      settings: publicSettings(settings),
      enginePinned: pinned ? { version: pinned.version, name: pinned.name, size: pinned.sizeLabel, url: pinned.url } : null,
    };
  });

  ipcMain.handle('settings:get', async () => publicSettings(await readSettings()));
  ipcMain.handle('settings:set', async (_event, patch) => {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('设置参数无效');
    return publicSettings(await saveSettings(patch));
  });

  ipcMain.handle('ai:test', async () => {
    const settings = await readSettings();
    return testConnection({
      baseUrl: settings.ai.baseUrl,
      apiKey: settings.ai.apiKey,
      model: settings.ai.model,
      proxy: settings.proxy,
      timeoutMs: Math.min(settings.ai.timeoutMs, 45000),
    });
  });

  ipcMain.handle('ai:pick-diagnostics', async () => {
    const picked = await dialog.showOpenDialog(mainWindow, {
      title: '选择 Mac 诊断包',
      properties: ['openFile', 'openDirectory'],
      filters: [{ name: 'Win2Mac 诊断包', extensions: ['zip'] }],
    });
    if (picked.canceled || !picked.filePaths.length) return null;
    return importDiagnostics(picked.filePaths[0]);
  });

  ipcMain.handle('ai:import-diagnostics', async (_event, target) => {
    assertString(target, '诊断包路径');
    return importDiagnostics(target);
  });

  ipcMain.handle('ai:fix', async (event, payload = {}) => {
    if (!payload || typeof payload !== 'object') throw new Error('修复请求参数无效');
    return withAiLock(async () => {
      const settings = await readSettings();
      if (!settings.ai.apiKey) throw new Error('还没有配置 API Key，请先在设置里填写');
      const buildId = typeof payload.buildId === 'string' ? payload.buildId.trim() : '';
      if (!buildId) throw new Error('缺少构建 ID');
      if (payload.diagnosticsPath !== undefined && payload.diagnosticsPath !== null && typeof payload.diagnosticsPath !== 'string') {
        throw new Error('诊断包路径无效');
      }
      const diagnostics = payload.diagnosticsPath ? await importDiagnostics(payload.diagnosticsPath) : null;
      const sendEvent = (data) => {
        if (!event.sender.isDestroyed()) event.sender.send('ai:event', data);
      };
      const rebuild = async (advanced = {}) => {
        const record = await readBuildContext(buildId);
        if (!record) throw new Error('构建记录已丢失，无法重建');
        if (record.platform === 'windows') {
          const runtime = await resolveElectronRuntime({
            version: record.macAnalysis?.electronVersion,
            proxy: settings.proxy,
            manualZip: advanced.manualElectronZip || record.options?.manualElectronZip || '',
            onProgress: (progress) => sendEvent({ type: 'progress', ...progress }),
          });
          const rebuilt = await assembleWindowsApp({
            analysis: record.macAnalysis,
            electronDir: runtime.dir,
            outputDir: record.options.outputDir,
            onProgress: (progress) => sendEvent({ type: 'progress', ...progress }),
          });
          record.result = { ...rebuilt, zipPath: rebuilt.zipPath, folderPath: rebuilt.folderPath };
          await recordBuildContext(buildId, record);
          return { zipPath: rebuilt.zipPath, folderPath: rebuilt.folderPath, platform: 'windows' };
        }
        const advancedNext = { ...(record.options.advanced || {}), ...advanced };
        const result = await buildBundle(
          {
            app: record.app,
            analysis: record.analysis,
            installer: record.installer || null,
            advanced: advancedNext,
            outputDir: record.options.outputDir,
            engineMode: advanced.engineMode || record.options.engineMode,
            manualEngineArchive: record.options.manualEngineArchive || '',
            includeRuntimes: record.options.includeRuntimes,
            includeWineMono: record.options.includeWineMono,
            includeUserData: record.options.includeUserData,
            proxy: settings.proxy,
          },
          (progress) => sendEvent({ type: 'progress', ...progress }),
        );
        record.options.advanced = advancedNext;
        record.result = { appPath: result.appPath, zipPath: result.zipPath, folderPath: result.folderPath };
        await recordBuildContext(buildId, record);
        return { zipPath: result.zipPath, appPath: result.appPath, platform: 'mac' };
      };
      const ctx = await buildFixerContext({ buildId, diagnostics, rebuild });
      const tools = createFixerTools({ ctx });
      const userPrompt = buildFixerPrompt({
        appName: ctx.appName,
        buildId,
        platform: ctx.platform,
        analysisSummary: ctx.analysisSummary,
        diagnosticsSummary: ctx.diagnosticsSummary,
      });
      const run = await runAgent({
        settings: {
          ...settings.ai,
          proxy: settings.proxy,
        },
        tools,
        userPrompt,
        maxSteps: Math.min(Math.max(Number(payload.maxSteps) || 8, 1), 12),
        onEvent: sendEvent,
      });
      return {
        buildId,
        finished: run.finished,
        summary: run.finalText,
        trace: run.trace,
        diagnostics: diagnostics ? { dir: diagnostics.dir, report: diagnostics.report } : null,
      };
    });
  });
  ipcMain.handle('history:list', () => readHistory());
  ipcMain.handle('history:clear', async () => {
    await writeJson(historyFile(), []);
    return [];
  });

  ipcMain.handle('recipe:export', async (_event, payload = {}) => {
    if (!payload || typeof payload !== 'object') throw new Error('配方请求参数无效');
    if (!payload.app) throw new Error('缺少应用信息，无法导出配方');
    const recipe = buildRecipe({
      app: payload.app,
      analysis: payload.analysis || payload.app.analysis || {},
      options: payload.options || {},
      installer: payload.installer || null,
      generatorVersion: PKG.version,
      notes: payload.notes || '',
    });
    const base = sanitizeFilename(recipe.match.name || recipe.app.name || 'win2mac-recipe', 'win2mac-recipe');
    const result = await dialog.showSaveDialog(mainWindow, {
      title: '导出移植配方',
      defaultPath: path.join(app.getPath('documents'), `${base}.win2mac.json`),
      filters: [{ name: 'Win2Mac 移植配方', extensions: ['json'] }],
    });
    if (result.canceled || !result.filePath) return null;
    const filePath = /\.json$/i.test(result.filePath) ? result.filePath : `${result.filePath}.json`;
    const content = `${JSON.stringify(recipe, null, 2)}\n`;
    await fsp.writeFile(filePath, content, 'utf8');
    return { path: filePath, recipe, bytes: Buffer.byteLength(content) };
  });

  ipcMain.handle('recipe:import', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: '导入 Win2Mac 移植配方',
      filters: [{ name: 'Win2Mac 移植配方', extensions: ['json'] }],
      properties: ['openFile'],
    });
    if (result.canceled || !result.filePaths[0]) return null;
    const file = result.filePaths[0];
    await assertFileSize(file, MAX_RECIPE_BYTES, '配方文件');
    let parsed;
    try {
      parsed = JSON.parse((await fsp.readFile(file, 'utf8')).replace(/^\uFEFF/, ''));
    } catch (error) {
      throw new Error(`配方不是有效的 JSON：${error.message}`);
    }
    return { path: file, recipe: normalizeRecipe(parsed) };
  });

  ipcMain.handle('cache:stats', () => collectCacheStats());

  ipcMain.handle('cache:clear', async (_event, keys = []) => {
    if (currentBuild) throw new Error('转换正在进行，请完成后再清理缓存');
    if (!Array.isArray(keys)) throw new Error('缓存选择无效');
    const stats = await collectCacheStats();
    const selected = stats.groups.filter((group) => keys.includes(group.key) && group.bytes > 0);
    if (!selected.length) return { clearedBytes: 0, clearedFiles: 0, stats };
    const total = selected.reduce((sum, group) => sum + group.bytes, 0);
    const { response } = await dialog.showMessageBox(mainWindow, {
      type: 'warning',
      title: '清理 Win2Mac 缓存',
      message: `将清理 ${selected.map((group) => group.label).join('、')}，共 ${formatBytes(total)}。`,
      detail: '不会删除已生成的 .app、ZIP 或应用数据。清理引擎与运行库缓存后，下次打包可能需要重新下载。',
      buttons: ['取消', '清理'],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    });
    if (response !== 1) return null;
    return clearCaches(keys);
  });

  ipcMain.handle('window:minimize', () => mainWindow?.minimize());
  ipcMain.handle('window:toggle-maximize', () => {
    if (!mainWindow) return false;
    if (mainWindow.isMaximized()) mainWindow.unmaximize();
    else mainWindow.maximize();
    return mainWindow.isMaximized();
  });
  ipcMain.handle('window:close', () => mainWindow?.close());

  ipcMain.handle('dialog:output', async (_event, requestedPath = '') => {
    if (requestedPath !== undefined && requestedPath !== null && typeof requestedPath !== 'string') {
      throw new Error('输出目录参数无效');
    }
    const settings = await readSettings();
    const result = await dialog.showOpenDialog(mainWindow, {
      title: '选择 macOS 安装包输出目录',
      defaultPath: requestedPath || settings.outputDir,
      properties: ['openDirectory', 'createDirectory'],
    });
    if (result.canceled || !result.filePaths[0]) return null;
    return result.filePaths[0];
  });

  ipcMain.handle('dialog:exe', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: '选择一个 Windows 程序（.exe）',
      filters: [{ name: 'Windows 程序', extensions: ['exe'] }],
      properties: ['openFile'],
    });
    if (result.canceled || !result.filePaths[0]) return null;
    return appSelectionFromExe(result.filePaths[0]);
  });

  ipcMain.handle('dialog:app-exe', async (_event, payload = {}) => {
    if (!payload || typeof payload !== 'object') throw new Error('应用信息参数无效');
    const appInfo = payload.app;
    if (!appInfo?.installPath) throw new Error('应用缺少安装目录，无法重新指定主程序');
    const result = await dialog.showOpenDialog(mainWindow, {
      title: '重新指定主程序',
      defaultPath: appInfo.installPath,
      filters: [{ name: 'Windows 程序', extensions: ['exe'] }],
      properties: ['openFile'],
    });
    if (result.canceled || !result.filePaths[0]) return null;
    const exePath = result.filePaths[0];
    if (!isPathInside(exePath, appInfo.installPath)) {
      throw new Error('主程序必须位于该应用的安装目录内。如果安装目录本身不对，请用顶部的“选择 .exe”重新添加。');
    }
    const next = {
      ...appInfo,
      exePath,
      displayIcon: exePath,
      workingDirectory: path.dirname(exePath),
      shortcut: null,
      launchArgs: '',
    };
    delete next.externalWorkingDirectory;
    const services = payload.services || scanCache?.services || [];
    const analysis = await analyzeApp(next, { services, scanDirectory: true, maxFiles: 4000 });
    if (scanCache?.apps) {
      const cached = scanCache.apps.find((item) => item.id === next.id);
      if (cached) Object.assign(cached, next, { analysis, fullAnalysis: true });
    }
    return { app: enrichAppWithAnalysis(next, analysis), analysis };
  });

  ipcMain.handle('dialog:installer', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: '选择一个 Windows 安装包（实验性）',
      filters: [{ name: 'Windows 安装包', extensions: ['exe', 'msi'] }],
      properties: ['openFile'],
    });
    if (result.canceled || !result.filePaths[0]) return null;
    return installerSelection(result.filePaths[0]);
  });

  ipcMain.handle('dialog:archive', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: '导入一个应用目录压缩包（.zip）',
      filters: [{ name: 'ZIP 压缩包', extensions: ['zip'] }],
      properties: ['openFile'],
    });
    if (result.canceled || !result.filePaths[0]) return null;
    return importArchive(result.filePaths[0]);
  });

  ipcMain.handle('apps:inspect-path', async (_event, target) => inspectDroppedPath(target));

  ipcMain.handle('mactowin:pick-app', async () => {
    const picked = await dialog.showOpenDialog(mainWindow, {
      title: '选择 macOS .app（或包含 .app 的文件夹）',
      properties: ['openDirectory'],
    });
    if (picked.canceled || !picked.filePaths.length) return null;
    const target = picked.filePaths[0];
    if (isMacAppBundle(target)) return macAppSelection(target);
    const nested = await findMacAppIn(target);
    if (!nested) throw new Error('所选文件夹里没有 .app');
    return macAppSelection(nested);
  });

  ipcMain.handle('mactowin:pick-electron-zip', async () => {
    const picked = await dialog.showOpenDialog(mainWindow, {
      title: '选择 electron-v*-win32-x64.zip（离线用）',
      properties: ['openFile'],
      filters: [{ name: 'Electron Windows 运行时', extensions: ['zip'] }],
    });
    return picked.canceled ? '' : picked.filePaths[0] || '';
  });

  ipcMain.handle('mactowin:build', async (event, payload = {}) => {
    if (!payload || typeof payload !== 'object') throw new Error('转换请求参数无效');
    if (currentBuild) throw new Error('已有转换任务正在运行');
    const appInfo = payload.app;
    const analysis = payload.macAnalysis || appInfo?.macAnalysis;
    if (!analysis?.isElectron) throw new Error('当前只支持把 Electron 的 macOS 应用重组为 Windows 版');
    if (typeof analysis.path !== 'string' || !analysis.path.trim()) throw new Error('缺少 macOS 应用路径');
    const bundleStat = await fsp.stat(analysis.path).catch(() => null);
    if (!bundleStat?.isDirectory()) throw new Error('macOS 应用路径不存在或不是文件夹');
    if (payload.outputDir !== undefined && payload.outputDir !== null && typeof payload.outputDir !== 'string') throw new Error('输出目录无效');
    if (payload.manualElectronZip && typeof payload.manualElectronZip !== 'string') throw new Error('Electron 运行时压缩包路径无效');
    const settings = await readSettings();
    const outputDir = payload.outputDir || settings.outputDir;
    const sendProgress = (progress) => {
      if (!event.sender.isDestroyed()) event.sender.send('mactowin:progress', progress);
    };
    currentBuild = { startedAt: Date.now(), platform: 'windows' };
    try {
      sendProgress({ stage: 'start', message: '准备 Electron Windows 运行时…', percent: 0 });
      const runtime = await resolveElectronRuntime({
        version: payload.electronVersion || analysis.electronVersion,
        proxy: payload.proxy !== undefined ? payload.proxy : settings.proxy,
        manualZip: payload.manualElectronZip || '',
        onProgress: sendProgress,
      });
      const result = await assembleWindowsApp({
        analysis,
        electronDir: runtime.dir,
        outputDir,
        onProgress: sendProgress,
      });
      const buildId = `${analysis.bundleId || analysis.name}-win`.replace(/[^A-Za-z0-9._-]/g, '-');
      await recordBuildContext(buildId, {
        buildId,
        platform: 'windows',
        createdAt: new Date().toISOString(),
        app: { name: analysis.name, publisher: analysis.bundleId, version: analysis.version, installPath: analysis.path },
        macAnalysis: analysis,
        options: { outputDir, manualElectronZip: payload.manualElectronZip || '' },
        result: { folderPath: result.folderPath, zipPath: result.zipPath },
      });
      result.buildId = buildId;
      await appendHistory({
        createdAt: new Date().toISOString(),
        appName: analysis.name,
        publisher: analysis.bundleId,
        grade: analysis.grade,
        zipPath: result.zipPath,
        folderPath: result.folderPath,
        appPath: '',
        zipSize: result.zipSize,
        zipSha256: result.zipSha256,
        engineMode: 'electron',
        engineVersion: runtime.version,
        fileCount: result.fileCount,
        mode: 'mactowin',
        outputDir,
      }).catch(() => {});
      if (!event.sender.isDestroyed()) event.sender.send('mactowin:complete', result);
      return result;
    } catch (error) {
      if (!event.sender.isDestroyed()) event.sender.send('mactowin:error', { message: error.message });
      throw error;
    } finally {
      currentBuild = null;
    }
  });

  ipcMain.handle('dialog:engine-archive', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: '选择 macOS Wine 引擎压缩包',
      filters: [{ name: 'macOS Wine 引擎', extensions: ['xz'] }],
      properties: ['openFile'],
    });
    return result.canceled ? null : result.filePaths[0];
  });

  ipcMain.handle('apps:scan', async () => {
    send('scan:progress', { stage: 'start', message: '正在扫描已安装应用…' });
    const result = await runScanner({
      onProgress: (progress) => send('scan:progress', progress),
    });
    scanCache = result;
    send('scan:progress', { stage: 'done', message: `找到 ${result.apps.length} 个可转换应用` });
    if (!iconJob) {
      iconJob = buildIconCache(result.apps, { maxApps: 180 })
        .then((icons) => send('apps:icons', icons))
        .catch((error) => send('apps:icons', { __error: error.message }))
        .finally(() => {
          iconJob = null;
        });
    }
    return result;
  });

  ipcMain.handle('apps:analyze', async (_event, payload = {}) => {
    if (!payload || typeof payload !== 'object') throw new Error('分析请求参数无效');
    const appInfo = payload.app;
    if (!appInfo) throw new Error('缺少应用信息');
    const services = payload.services || scanCache?.services || [];
    const analysis = await analyzeApp(appInfo, {
      services,
      scanDirectory: true,
      maxFiles: payload.light ? 700 : 4000,
    });
    return analysis;
  });

  ipcMain.handle('apps:icons', async (_event, apps) => {
    if (!Array.isArray(apps)) return {};
    return buildIconCache(apps, { maxApps: 220 });
  });

  ipcMain.handle('build:start', async (event, payload = {}) => {
    if (!payload || typeof payload !== 'object') throw new Error('构建请求参数无效');
    if (currentBuild) throw new Error('已有转换任务正在运行');
    const appInfo = payload.app;
    if (!appInfo) throw new Error('缺少应用信息');
    if (appInfo.platform === 'mac') throw new Error('macOS 应用请使用「转换为 Windows 版」流程');
    const settings = await readSettings();
    const outputDir = payload.outputDir || settings.outputDir;
    await ensureDir(outputDir);
    currentBuild = { startedAt: Date.now() };
    try {
      const isInstaller = Boolean(payload.installer?.path);
      send('build:progress', { stage: 'start', message: isInstaller ? '开始准备安装器项目…' : '开始分析应用…', percent: 0 });
      const services = payload.services || scanCache?.services || [];
      const analysis = isInstaller
        ? (payload.analysis || defaultInstallerAnalysis(appInfo.name))
        : await analyzeApp(appInfo, { services });
      send('build:progress', { stage: 'analyzed', message: isInstaller ? '安装器模式 · 目标程序将在首次启动时安装' : `兼容性 ${analysis.grade} · ${analysis.gradeSummary}`, percent: 2 });
      const result = await buildBundle(
        {
          app: appInfo,
          analysis,
          services,
          installer: payload.installer || null,
          advanced: payload.advanced || {},
          outputDir,
          engineMode: payload.engineMode || settings.engineMode,
          manualEngineArchive: payload.manualEngineArchive || '',
          includeRuntimes: payload.includeRuntimes !== undefined ? Boolean(payload.includeRuntimes) : settings.includeRuntimes,
          includeWineMono: payload.includeWineMono !== undefined ? Boolean(payload.includeWineMono) : settings.includeWineMono,
          includeUserData: payload.includeUserData !== undefined ? Boolean(payload.includeUserData) : settings.includeUserData,
          proxy: payload.proxy !== undefined ? payload.proxy : settings.proxy,
        },
        (progress) => send('build:progress', progress),
      );
      try {
        await appendHistory({
          createdAt: result.createdAt,
          appName: appInfo.name,
          publisher: appInfo.publisher,
          grade: result.grade,
          zipPath: result.zipPath,
          folderPath: result.folderPath,
          appPath: result.appPath,
          zipSize: result.zipSize,
          zipSha256: result.zipSha256,
          engineMode: result.engine.mode,
          engineVersion: result.engine.version,
          fileCount: result.fileCount,
          mode: result.mode,
          outputDir,
        });
      } catch (historyError) {
        console.warn('Failed to save build history:', historyError.message);
      }
      try {
        await recordBuildContext(result.buildId || analysis.buildId, {
          buildId: result.buildId || analysis.buildId,
          platform: 'mac',
          createdAt: new Date().toISOString(),
          app: { name: appInfo.name, publisher: appInfo.publisher, version: appInfo.version, installPath: appInfo.installPath, exePath: appInfo.exePath },
          installer: payload.installer || null,
          analysis,
          options: {
            outputDir,
            engineMode: payload.engineMode || settings.engineMode,
            manualEngineArchive: payload.manualEngineArchive || '',
            includeRuntimes: payload.includeRuntimes !== undefined ? Boolean(payload.includeRuntimes) : settings.includeRuntimes,
            includeWineMono: payload.includeWineMono !== undefined ? Boolean(payload.includeWineMono) : settings.includeWineMono,
            includeUserData: payload.includeUserData !== undefined ? Boolean(payload.includeUserData) : settings.includeUserData,
            advanced: payload.advanced || {},
          },
          result: { appPath: result.appPath, zipPath: result.zipPath, folderPath: result.folderPath },
        });
      } catch (contextError) {
        console.warn('Failed to save build context:', contextError.message);
      }
      send('build:complete', result);
      return result;
    } catch (error) {
      send('build:error', { message: error.message });
      throw error;
    } finally {
      currentBuild = null;
    }
  });

  ipcMain.handle('shell:open', async (_event, target) => {
    assertString(target, '路径');
    const stat = await fsp.stat(target).catch(() => null);
    // shell.openPath 会执行任意可执行文件/脚本；UI 只需要打开构建产物与缓存目录。
    if (!stat?.isDirectory()) throw new Error('只能打开文件夹');
    return shell.openPath(target);
  });

  ipcMain.handle('shell:show', async (_event, target) => {
    assertString(target, '路径');
    shell.showItemInFolder(target);
    return true;
  });

  ipcMain.handle('shell:open-external', async (_event, url) => {
    if (!/^https?:\/\//i.test(String(url))) throw new Error('不支持的链接');
    await shell.openExternal(url);
    return true;
  });

  ipcMain.handle('diagnostics:run', async () => {
    const checks = [];
    const pinned = await loadPinnedEngine();
    checks.push({
      name: 'Windows PowerShell 5.1',
      status: fs.existsSync(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')) ? 'ok' : 'warn',
      detail: '用于扫描应用、提取图标与验证微软签名。',
    });
    checks.push({
      name: 'curl',
      status: fs.existsSync(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'curl.exe')) ? 'ok' : 'warn',
      detail: '用于下载 Wine 引擎与运行时；Windows 10 1803+ 自带。',
    });
    checks.push({
      name: 'Wine 引擎清单',
      status: pinned ? 'ok' : 'warn',
      detail: pinned ? `${pinned.name}（${pinned.sizeLabel}）` : '未找到固定引擎清单，将尝试在线获取。',
    });
    try {
      const stat = await fsp.statfs(appDataDir());
      const free = Number(stat.bavail) * Number(stat.bsize);
      checks.push({
        name: '磁盘可用空间',
        status: free > 2 * 1024 ** 3 ? 'ok' : 'warn',
        detail: `数据目录所在磁盘剩余 ${(free / 1024 ** 3).toFixed(1)} GB。`,
      });
    } catch {
      checks.push({ name: '磁盘可用空间', status: 'warn', detail: '无法读取。' });
    }
    return { checks, os: `${os.type()} ${os.release()}`, arch: os.arch() };
  });
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
  app.whenReady().then(async () => {
    Menu.setApplicationMenu(null);
    await ensureDir(appDataDir());
    setupIpc();
    createWindow();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
