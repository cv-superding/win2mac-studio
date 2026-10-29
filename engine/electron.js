'use strict';

const fsp = require('node:fs/promises');
const path = require('node:path');
const { toPosix, walkFiles } = require('./util');

const MAX_ASAR_HEADER = 8 * 1024 * 1024;
const MAX_PACKAGE_JSON = 1024 * 1024;
const DEFAULT_ELECTRON_FLAGS = ['--no-sandbox', '--disable-gpu', '--in-process-gpu'];

async function pathIsFile(file) {
  try {
    const st = await fsp.stat(file);
    return st.isFile();
  } catch {
    return false;
  }
}

function align4(value) {
  return Math.ceil(value / 4) * 4;
}

async function readAsarManifest(asarPath) {
  let handle;
  try {
    handle = await fsp.open(asarPath, 'r');
    const headerSizeBuffer = Buffer.alloc(16);
    const head = await handle.read(headerSizeBuffer, 0, 16, 0);
    if (head.bytesRead < 16) return null;
    const headerSize = headerSizeBuffer.readUInt32LE(12);
    if (!headerSize || headerSize > MAX_ASAR_HEADER) return null;
    const headerBuffer = Buffer.alloc(headerSize);
    const headerRead = await handle.read(headerBuffer, 0, headerSize, 16);
    if (headerRead.bytesRead < headerSize) return null;
    let header;
    try {
      header = JSON.parse(headerBuffer.toString('utf8').replace(/\0+$/, ''));
    } catch {
      return null;
    }
    const packageNode = header?.files?.['package.json'];
    const result = { header, packageJson: null };
    if (!packageNode || packageNode.size == null || packageNode.offset == null) return result;
    const size = Number(packageNode.size);
    const offset = Number(packageNode.offset);
    if (!Number.isFinite(size) || !Number.isFinite(offset) || size <= 0 || size > MAX_PACKAGE_JSON) {
      return result;
    }
    const dataStart = 16 + align4(headerSize) + offset;
    const packageBuffer = Buffer.alloc(size);
    const packageRead = await handle.read(packageBuffer, 0, size, dataStart);
    if (packageRead.bytesRead < size) return result;
    try {
      result.packageJson = JSON.parse(packageBuffer.toString('utf8').replace(/^\uFEFF/, ''));
    } catch {
      result.packageJson = null;
    }
    return result;
  } catch {
    return null;
  } finally {
    if (handle) await handle.close().catch(() => {});
  }
}

async function findNativeModules(root) {
  const modules = [];
  const walk = await walkFiles(root, { maxFiles: 20000 });
  for (const file of walk.files) {
    if (!/\.node$/i.test(file.path)) continue;
    modules.push(file.path);
    if (modules.length >= 50) break;
  }
  return { modules, truncated: walk.truncated || modules.length >= 50 };
}

function archFromCpu(cpu) {
  if (cpu === 0x0100000c) return 'arm64';
  if (cpu === 0x01000007) return 'x86_64';
  if (cpu === 12) return 'arm';
  if (cpu === 7) return 'x86';
  return '';
}

async function readMachOArches(file) {
  let handle;
  try {
    handle = await fsp.open(file, 'r');
    const head = Buffer.alloc(8);
    const read = await handle.read(head, 0, 8, 0);
    if (read.bytesRead < 8) return [];
    const magicLE = head.readUInt32LE(0);
    if (magicLE === 0xfeedfacf || magicLE === 0xfeedface) {
      const arch = archFromCpu(head.readUInt32LE(4));
      return arch ? [arch] : [];
    }
    const magicBE = head.readUInt32BE(0);
    const is64 = magicBE === 0xcafebabf;
    if (!is64 && magicBE !== 0xcafebabe) return [];
    const count = head.readUInt32BE(4);
    if (!count || count > 32) return [];
    const stride = is64 ? 32 : 20;
    const table = Buffer.alloc(count * stride);
    const tableRead = await handle.read(table, 0, table.length, 8);
    if (tableRead.bytesRead < table.length) return [];
    const arches = [];
    for (let i = 0; i < count; i += 1) {
      const arch = archFromCpu(table.readUInt32BE(i * stride));
      if (arch) arches.push(arch);
    }
    return [...new Set(arches)];
  } catch {
    return [];
  } finally {
    if (handle) await handle.close().catch(() => {});
  }
}

async function readMachOArch(file) {
  const arches = await readMachOArches(file);
  return arches[0] || '';
}

async function findHostAdb(installPath) {
  if (!installPath) return { arm64: '', x86_64: '', all: [] };
  const root = path.resolve(installPath);
  const walk = await walkFiles(root, { maxFiles: 20000 });
  const result = { arm64: '', x86_64: '', all: [] };
  for (const file of walk.files) {
    if (path.basename(file.path).toLowerCase() !== 'adb') continue;
    const arches = await readMachOArches(file.path);
    if (!arches.length) continue;
    const rel = toPosix(path.relative(root, file.path));
    result.all.push(rel);
    if (arches.includes('arm64') && !result.arm64) result.arm64 = rel;
    if (arches.includes('x86_64') && !result.x86_64) result.x86_64 = rel;
  }
  return result;
}

async function detectElectronApp(installPath) {
  if (!installPath) return { isElectron: false };
  const root = path.resolve(installPath);
  const candidates = [
    path.join(root, 'resources', 'app.asar'),
    path.join(root, 'resources', 'default_app.asar'),
    path.join(root, 'resources', 'electron.asar'),
  ];
  let asarPath = '';
  for (const candidate of candidates) {
    if (await pathIsFile(candidate)) {
      asarPath = candidate;
      break;
    }
  }
  const hasChromiumPayload =
    (await pathIsFile(path.join(root, 'chrome_100_percent.pak'))) &&
    (await pathIsFile(path.join(root, 'ffmpeg.dll')));
  if (!asarPath && !hasChromiumPayload) return { isElectron: false };

  let packageJson = null;
  if (asarPath) {
    const manifest = await readAsarManifest(asarPath);
    packageJson = manifest?.packageJson || null;
  }
  const build = packageJson?.build && typeof packageJson.build === 'object' ? packageJson.build : {};
  const native = await findNativeModules(root);
  return {
    isElectron: true,
    asarPath: asarPath || '',
    packageName: String(packageJson?.name || '').trim(),
    productName: String(packageJson?.productName || build.productName || '').trim(),
    appId: String(build.appId || packageJson?.appId || '').trim(),
    electronVersion: String(packageJson?.devDependencies?.electron || '').trim(),
    version: String(packageJson?.version || '').trim(),
    main: String(packageJson?.main || '').trim(),
    nativeModules: native.modules,
    nativeModuleCount: native.modules.length,
    nativeModulesTruncated: native.truncated,
  };
}

module.exports = {
  DEFAULT_ELECTRON_FLAGS,
  detectElectronApp,
  findHostAdb,
  readAsarManifest,
  readMachOArch,
  readMachOArches,
  align4,
};
