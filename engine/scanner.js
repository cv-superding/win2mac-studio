'use strict';

const crypto = require('node:crypto');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { inspectPEHeader } = require('./pe');
const {
  ensureDir,
  isPathInside,
  nameSimilarity,
  normalizeForCompare,
  readJson,
  safeRemove,
  toPosix,
} = require('./util');

const POWERSHELL = process.env.SystemRoot
  ? path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  : 'powershell.exe';
const SCAN_SCRIPT = path.join(__dirname, '..', 'resources', 'scripts', 'scan-apps.ps1');

const BAD_SHORTCUT = /(uninstall|卸载|readme|read me|help|帮助|website|官网|update|updater|更新|manual|handbook|documentation|文档|sample|示例|license|许可|changelog)/i;
const BAD_EXE = /(unins[0-9a-z]*|uninstall|setup|installer|update|updater|crash|reporter|helper|elevate|notification|vc_redist|vcredist|dotnet|dxsetup|directx)\.exe$/i;
const JUNK_NAME = /(windows driver package|windows 驱动程序包|driver package|microsoft visual c\+\+|microsoft \.net|windows software development kit|windows sdk|npcap|anticheatexpert)/i;
const SKIP_LOCATIONS = [
  'C:\\Windows',
  'C:\\ProgramData\\Package Cache',
  'C:\\Program Files\\WindowsApps',
  'C:\\$Recycle.Bin',
];

