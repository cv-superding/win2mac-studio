'use strict';

const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { ensureDir, isPathInside, safeRemove } = require('./util');

const STAGING_PREFIXES = ['win2mac-build-'];
const MAX_MEASURE_ENTRIES = 40000;

function localRoot() {
  const base = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  return path.join(base, 'Win2Mac');
}

function cachePaths() {
  return {
    engines: path.join(localRoot(), 'engines'),
    runtimes: path.join(localRoot(), 'runtimes'),
    stagingRoot: os.tmpdir(),
  };
}

async function measureDirectory(root, { maxEntries = MAX_MEASURE_ENTRIES } = {}) {
  const result = { exists: false, files: 0, bytes: 0, truncated: false };
  let entries = 0;
  try {
    const stat = await fsp.stat(root);
    if (!stat.isDirectory()) return result;
  } catch {
    return result;
  }
  result.exists = true;
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let handle;
    try {
      handle = await fsp.opendir(dir);
    } catch {
      continue;
    }
    for await (const entry of handle) {
      entries += 1;
      if (entries > maxEntries) {
        result.truncated = true;
        break;
      }
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (!entry.isFile()) continue;
      try {
        const stat = await fsp.lstat(full);
        result.files += 1;
        result.bytes += stat.size;
      } catch {
        /* file vanished during measurement */
      }
    }
    if (entries > maxEntries) break;
  }
  return result;
}

async function stagingEntries() {
  const root = os.tmpdir();
  let names = [];
  try {
    names = await fsp.readdir(root);
  } catch {
    return { root, entries: [], bytes: 0, files: 0 };
  }
  const entries = [];
  let bytes = 0;
  let files = 0;
  for (const name of names) {
    if (!STAGING_PREFIXES.some((prefix) => name.startsWith(prefix))) continue;
    const full = path.join(root, name);
    const stat = await fsp.lstat(full).catch(() => null);
    if (!stat?.isDirectory() || stat.isSymbolicLink()) continue;
    const measured = await measureDirectory(full);
    entries.push({ path: full, ...measured });
    bytes += measured.bytes;
    files += measured.files;
  }
  return { root, entries, bytes, files };
}

async function collectCacheStats() {
  const paths = cachePaths();
  const [engines, runtimes, staging] = await Promise.all([
    measureDirectory(paths.engines),
    measureDirectory(paths.runtimes),
    stagingEntries(),
  ]);
  const groups = [
    {
      key: 'engines',
      label: 'Wine 引擎缓存',
      hint: '下载或手动选择的 tar.xz；重新构建内置引擎时复用。',
      path: paths.engines,
      kind: 'directory',
      ...engines,
    },
    {
      key: 'runtimes',
      label: '运行库缓存',
      hint: 'VC++ 与 Wine Mono 安装包；下次打包无需重新下载。',
      path: paths.runtimes,
      kind: 'directory',
      ...runtimes,
    },
    {
      key: 'staging',
      label: '临时构建目录',
      hint: '异常中断遗留的半成品；正常完成后会自动清理。',
      path: staging.root,
      kind: 'staging',
      exists: staging.entries.length > 0,
      files: staging.files,
      bytes: staging.bytes,
      truncated: staging.entries.some((entry) => entry.truncated),
      entries: staging.entries.map(({ path: entryPath, files: entryFiles, bytes: entryBytes }) => ({ path: entryPath, files: entryFiles, bytes: entryBytes })),
    },
  ];
  return {
    groups,
    totalBytes: groups.reduce((sum, group) => sum + group.bytes, 0),
    totalFiles: groups.reduce((sum, group) => sum + group.files, 0),
    measuredAt: new Date().toISOString(),
  };
}

function assertCacheTarget(key, target, paths) {
  const resolved = path.resolve(target);
  if (key === 'staging') {
    if (path.dirname(resolved).toLowerCase() !== path.resolve(paths.stagingRoot).toLowerCase()) {
      throw new Error('临时目录不在系统临时目录内，已拒绝清理');
    }
    const name = path.basename(resolved);
    if (!STAGING_PREFIXES.some((prefix) => name.startsWith(prefix))) {
      throw new Error('临时目录名不匹配 Win2Mac 规则，已拒绝清理');
    }
    return resolved;
  }
  const allowed = key === 'engines' ? paths.engines : key === 'runtimes' ? paths.runtimes : '';
  if (!allowed || !isPathInside(resolved, allowed)) throw new Error('缓存目录不在允许范围内，已拒绝清理');
  return resolved;
}

async function clearCaches(keys = []) {
  const allowedKeys = new Set(['engines', 'runtimes', 'staging']);
  const selected = [...new Set(keys)].filter((key) => allowedKeys.has(key));
  if (!selected.length) throw new Error('没有选择可清理的缓存');
  const paths = cachePaths();
  const before = await collectCacheStats();
  const beforeByKey = new Map(before.groups.map((group) => [group.key, group]));
  let clearedBytes = 0;
  let clearedFiles = 0;
  for (const key of selected) {
    const group = beforeByKey.get(key);
    if (!group) continue;
    if (key === 'staging') {
      const staging = await stagingEntries();
      for (const entry of staging.entries) {
        const target = assertCacheTarget(key, entry.path, paths);
        await safeRemove(target);
        clearedBytes += entry.bytes;
        clearedFiles += entry.files;
      }
      continue;
    }
    const target = assertCacheTarget(key, group.path, paths);
    await safeRemove(target);
    await ensureDir(target);
    clearedBytes += group.bytes;
    clearedFiles += group.files;
  }
  const stats = await collectCacheStats();
  return { clearedBytes, clearedFiles, stats };
}

module.exports = {
  cachePaths,
  collectCacheStats,
  clearCaches,
  measureDirectory,
  stagingEntries,
};
