'use strict';

const fsp = require('node:fs/promises');
const path = require('node:path');
const { nameSimilarity } = require('./util');

const MAX_ENTRIES = 6000;
const MAX_DEPTH = 3;
const SKIP_DIRS = new Set([
  '$recycle.bin',
  'system volume information',
  'windows',
  'winsxs',
  'node_modules',
  '.git',
  'cache',
  'caches',
  'temp',
  'tmp',
  'logs',
]);
const HARD_EXCLUDE = /(^|[\s._-])(unins[0-9a-z]*|uninstall(?:er)?|setup|installer|install|update|updater|crash|reporter|vc_?redist|vcredist|dotnet|dxsetup|directx|elevate|notification)([\s._-]|$)/i;
const SOFT_PENALTY = /(helper|service|servicectl|register|config|settings|unpack|extract|diagnostic|report|benchmark)\.exe$/i;

function isUnwantedExe(filePath) {
  const base = path.win32.basename(filePath);
  return /uninstall|unins/i.test(base)
    || /卸载|安装程序/.test(base)
    || HARD_EXCLUDE.test(base);
}

function candidateScore(entry, folderName) {
  const base = path.win32.basename(entry.path, path.win32.extname(entry.path));
  let score = nameSimilarity(folderName, base) * 120;
  score -= entry.depth * 14;
  score += Math.min(22, Math.log10(entry.size + 10) * 4);
  if (entry.depth === 0) score += 8;
  if (SOFT_PENALTY.test(entry.path)) score -= 35;
  return score;
}

function rankCandidates(candidates, folderName) {
  return candidates
    .filter((entry) => !isUnwantedExe(entry.path))
    .map((entry) => ({ ...entry, score: candidateScore(entry, folderName) }))
    .sort((a, b) => b.score - a.score || b.size - a.size);
}

async function collectExeCandidates(root) {
  const candidates = [];
  let entriesSeen = 0;
  let truncated = false;
  async function walk(dir, depth) {
    if (entriesSeen >= MAX_ENTRIES) {
      truncated = true;
      return;
    }
    let handle;
    try {
      handle = await fsp.opendir(dir);
    } catch {
      return;
    }
    for await (const entry of handle) {
      entriesSeen += 1;
      if (entriesSeen >= MAX_ENTRIES) {
        truncated = true;
        break;
      }
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (depth >= MAX_DEPTH || SKIP_DIRS.has(entry.name.toLowerCase())) continue;
        await walk(full, depth + 1);
        continue;
      }
      if (!entry.isFile() || !/\.exe$/i.test(entry.name)) continue;
      let size = 0;
      try {
        size = (await fsp.stat(full)).size;
      } catch {
        continue;
      }
      if (size < 4096) continue;
      candidates.push({ path: full, size, depth });
    }
  }
  await walk(root, 0);
  return { candidates, truncated };
}

async function resolveDroppedFolder(folder, { nameOverride = '' } = {}) {
  const stat = await fsp.stat(folder).catch(() => null);
  if (!stat?.isDirectory()) throw new Error('拖入的文件夹不存在');
  const abs = path.resolve(folder);
  const folderName = nameOverride || path.basename(abs);
  const { candidates, truncated } = await collectExeCandidates(abs);
  if (!candidates.length) {
    throw new Error(truncated
      ? '在文件夹中扫描了过多文件，尚未找到 .exe。请直接拖入主程序或缩小文件夹范围。'
      : '这个文件夹中没有找到可执行的 .exe，请直接拖入主程序。');
  }
  const ranked = rankCandidates(candidates, folderName);
  if (!ranked.length) {
    throw new Error('文件夹里只找到安装器/卸载器/运行库，请直接拖入主程序。');
  }
  return {
    folder: abs,
    exePath: ranked[0].path,
    candidates: ranked.slice(0, 12).map(({ path: candidatePath, size, depth, score }) => ({ path: candidatePath, size, depth, score: Math.round(score) })),
    truncated,
  };
}

function looksLikeInstallerName(file) {
  return /(^|[\s._-])(setup|installer|install|webinstall|web-setup|bundle|offline)([\s._-]|$)/i.test(path.basename(file, path.extname(file)));
}

function classifyDroppedPath(target) {
  const ext = path.extname(target).toLowerCase();
  if (ext === '.msi') return { kind: 'installer', type: 'msi' };
  if (ext === '.zip') return { kind: 'zip' };
  if (ext === '.exe') return { kind: 'exe', suspiciousInstaller: looksLikeInstallerName(target) };
  return { kind: 'unsupported' };
}

module.exports = {
  MAX_ENTRIES,
  MAX_DEPTH,
  rankCandidates,
  isUnwantedExe,
  collectExeCandidates,
  resolveDroppedFolder,
  looksLikeInstallerName,
  classifyDroppedPath,
};