function normalizeWinPath(value) {
  if (!value) return '';
  let p = String(value)
    .trim()
    .replace(/^"|"$/g, '')
    .replace(/\//g, '\\')
    .replace(/\\+$/, '');
  return p;
}

function isJunkApp(app) {
  if (!app?.name) return true;
  if (JUNK_NAME.test(app.name)) return true;
  if (app.installPath && isPathInside(app.installPath, 'C:\Windows')) return true;
  if (app.exePath && isPathInside(app.exePath, 'C:\Windows')) return true;
  if (/microsoft corporation/i.test(app.publisher || '') && /runtime|redistributable|update|service pack/i.test(app.name)) return true;
  return false;
}

function normalizedKey(value) {
  return normalizeForCompare(normalizeWinPath(value));
}

function stableId(input) {
  return crypto.createHash('sha1').update(input).digest('hex').slice(0, 12);
}

function shortcutIsBad(shortcut) {
  return BAD_SHORTCUT.test(shortcut.name || '') || BAD_SHORTCUT.test(path.basename(shortcut.lnkPath || ''));
}

function exeIsBad(exe) {
  return BAD_EXE.test(path.basename(exe || ''));
}

function shortcutScore(app, shortcut) {
  if (!shortcut?.target) return -100;
  if (exeIsBad(shortcut.target)) return -100;
  const targetInApp = isPathInside(shortcut.target, app.installLocation);
  const targetIsCandidate = (app.exeCandidates || []).some((c) => normalizedKey(c.path) === normalizedKey(shortcut.target));
  if (!targetInApp && !targetIsCandidate) return -100;
  let score = nameSimilarity(app.name, shortcut.name) * 55;
  if (targetInApp) score += 25;
  if (targetIsCandidate) score += 25;
  if (shortcutIsBad(shortcut)) score -= 90;
  return score;
}

function pickShortcut(app, shortcuts) {
  let best = null;
  let bestScore = 20;
  for (const shortcut of shortcuts) {
    const score = shortcutScore(app, shortcut);
    if (score > bestScore) {
      best = shortcut;
      bestScore = score;
    }
  }
  return { shortcut: best, score: bestScore };
}

async function pickBestCandidate(candidates) {
  const sorted = [...(candidates || [])].sort((a, b) => (b.score || 0) - (a.score || 0));
  let fallback = sorted[0] || null;
  for (const candidate of sorted.slice(0, 6)) {
    if (!candidate.path || exeIsBad(candidate.path)) continue;
    const pe = await inspectPEHeader(candidate.path);
    if (pe.ok && pe.subsystem === 'gui' && pe.arch !== 'unknown') return { candidate, pe };
  }
  if (fallback) {
    const pe = await inspectPEHeader(fallback.path);
    return { candidate: fallback, pe };
  }
  return { candidate: null, pe: null };
}

function shouldSkipPortableShortcut(shortcut) {
  const normalized = normalizeWinPath(shortcut?.target || '');
  const name = String(shortcut?.name || '');
  if (!normalized || exeIsBad(normalized)) return true;
  if (/^(windows |wsl$|wsl settings|windows install clean up|add a new .*adapter)/i.test(name)) return true;
  if (SKIP_LOCATIONS.some((location) => isPathInside(normalized, location))) return true;
  if (isPathInside(normalized, 'C:\\Program Files\\Windows Kits') || isPathInside(normalized, 'C:\\Program Files (x86)\\Windows Kits')) return true;
  if (isPathInside(normalized, 'C:\\Program Files\\WSL') || isPathInside(normalized, 'C:\\Program Files (x86)\\Windows Media Player')) return true;
  if (/(\\AppData\\Local\\Temp\\|\\Downloads\\)/i.test(normalized)) return true;
  return false;
}

async function mergeScan(raw, options = {}) {
  const shortcuts = (raw.shortcuts || []).map((item) => ({
    ...item,
    target: normalizeWinPath(item.target),
    workingDirectory: normalizeWinPath(item.workingDirectory),
  }));
  const services = raw.services || [];
  const apps = [];
  const seenExe = new Set();

  for (const rawApp of raw.apps || []) {
    const installLocation = normalizeWinPath(rawApp.installLocation);
    const app = {
      id: '',
      name: String(rawApp.name || '').trim(),
      publisher: String(rawApp.publisher || '').trim(),
      version: String(rawApp.version || '').trim(),
      installDate: String(rawApp.installDate || ''),
      installPath: installLocation,
      exePath: normalizeWinPath(rawApp.exe),
      exeCandidates: rawApp.exeCandidates || [],
      displayIcon: normalizeWinPath(rawApp.displayIcon),
      displayIconRaw: rawApp.displayIconRaw || '',
      uninstallString: rawApp.uninstallString || '',
      estimatedSizeBytes: Number(rawApp.estimatedSizeBytes) || 0,
      registryKeys: rawApp.registryKey ? [rawApp.registryKey] : [],
      registryHive: rawApp.registryHive || '',
      source: 'registry',
      url: rawApp.url || '',
      launchArgs: '',
      workingDirectory: '',
      shortcut: null,
      arch: 'unknown',
      archLabel: '未知',
      bits: 0,
      isDotNet: false,
      warnings: [],
    };
    if (!app.name || !app.installPath) {
      if (!app.exePath) continue;
      app.installPath = path.win32.dirname(app.exePath);
    }
    if (isJunkApp(app)) continue;
    if (SKIP_LOCATIONS.some((location) => isPathInside(app.installPath, location))) continue;

    const { shortcut } = pickShortcut(app, shortcuts);
    let chosenPath = shortcut?.target || app.exePath;
    let pe = null;

    if (chosenPath) {
      pe = await inspectPEHeader(chosenPath);
    }
    if ((!shortcut || !pe?.ok || pe.subsystem !== 'gui') && app.exeCandidates?.length) {
      const best = await pickBestCandidate(app.exeCandidates);
      if (!shortcut && best.candidate) {
        chosenPath = best.candidate.path;
        pe = best.pe;
      } else if (best.pe?.subsystem === 'gui' && !pe?.ok) {
        chosenPath = best.candidate.path;
        pe = best.pe;
      }
    }

    app.exePath = normalizeWinPath(chosenPath);
    if (!app.exePath) {
      app.warnings.push('未找到主程序');
    }
    if (shortcut) {
      app.shortcut = {
        name: shortcut.name,
        target: shortcut.target,
        arguments: shortcut.arguments || '',
        workingDirectory: shortcut.workingDirectory || '',
        lnkPath: shortcut.lnkPath,
      };
      app.launchArgs = shortcut.arguments || '';
      if (shortcut.workingDirectory && !isPathInside(shortcut.workingDirectory, app.installPath)) {
        app.externalWorkingDirectory = shortcut.workingDirectory;
      }
      app.workingDirectory =
        shortcut.workingDirectory && isPathInside(shortcut.workingDirectory, app.installPath)
          ? shortcut.workingDirectory
          : path.win32.dirname(app.exePath || shortcut.target);
    } else if (app.exePath) {
      app.workingDirectory = path.win32.dirname(app.exePath);
    }
    if (!app.installPath && app.exePath) app.installPath = path.win32.dirname(app.exePath);
    app.arch = pe?.arch || 'unknown';
    app.archLabel = pe?.machineLabel || '未知';
    app.bits = pe?.bits || 0;
    app.isDotNet = Boolean(pe?.isDotNet);

    const key = normalizedKey(app.exePath || app.installPath || app.name);
    if (seenExe.has(key)) {
      const existing = apps.find((item) => item._key === key);
      if (existing) {
        existing.registryKeys = [...new Set([...(existing.registryKeys || []), ...app.registryKeys])];
        if (!existing.publisher && app.publisher) existing.publisher = app.publisher;
        if (!existing.version && app.version) existing.version = app.version;
        continue;
      }
    }
    seenExe.add(key);
    app._key = key;
    app.id = `app-${stableId(`${app.name}|${app.exePath}|${app.registryKeys.join(',')}`)}`;
    apps.push(app);
  }

  const knownPaths = apps.flatMap((app) => [app.installPath, app.exePath]).filter(Boolean);
  const portable = [];
  for (const shortcut of shortcuts) {
    if (shouldSkipPortableShortcut(shortcut)) continue;
    if (knownPaths.some((known) => isPathInside(shortcut.target, known))) continue;
    if (portable.some((item) => normalizedKey(item.exePath) === normalizedKey(shortcut.target))) continue;
    const pe = await inspectPEHeader(shortcut.target);
    if (!pe.ok) continue;
    const app = {
      id: `app-${stableId(`shortcut|${shortcut.target}`)}`,
      name: shortcut.name || path.win32.basename(shortcut.target, '.exe'),
      publisher: '',
      version: '',
      installDate: '',
      installPath: path.win32.dirname(shortcut.target),
      exePath: shortcut.target,
      displayIcon: shortcut.iconLocation ? normalizeWinPath(shortcut.iconLocation.replace(/,\d+$/, '')) : shortcut.target,
      uninstallString: '',
      estimatedSizeBytes: 0,
      registryKeys: [],
      source: 'shortcut',
      url: '',
      launchArgs: shortcut.arguments || '',
      workingDirectory: shortcut.workingDirectory || path.win32.dirname(shortcut.target),
      shortcut: {
        name: shortcut.name,
        target: shortcut.target,
        arguments: shortcut.arguments || '',
        workingDirectory: shortcut.workingDirectory || '',
        lnkPath: shortcut.lnkPath,
      },
      arch: pe.arch,
      archLabel: pe.machineLabel,
      bits: pe.bits,
      isDotNet: Boolean(pe.isDotNet),
      warnings: ['此应用来自开始菜单快捷方式，未找到卸载登记信息。'],
    };
    portable.push(app);
    if (portable.length >= (options.maxPortable || 60)) break;
  }

  const all = [...apps, ...portable]
    .filter((app) => app.name && app.exePath)
    .map(({ _key, ...app }) => app)
    .sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));

  return {
    os: raw.os || {},
    computerName: raw.computerName || '',
    generatedAt: raw.generatedAt || new Date().toISOString(),
    apps: all,
    services,
    shortcutCount: shortcuts.length,
    warnings: options.warnings || [],
  };
}

