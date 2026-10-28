'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

const INVALID_FILENAME = /[<>:"/\\|?*\u0000-\u001f]/g;

function sanitizeFilename(input, fallback = 'WindowsApp') {
  let name = String(input || '')
    .replace(INVALID_FILENAME, ' ')
    .replace(/\s+/g, ' ')
    .replace(/[. ]+$/g, '')
    .trim();
  if (!name) name = fallback;
  if (name.length > 80) name = name.slice(0, 80).trim();
  return name;
}

function slugify(input, fallback = 'app') {
  const slug = String(input || '')
    .normalize('NFKD')
    .replace(/[^\w.-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-_.]+|[-_.]+$/g, '')
    .toLowerCase();
  return (slug || fallback).slice(0, 60);
}

function bundleIdentifier(name, publisher, installPath = '') {
  const slug = slugify(`${publisher || 'app'}-${name || 'app'}`, 'app');
  const hash = crypto
    .createHash('sha1')
    .update(`${name}|${publisher}|${installPath}`)
    .digest('hex')
    .slice(0, 8);
  return `com.win2mac.${slug.replace(/^[-_.]+|[-_.]+$/g, '') || 'app'}.${hash}`;
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function xmlEscape(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(file);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

async function pathExists(p) {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}

async function ensureDir(p) {
  await fsp.mkdir(p, { recursive: true });
  return p;
}

async function safeRemove(p) {
  if (!p) return;
  await fsp.rm(p, { recursive: true, force: true, maxRetries: 2 });
}

function splitWindowsPath(winPath) {
  if (!winPath) return null;
  let p = String(winPath).trim().replace(/^"|"$/g, '');
  if (/^[a-zA-Z]:[\\/]/.test(p)) {
    const drive = p[0].toUpperCase();
    const rest = p.slice(2).replace(/^[\\/]+/, '').replace(/\\/g, '/');
    return { drive, rest };
  }
  if (p.startsWith('\\\\')) {
    return { drive: 'UNC', rest: p.replace(/^\\\\/, '').replace(/\\/g, '/') };
  }
  return null;
}

function payloadRelativeForWindowsPath(winPath) {
  const parts = splitWindowsPath(winPath);
  if (!parts) throw new Error(`Not an absolute Windows path: ${winPath}`);
  if (parts.drive === 'UNC') {
    return path.posix.join('UNC', parts.rest);
  }
  return path.posix.join(parts.drive, parts.rest);
}

function windowsPathForPayload(winPath) {
  const parts = splitWindowsPath(winPath);
  if (!parts) return winPath;
  if (parts.drive === 'UNC') return `\\\\${parts.rest.replace(/\//g, '\\')}`;
  return `${parts.drive}:\\${parts.rest.replace(/\//g, '\\')}`;
}

function normalizeForCompare(p) {
  return String(p || '')
    .replace(/\\/g, '/')
    .replace(/\/+/g, '/')
    .replace(/\/$/, '')
    .toLowerCase();
}

function isPathInside(child, parent) {
  const c = normalizeForCompare(child);
  const p = normalizeForCompare(parent);
  if (!c || !p) return false;
  return c === p || c.startsWith(`${p}/`);
}

function relativeInside(child, parent) {
  if (!isPathInside(child, parent)) return null;
  const c = path.resolve(child);
  const p = path.resolve(parent);
  let rel = path.relative(p, c);
  if (rel === '') rel = '.';
  return rel;
}

function nameSimilarity(a, b) {
  const norm = (s) =>
    String(s || '')
      .toLowerCase()
      .replace(/\b(19|20)\d{2}\b/g, '')
      .replace(/\b(x64|x86|64-bit|32-bit|setup|installer|launcher|client|app|application)\b/g, '')
      .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '');
  const x = norm(a);
  const y = norm(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  if (x.includes(y) || y.includes(x)) {
    return Math.min(x.length, y.length) / Math.max(x.length, y.length);
  }
  let common = 0;
  const setB = new Set(y);
  for (const ch of new Set(x)) if (setB.has(ch)) common += 1;
  return common / Math.max(new Set(x).size, setB.size);
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** i;
  return `${value >= 10 || i === 0 ? Math.round(value) : value.toFixed(1)} ${units[i]}`;
}

async function readJson(file) {
  const raw = await fsp.readFile(file, 'utf8');
  return JSON.parse(raw.replace(/^\uFEFF/, ''));
}

async function writeJson(file, value) {
  await ensureDir(path.dirname(file));
  await fsp.writeFile(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function walkFiles(root, options = {}) {
  const { maxFiles = 200000, onFile = null, skipReparse = true } = options;
  const files = [];
  const warnings = [];
  const visited = new Set();
  let truncated = false;

  async function walk(dir) {
    let real;
    try {
      real = await fsp.realpath(dir);
    } catch (error) {
      warnings.push({ path: dir, message: `无法解析目录：${error.message}` });
      return;
    }
    if (visited.has(real)) return;
    visited.add(real);

    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch (error) {
      warnings.push({ path: dir, message: `无法读取目录：${error.message}` });
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
    for (const entry of entries) {
      if (files.length >= maxFiles) {
        truncated = true;
        return;
      }
      const full = path.join(dir, entry.name);
      let st;
      try {
        st = await fsp.lstat(full);
      } catch (error) {
        warnings.push({ path: full, message: `无法读取文件信息：${error.message}` });
        continue;
      }
      if (entry.isSymbolicLink() || st.isSymbolicLink()) {
        warnings.push({ path: full, message: '已跳过符号链接/目录联接' });
        continue;
      }
      if (st.isDirectory()) {
        await walk(full);
      } else if (st.isFile()) {
        const item = { path: full, size: st.size, mtime: st.mtime, mode: st.mode };
        files.push(item);
        if (onFile) onFile(item, files.length);
      }
    }
  }

  await walk(root);
  if (truncated) warnings.push({ path: root, message: `文件数量超过 ${maxFiles}，已截断` });
  return { files, warnings, truncated };
}

async function copyFilePreserve(source, dest) {
  await ensureDir(path.dirname(dest));
  await fsp.copyFile(source, dest);
  const st = await fsp.stat(source);
  await fsp.utimes(dest, st.atime, st.mtime);
  return { size: st.size, mtime: st.mtime };
}

function toPosix(p) {
  return p.split(path.sep).join('/');
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

module.exports = {
  sanitizeFilename,
  slugify,
  bundleIdentifier,
  shellQuote,
  xmlEscape,
  sha256File,
  pathExists,
  ensureDir,
  safeRemove,
  splitWindowsPath,
  payloadRelativeForWindowsPath,
  windowsPathForPayload,
  normalizeForCompare,
  isPathInside,
  relativeInside,
  nameSimilarity,
  formatBytes,
  readJson,
  writeJson,
  walkFiles,
  copyFilePreserve,
  toPosix,
  clamp,
};
