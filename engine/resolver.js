'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { curlJson, downloadFile } = require('./download');
const { ensureDir, readJson, writeJson, sha256File, sanitizeFilename, formatBytes } = require('./util');

const RELEASE_API = 'https://api.github.com/repos/Gcenx/macOS_Wine_builds/releases/latest';
const PINNED_FILE = path.join(__dirname, 'pinned-engine.json');

function engineCacheRoot() {
  const base = process.env.LOCALAPPDATA || path.join(process.env.USERPROFILE || '.', 'AppData', 'Local');
  return path.join(base, 'Win2Mac', 'engines');
}

function scoreAsset(asset) {
  const name = String(asset.name || '').toLowerCase();
  if (!name.endsWith('.tar.xz')) return -1000;
  if (!name.includes('wine')) return -500;
  let score = 0;
  if (name.includes('staging')) score += 60;
  else if (name.includes('devel')) score -= 20;
  else if (name.includes('stable')) score += 30;
  if (name.includes('x86_64') || name.includes('osx64') || name.includes('amd64')) score += 50;
  if (name.includes('arm64') || name.includes('aarch64')) score -= 30;
  if (name.includes('wow64')) score += 5;
  if (name.includes('sha256')) score -= 500;
  if (!asset.browser_download_url) score -= 500;
  return score;
}

function pickAsset(release) {
  const assets = (release.assets || []).map((asset) => ({ ...asset, _score: scoreAsset(asset) }));
  assets.sort((a, b) => b._score - a._score);
  return assets[0]?._score > 0 ? assets[0] : null;
}

function normalizeDigest(digest) {
  if (!digest) return '';
  const value = String(digest);
  if (value.startsWith('sha256:')) return value.slice('sha256:'.length).toLowerCase();
  return /^[a-f0-9]{64}$/i.test(value) ? value.toLowerCase() : '';
}

async function fetchLatestEngine({ proxy, onProgress } = {}) {
  const release = await curlJson(RELEASE_API, { proxy });
  const asset = pickAsset(release);
  if (!asset) throw new Error('macOS Wine 发布中没有找到可用的 .tar.xz 资产');
  const meta = {
    kind: 'wine',
    source: 'github',
    repo: 'Gcenx/macOS_Wine_builds',
    release: release.tag_name || release.name || '',
    name: asset.name,
    version: String(release.tag_name || release.name || 'latest').replace(/^v/, ''),
    url: asset.browser_download_url,
    size: Number(asset.size) || 0,
    sizeLabel: formatBytes(Number(asset.size) || 0),
    sha256: normalizeDigest(asset.digest),
    arch: /arm64|aarch64/i.test(asset.name) ? 'arm64' : 'x86_64',
    fetchedAt: new Date().toISOString(),
  };
  if (onProgress) onProgress({ stage: 'metadata', message: `已找到 ${meta.name}` });
  try {
    await writeJson(PINNED_FILE, meta);
  } catch {
    /* app dir may be read-only in tests */
  }
  return meta;
}

async function loadPinnedEngine() {
  try {
    const data = await readJson(PINNED_FILE);
    if (data && data.url && data.kind === 'wine') return data;
  } catch {
    /* no pin */
  }
  return null;
}

async function ensureEngineArchive(meta, { proxy, onProgress } = {}) {
  if (!meta?.url) throw new Error('缺少 Wine 引擎下载地址');
  const root = engineCacheRoot();
  await ensureDir(root);
  const fileName = sanitizeFilename(meta.name || `${meta.version || 'wine'}.tar.xz`, 'wine.tar.xz');
  if (!fileName.endsWith('.tar.xz')) fileName += '.tar.xz';
  const dest = path.join(root, fileName);
  if (fs.existsSync(dest)) {
    if (meta.sha256) {
      const actual = await sha256File(dest);
      if (actual === meta.sha256) {
        return { ...meta, archivePath: dest, sha256: actual, cached: true };
      }
      await fsp.rm(dest, { force: true });
    } else {
      const st = await fsp.stat(dest);
      if (!meta.size || st.size === meta.size) {
        return { ...meta, archivePath: dest, sha256: await sha256File(dest), cached: true };
      }
      await fsp.rm(dest, { force: true });
    }
  }
  if (onProgress) {
    onProgress({
      stage: 'download',
      message: `正在下载 ${meta.name}${meta.sizeLabel ? `（${meta.sizeLabel}）` : ''}…`,
    });
  }
  const downloaded = await downloadFile(meta.url, dest, {
    proxy,
    expectedSha256: meta.sha256 || undefined,
    totalBytes: meta.size || 0,
    onProgress: (progress) => {
      if (onProgress) {
        onProgress({
          stage: 'download',
          message: `正在下载 Wine 引擎 ${progress.percent || 0}%（${formatBytes(progress.received)} / ${formatBytes(progress.total)}）`,
          percent: progress.percent || 0,
        });
      }
    },
  });
  return { ...meta, archivePath: dest, sha256: downloaded.sha256, size: downloaded.size, cached: false };
}

async function resolveEngine({ mode = 'auto', proxy = '', manualArchive = '', onProgress } = {}) {
  if (manualArchive) {
    const st = await fsp.stat(manualArchive);
    const meta = {
      kind: 'wine',
      source: 'manual',
      name: path.basename(manualArchive),
      version: 'manual',
      size: st.size,
      sizeLabel: formatBytes(st.size),
      sha256: await sha256File(manualArchive),
      arch: 'x86_64',
      url: '',
    };
    return { meta, archivePath: manualArchive, downloadNeeded: false };
  }

  let meta = await loadPinnedEngine();
  if (mode === 'reuse' && !meta) {
    return { meta: null, archivePath: null, downloadNeeded: false };
  }
  if (!meta || mode === 'bundled') {
    try {
      const latest = await fetchLatestEngine({ proxy, onProgress });
      if (!meta || latest.release !== meta.release) meta = latest;
    } catch (error) {
      if (!meta) throw new Error(`无法获取 Wine 引擎信息：${error.message}`);
      if (onProgress) onProgress({ stage: 'metadata', message: `在线检查失败，使用固定版本：${error.message}` });
    }
  }

  if (mode === 'bundled') {
    const ensured = await ensureEngineArchive(meta, { proxy, onProgress });
    return { meta: ensured, archivePath: ensured.archivePath, downloadNeeded: !ensured.cached };
  }

  return { meta, archivePath: null, downloadNeeded: false };
}

module.exports = {
  resolveEngine,
  ensureEngineArchive,
  fetchLatestEngine,
  loadPinnedEngine,
  pickAsset,
  scoreAsset,
  engineCacheRoot,
  normalizeDigest,
};