async function runScanner(options = {}) {
  if (process.platform !== 'win32') {
    throw new Error('应用扫描只能在 Windows 上运行');
  }
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'win2mac-scan-'));
  const outputFile = path.join(tempDir, 'apps.json');
  try {
    if (options.onProgress) options.onProgress({ stage: 'powershell', message: '正在读取注册表、开始菜单与服务…' });
    const result = await new Promise((resolve, reject) => {
      const child = spawn(
        POWERSHELL,
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', SCAN_SCRIPT, '-OutputPath', outputFile],
        { windowsHide: true, timeout: options.timeout || 240000 },
      );
      let stderr = '';
      child.stderr.on('data', (chunk) => {
        stderr += chunk.toString('utf8');
      });
      child.on('error', reject);
      child.on('close', (code) => {
        if (code !== 0) {
          reject(new Error(`扫描脚本退出码 ${code}：${stderr.trim().slice(-800)}`));
        } else {
          resolve();
        }
      });
    });
    void result;
    const raw = await readJson(outputFile);
    if (raw.ok === false) throw new Error(raw.error || '扫描失败');
    if (options.onProgress) options.onProgress({ stage: 'merge', message: '正在匹配主程序与快捷方式…' });
    const merged = await mergeScan(raw, options);
    merged.scannedAt = new Date().toISOString();
    return merged;
  } finally {
    await safeRemove(tempDir);
  }
}

function analyzePortableTarget(exePath, nameOverride) {
  return {
    id: `app-${stableId(`manual|${normalizeWinPath(exePath)}`)}`,
    name: nameOverride || path.win32.basename(exePath, path.win32.extname(exePath)),
    publisher: '',
    version: '',
    installPath: path.win32.dirname(normalizeWinPath(exePath)),
    exePath: normalizeWinPath(exePath),
    displayIcon: normalizeWinPath(exePath),
    uninstallString: '',
    estimatedSizeBytes: 0,
    registryKeys: [],
    source: 'manual',
    launchArgs: '',
    workingDirectory: path.win32.dirname(normalizeWinPath(exePath)),
    arch: 'unknown',
    archLabel: '未知',
    bits: 0,
    isDotNet: false,
    warnings: [],
  };
}

module.exports = {
  runScanner,
  isJunkApp,
  mergeScan,
  pickShortcut,
  shortcutScore,
  normalizeWinPath,
  analyzePortableTarget,
  POWERSHELL,
  toPosix,
  ensureDir,
};
