'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { buildIcns } = require('./icns');
const { ensureDir, safeRemove } = require('./util');

const POWERSHELL = process.env.SystemRoot
  ? path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  : 'powershell.exe';

const SCRIPT = path.join(__dirname, '..', 'resources', 'scripts', 'extract-icons.ps1');

function runPowerShell(args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(POWERSHELL, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT, ...args], {
      windowsHide: true,
      timeout: options.timeout || 240000,
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`图标提取失败 (PowerShell exit ${code}) ${stderr.trim().slice(-800)}`));
      } else {
        resolve();
      }
    });
  });
}

async function runExtraction(tasks, sizes, outDir) {
  await ensureDir(outDir);
  const tasksFile = path.join(outDir, 'tasks.json');
  await fsp.writeFile(tasksFile, JSON.stringify(tasks), 'utf8');
  await runPowerShell([
    '-TasksPath',
    tasksFile,
    '-OutputDir',
    outDir,
    '-Sizes',
    sizes.join(','),
  ]);
  const resultFile = path.join(outDir, 'icons.json');
  const raw = JSON.parse((await fsp.readFile(resultFile, 'utf8')).replace(/^\uFEFF/, ''));
  return Array.isArray(raw) ? raw : [raw];
}

function normalizeExePath(value) {
  return String(value || '')
    .replace(/\//g, '\\')
    .replace(/^"|"$/g, '');
}

function cacheRoot() {
  const base = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  return path.join(base, 'Win2Mac', 'icon-cache');
}

function cacheKeyFor(exe) {
  try {
    const st = fs.statSync(exe);
    return crypto
      .createHash('sha1')
      .update(`${normalizeExePath(exe).toLowerCase()}|${st.size}|${Math.trunc(st.mtimeMs)}`)
      .digest('hex');
  } catch {
    return crypto.createHash('sha1').update(normalizeExePath(exe).toLowerCase()).digest('hex');
  }
}

async function extractIconFiles({ exe, name, sizes = [16, 32, 64, 128, 256, 512], outDir }) {
  const directory = outDir || path.join(cacheRoot(), `icon-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const [result] = await runExtraction(
    [{ id: 'app', exe: normalizeExePath(exe), text: name || 'W' }],
    sizes,
    directory,
  );
  if (!result?.success) throw new Error(result?.error || '未知图标提取错误');
  const bySize = {};
  for (const file of result.files || []) {
    const match = path.basename(file).match(/_(\d+)\.png$/);
    if (!match) continue;
    bySize[Number(match[1])] = await fsp.readFile(file);
  }
  return {
    directory,
    source: result.source,
    master: result.master,
    bySize,
    icns: buildIcns(bySize),
  };
}

async function buildAppIcon({ exe, name, workDir }) {
  const outDir = path.join(workDir, 'icon');
  await ensureDir(outDir);
  const extracted = await extractIconFiles({
    exe: normalizeExePath(exe),
    name,
    sizes: [16, 32, 64, 128, 256, 512],
    outDir,
  });
  return extracted;
}

async function buildIconCache(apps, options = {}) {
  const root = cacheRoot();
  await ensureDir(root);
  const output = new Map();
  const pending = [];
  const maxApps = options.maxApps || 160;

  for (const app of apps.slice(0, maxApps)) {
    const exe = normalizeExePath(app.displayIcon?.endsWith('.exe') ? app.displayIcon : app.exe || app.exePath || app.displayIcon);
    if (!exe) continue;
    const key = cacheKeyFor(exe);
    const cached = path.join(root, `${key}_64.png`);
    if (fs.existsSync(cached)) {
      output.set(app.id, { dataUrl: `data:image/png;base64,${(await fsp.readFile(cached)).toString('base64')}`, source: 'cache' });
    } else {
      pending.push({ app, exe, key, cached });
    }
  }

  if (pending.length) {
    const workDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'win2mac-icons-'));
    try {
      const results = await runExtraction(
        pending.map((item, index) => ({ id: `i${index}`, exe: item.exe, text: item.app.name || 'W' })),
        [64],
        workDir,
      );
      const byId = new Map(results.map((item) => [item.id, item]));
      for (let i = 0; i < pending.length; i += 1) {
        const item = pending[i];
        const result = byId.get(`i${i}`);
        if (!result?.success || !result.files?.length) continue;
        const png = await fsp.readFile(result.files[0]);
        await fsp.writeFile(item.cached, png);
        output.set(item.app.id, {
          dataUrl: `data:image/png;base64,${png.toString('base64')}`,
          source: result.source,
        });
      }
    } finally {
      await safeRemove(workDir);
    }
  }

  return Object.fromEntries(output);
}

module.exports = {
  buildAppIcon,
  buildIconCache,
  extractIconFiles,
  cacheKeyFor,
  cacheRoot,
  normalizeExePath,
  POWERSHELL,
};
