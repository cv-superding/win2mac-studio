'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { pipeline } = require('node:stream/promises');
const yauzl = require('yauzl');
const { isPathInside, safeRemove } = require('./util');

const MAX_ARCHIVE_BYTES = 8 * 1024 ** 3;
const MAX_EXTRACTED_BYTES = 8 * 1024 ** 3;
const MAX_FILES = 200000;
const MAX_ENTRY_PATH = 900;

function openZip(file) {
  return new Promise((resolve, reject) => {
    yauzl.open(file, { lazyEntries: true, autoClose: true, decodeStrings: true }, (error, zip) => {
      if (error) reject(error);
      else resolve(zip);
    });
  });
}

function openEntryStream(zip, entry) {
  return new Promise((resolve, reject) => {
    zip.openReadStream(entry, (error, stream) => {
      if (error) reject(error);
      else resolve(stream);
    });
  });
}

function safeEntryPath(name) {
  const normalized = String(name || '').replace(/\\/g, '/');
  if (!normalized || normalized.length > MAX_ENTRY_PATH) return null;
  if (normalized.startsWith('/') || normalized.startsWith('//')) return null;
  if (/^[a-zA-Z]:/.test(normalized)) return null;
  if (normalized.split('/').some((part) => part === '..' || part.includes(':') || part.includes(String.fromCharCode(0)))) return null;
  const clean = path.posix.normalize(normalized).replace(/^\.\/+/, '');
  if (!clean || clean === '.' || clean.startsWith('../')) return null;
  return clean;
}

async function extractZip(file, destination, { onProgress } = {}) {
  const stat = await fsp.stat(file).catch(() => null);
  if (!stat?.isFile()) throw new Error('压缩包不存在或不是文件');
  if (stat.size > MAX_ARCHIVE_BYTES) throw new Error('压缩包超过 8 GB，暂不支持导入');
  await fsp.mkdir(destination, { recursive: true });
  const root = path.resolve(destination);
  const zip = await openZip(file);
  let files = 0;
  let bytes = 0;
  let entries = 0;
  let settled = false;

  return new Promise((resolve, reject) => {
    const fail = async (error) => {
      if (settled) return;
      settled = true;
      try { zip.close(); } catch { /* already closed */ }
      await safeRemove(root).catch(() => {});
      reject(error);
    };

    zip.on('error', fail);
    zip.on('end', () => {
      if (settled) return;
      settled = true;
      resolve({ root, files, bytes });
    });
    zip.on('entry', async (entry) => {
      if (settled) return;
      try {
        entries += 1;
        if (entries > MAX_FILES) throw new Error(`压缩包文件数超过 ${MAX_FILES.toLocaleString('zh-CN')}，暂不支持导入`);
        if (entry.generalPurposeBitFlag & 0x1) throw new Error(`压缩包包含加密文件：${entry.fileName}`);
        const mode = (entry.externalFileAttributes >>> 16) & 0o170000;
        if (mode === 0o120000) throw new Error(`压缩包包含符号链接，已拒绝解压：${entry.fileName}`);
        const rel = safeEntryPath(entry.fileName);
        if (!rel) throw new Error(`压缩包包含不安全路径，已拒绝解压：${entry.fileName}`);
        const target = path.resolve(root, ...rel.split('/'));
        if (!isPathInside(target, root)) throw new Error(`压缩包路径越界，已拒绝解压：${entry.fileName}`);
        if (/\/$/.test(entry.fileName) || entry.fileName.endsWith('\\')) {
          await fsp.mkdir(target, { recursive: true });
          zip.readEntry();
          return;
        }
        bytes += Number(entry.uncompressedSize) || 0;
        if (bytes > MAX_EXTRACTED_BYTES) throw new Error('解压后体积超过 8 GB，暂不支持导入');
        await fsp.mkdir(path.dirname(target), { recursive: true });
        const stream = await openEntryStream(zip, entry);
        await pipeline(stream, fs.createWriteStream(target));
        files += 1;
        if (onProgress) onProgress({ files, bytes, current: rel });
        zip.readEntry();
      } catch (error) {
        fail(error);
      }
    });
    zip.readEntry();
  });
}

async function findAppRoot(extractedRoot) {
  const entries = await fsp.readdir(extractedRoot, { withFileTypes: true });
  const dirs = entries.filter((entry) => entry.isDirectory() && !entry.isSymbolicLink());
  const files = entries.filter((entry) => entry.isFile());
  if (dirs.length === 1 && files.length === 0) {
    return path.join(extractedRoot, dirs[0].name);
  }
  const { resolveDroppedFolder } = require('./drop');
  const resolved = await resolveDroppedFolder(extractedRoot);
  const relative = path.relative(extractedRoot, resolved.exePath);
  const top = relative.split(path.sep)[0];
  const topDir = dirs.find((entry) => entry.name === top);
  return topDir ? path.join(extractedRoot, topDir.name) : extractedRoot;
}

module.exports = {
  MAX_ARCHIVE_BYTES,
  MAX_EXTRACTED_BYTES,
  MAX_FILES,
  extractZip,
  findAppRoot,
  safeEntryPath,
};
