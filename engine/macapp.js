'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

const ASAR_DATA_OFFSET = 16;
const MAX_PLIST_OBJECTS = 100000;
const MAX_PLIST_COLLECTION = 100000;
const MAX_PLIST_VISITS = 500000;

function decodeEntities(text) {
  return String(text)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(?:x([0-9a-f]+)|(\d+));/gi, (_m, hex, decimal) => {
      const code = Number.parseInt(hex || decimal, hex ? 16 : 10);
      return Number.isInteger(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
    })
    .replace(/&amp;/g, '&');
}

function parseXmlPlist(text) {
  const source = String(text)
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<\?[\s\S]*?\?>/g, '')
    .replace(/<!DOCTYPE[\s\S]*?>/gi, '');
  const tokenRe = /<(\/?)([A-Za-z0-9_]+)([^>]*?)(\/?)>/g;
  const stack = [];
  let root = null;
  let lastKey = '';
  let textStart = 0;
  let match;
  const setValue = (value) => {
    const top = stack[stack.length - 1];
    if (!top) {
      root = value;
      return;
    }
    if (top.type === 'dict') {
      if (lastKey) top.value[lastKey] = value;
      lastKey = '';
    } else if (top.type === 'array') {
      top.value.push(value);
    }
  };
  while ((match = tokenRe.exec(source))) {
    const between = source.slice(textStart, match.index);
    const [, closing, name, attrs, selfClosing] = match;
    textStart = tokenRe.lastIndex;
    if (between.trim() && stack.length) {
      const top = stack[stack.length - 1];
      if (top.type === 'key') top.text += decodeEntities(between);
      else if (top.type === 'string') top.text += decodeEntities(between);
      else if (top.type === 'integer' || top.type === 'real') top.text += between.trim();
    }
    if (closing) {
      const top = stack.pop();
      if (!top) continue;
      if (top.type === 'key') {
        lastKey = String(top.text || '').trim();
      } else if (top.type === 'string') {
        setValue(String(top.text));
      } else if (top.type === 'integer') {
        const value = Number.parseInt(String(top.text).trim(), 10);
        setValue(Number.isFinite(value) ? value : 0);
      } else if (top.type === 'real') {
        const value = Number.parseFloat(String(top.text).trim());
        setValue(Number.isFinite(value) ? value : 0);
      } else if (top.type === 'dict' || top.type === 'array') {
        setValue(top.value);
      }
      continue;
    }
    if (selfClosing) {
      if (name === 'true') setValue(true);
      else if (name === 'false') setValue(false);
      continue;
    }
    if (name === 'key') stack.push({ type: 'key', text: '' });
    else if (name === 'string') stack.push({ type: 'string', text: '' });
    else if (name === 'integer') stack.push({ type: 'integer', text: '' });
    else if (name === 'real') stack.push({ type: 'real', text: '' });
    else if (name === 'dict') stack.push({ type: 'dict', value: {} });
    else if (name === 'array') stack.push({ type: 'array', value: [] });
  }
  if (root === null) throw new Error('无法解析 Info.plist（XML）');
  return root;
}

function parseBinaryPlist(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 40) throw new Error('二进制 plist 过短或格式无效');
  if (buffer.toString('ascii', 0, 8) !== 'bplist00') throw new Error('不是二进制 plist');
  const trailer = buffer.subarray(buffer.length - 32);
  const offsetSize = trailer.readUInt8(6);
  const refSize = trailer.readUInt8(7);
  const numObjects = Number(trailer.readBigUInt64BE(8));
  const topObject = Number(trailer.readBigUInt64BE(16));
  const offsetTable = Number(trailer.readBigUInt64BE(24));
  if (!numObjects || !offsetSize || !refSize) throw new Error('二进制 plist 头部异常');
  // 头部字段来自不可信文件：先确认各项数值落在缓冲区范围内，避免越界读取或超大循环。
  if (offsetSize > 8 || refSize > 8) throw new Error('二进制 plist 头部异常');
  if (!Number.isSafeInteger(numObjects) || numObjects > MAX_PLIST_OBJECTS) throw new Error('二进制 plist 对象数量异常');
  if (!Number.isSafeInteger(offsetTable) || offsetTable < 8 || offsetTable + numObjects * offsetSize > buffer.length) {
    throw new Error('二进制 plist 偏移表越界');
  }
  if (!Number.isSafeInteger(topObject) || topObject < 0 || topObject >= numObjects) throw new Error('二进制 plist 根对象无效');

  const readUInt = (offset, size) => {
    if (!Number.isSafeInteger(offset) || offset < 0 || size < 1 || size > 8 || offset + size > buffer.length) return -1;
    let value = 0;
    for (let i = 0; i < size; i += 1) value = value * 256 + buffer[offset + i];
    return value;
  };
  const objectOffsets = [];
  for (let i = 0; i < numObjects; i += 1) {
    objectOffsets.push(readUInt(offsetTable + i * offsetSize, offsetSize));
  }

  const readLength = (offset, info) => {
    if (info !== 0x0f) return { length: info, next: offset + 1 };
    const marker = buffer[offset + 1];
    if (marker === undefined) return null;
    const intSize = 1 << (marker & 0x0f);
    if (intSize > 8) return null;
    const length = readUInt(offset + 2, intSize);
    const next = offset + 2 + intSize;
    if (length < 0 || next > buffer.length) return null;
    return { length, next };
  };

  let visits = 0;
  const parseObject = (index, depth = 0) => {
    if (depth > 32 || visits >= MAX_PLIST_VISITS) return null;
    if (!Number.isInteger(index) || index < 0 || index >= numObjects) return null;
    visits += 1;
    const offset = objectOffsets[index];
    if (offset < 0 || offset >= buffer.length) return null;
    const marker = buffer[offset];
    const type = marker >> 4;
    const info = marker & 0x0f;
    switch (type) {
      case 0x0:
        if (info === 0x8) return false;
        if (info === 0x9) return true;
        return null;
      case 0x1: {
        const size = 1 << info;
        if (size > 8) return null;
        const value = readUInt(offset + 1, size);
        if (value < 0) return null;
        return size === 8 ? Number(BigInt.asIntN(64, BigInt(value))) : value;
      }
      case 0x2: {
        const size = 1 << info;
        if (offset + 1 + size > buffer.length) return null;
        if (size === 4) return buffer.readFloatBE(offset + 1);
        if (size === 8) return buffer.readDoubleBE(offset + 1);
        return null;
      }
      case 0x5: {
        const meta = readLength(offset, info);
        if (!meta) return null;
        return buffer.toString('ascii', meta.next, meta.next + meta.length);
      }
      case 0x6: {
        const meta = readLength(offset, info);
        if (!meta) return null;
        return buffer.toString('utf16be', meta.next, meta.next + meta.length * 2);
      }
      case 0x4: {
        const meta = readLength(offset, info);
        if (!meta) return null;
        return buffer.subarray(meta.next, meta.next + meta.length);
      }
      case 0xa: {
        const meta = readLength(offset, info);
        if (!meta || meta.length > MAX_PLIST_COLLECTION) return null;
        if (meta.next + meta.length * refSize > buffer.length) return null;
        const result = [];
        for (let i = 0; i < meta.length; i += 1) result.push(parseObject(readUInt(meta.next + i * refSize, refSize), depth + 1));
        return result;
      }
      case 0xd: {
        const meta = readLength(offset, info);
        if (!meta || meta.length > MAX_PLIST_COLLECTION) return null;
        if (meta.next + meta.length * refSize * 2 > buffer.length) return null;
        const result = {};
        for (let i = 0; i < meta.length; i += 1) {
          const key = parseObject(readUInt(meta.next + i * refSize, refSize), depth + 1);
          const value = parseObject(readUInt(meta.next + (meta.length + i) * refSize, refSize), depth + 1);
          if (typeof key === 'string') result[key] = value;
        }
        return result;
      }
      default:
        return null;
    }
  };
  return parseObject(topObject);
}

function readPlistSync(filePath) {
  let buffer;
  try {
    buffer = fs.readFileSync(filePath);
  } catch {
    return null;
  }
  try {
    if (buffer.toString('ascii', 0, 8) === 'bplist00') return parseBinaryPlist(buffer);
    return parseXmlPlist(buffer.toString('utf8'));
  } catch {
    return null;
  }
}

function machOArchs(buffer) {
  if (!buffer || buffer.length < 8) return [];
  const magic = buffer.readUInt32BE(0);
  const archName = (cpu) => {
    switch (cpu >>> 0) {
      case 0x01000007: return 'x86_64';
      case 0x0100000c: return 'arm64';
      case 7: return 'i386';
      case 12: return 'arm';
      default: return `cpu_${(cpu >>> 0).toString(16)}`;
    }
  };
  // FAT_MAGIC/FAT_MAGIC_64 的大端与小端形式都要支持；64 位 fat 头部每条记录是 32 字节。
  const readFat = (littleEndian, stride) => {
    const count = littleEndian ? buffer.readUInt32LE(4) : buffer.readUInt32BE(4);
    const archs = [];
    for (let i = 0; i < Math.min(count, 8); i += 1) {
      const base = 8 + i * stride;
      if (base + 4 > buffer.length) break;
      archs.push(archName(littleEndian ? buffer.readUInt32LE(base) : buffer.readUInt32BE(base)));
    }
    return [...new Set(archs)];
  };
  if (magic === 0xcafebabe) return readFat(false, 20);
  if (magic === 0xcafebabf) return readFat(false, 32);
  if (magic === 0xbebafeca) return readFat(true, 20);
  if (magic === 0xbfbafeca) return readFat(true, 32);
  if (magic === 0xfeedfacf || magic === 0xfeedface) {
    return [archName(buffer.readUInt32BE(4))];
  }
  if (magic === 0xcffaedfe || magic === 0xcefaedfe) {
    return [archName(buffer.readUInt32LE(4))];
  }
  return [];
}

function isMachO(buffer) {
  return machOArchs(buffer).length > 0;
}

async function readAsarEntries(asarPath, limit = 50000) {
  const handle = await fsp.open(asarPath, 'r');
  try {
    const sizeBuffer = Buffer.alloc(16);
    const head = await handle.read(sizeBuffer, 0, 16, 0);
    if (head.bytesRead < 16) return { entries: [], dataStart: 0 };
    const headerSize = sizeBuffer.readUInt32LE(12);
    if (!headerSize || headerSize > 64 * 1024 * 1024) return { entries: [], dataStart: 0 };
    const headerBuffer = Buffer.alloc(headerSize);
    const headerRead = await handle.read(headerBuffer, 0, headerSize, ASAR_DATA_OFFSET);
    if (headerRead.bytesRead < headerSize) return { entries: [], dataStart: 0 };
    let header;
    try {
      header = JSON.parse(headerBuffer.toString('utf8').replace(/\0+$/, ''));
    } catch {
      return { entries: [], dataStart: 0 };
    }
    const align4 = (value) => Math.ceil(value / 4) * 4;
    const dataStart = ASAR_DATA_OFFSET + align4(headerSize);
    const toOffset = (value) => {
      const number = Number(value);
      return Number.isFinite(number) && number >= 0 ? Math.trunc(number) : 0;
    };
    const entries = [];
    const walk = (node, prefix) => {
      if (!node || typeof node !== 'object' || !node.files || entries.length >= limit) return;
      for (const [name, entry] of Object.entries(node.files)) {
        if (!entry || typeof entry !== 'object') continue;
        const rel = prefix ? `${prefix}/${name}` : name;
        if (entry.files) walk(entry, rel);
        else entries.push({ path: rel, size: toOffset(entry.size), offset: toOffset(entry.offset), unpacked: Boolean(entry.unpacked) });
        if (entries.length >= limit) return;
      }
    };
    walk(header, '');
    return { entries, dataStart };
  } finally {
    await handle.close().catch(() => {});
  }
}

const MACHO_HEAD_BYTES = 4096;

async function readAsarEntryBuffer(asarPath, entry, dataStart, maxBytes = 1024 * 1024) {
  if (!entry || entry.unpacked) return null;
  const size = Math.min(Math.max(Number(entry.size) || 0, 0), maxBytes);
  if (!size) return null;
  const handle = await fsp.open(asarPath, 'r');
  try {
    const buffer = Buffer.alloc(size);
    const read = await handle.read(buffer, 0, size, dataStart + entry.offset);
    return read.bytesRead === size ? buffer : null;
  } finally {
    await handle.close().catch(() => {});
  }
}

async function inspectNativeModules(asarPath, asarEntries, dataStart, unpackedRoot) {
  const results = [];
  const packed = asarEntries.filter((entry) => /\.node$/i.test(entry.path)).slice(0, 50);
  if (packed.length) {
    const handle = await fsp.open(asarPath, 'r');
    try {
      for (const entry of packed) {
        // 通用（fat）Mach-O 的架构表最长约 264 字节，只读 8 字节会漏掉 .node 的架构。
        const size = Math.min(MACHO_HEAD_BYTES, Math.max(Number(entry.size) || 0, 0));
        const buffer = Buffer.alloc(size);
        const read = size ? await handle.read(buffer, 0, size, dataStart + entry.offset) : { bytesRead: 0 };
        results.push({ path: entry.path, archs: machOArchs(buffer.subarray(0, read.bytesRead)), packed: true });
      }
    } finally {
      await handle.close().catch(() => {});
    }
  }
  if (unpackedRoot) {
    const stack = [unpackedRoot];
    while (stack.length && results.length < 80) {
      const dir = stack.pop();
      let entries = [];
      try {
        entries = await fsp.readdir(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (!/node_modules$/i.test(entry.name) || stack.length < 200) stack.push(full);
        } else if (/\.node$/i.test(entry.name)) {
          let head = Buffer.alloc(0);
          try {
            const handle = await fsp.open(full, 'r');
            const buffer = Buffer.alloc(MACHO_HEAD_BYTES);
            const read = await handle.read(buffer, 0, buffer.length, 0);
            head = buffer.subarray(0, read.bytesRead);
            await handle.close();
          } catch { /* ignore */ }
          results.push({ path: path.relative(unpackedRoot, full).replace(/\\/g, '/'), archs: machOArchs(head), packed: false });
        }
      }
    }
  }
  return results;
}

function firstExisting(paths) {
  for (const candidate of paths) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch { /* ignore */ }
  }
  return '';
}

async function analyzeMacApp(appPath) {
  const bundlePath = path.resolve(appPath);
  const contents = path.join(bundlePath, 'Contents');
  const infoPath = path.join(contents, 'Info.plist');
  const info = readPlistSync(infoPath);
  if (!info) throw new Error('不是有效的 macOS .app：缺少可解析的 Contents/Info.plist');
  const executableRaw = String(info.CFBundleExecutable || '');
  // CFBundleExecutable 只能是 MacOS/ 下的文件名；拒绝 ../ 与绝对路径，避免读取包外文件。
  const executable = executableRaw && !/[\\/]/.test(executableRaw) && executableRaw !== '.' && executableRaw !== '..'
    ? executableRaw
    : '';
  const exePath = executable ? path.join(contents, 'MacOS', executable) : '';
  const resourcesDir = path.join(contents, 'Resources');
  const asarPath = firstExisting([path.join(resourcesDir, 'app.asar')]);
  const appDir = firstExisting([path.join(resourcesDir, 'app')]);
  const unpackedRoot = firstExisting([path.join(resourcesDir, 'app.asar.unpacked')]);
  const frameworkInfo = firstExisting([
    path.join(contents, 'Frameworks', 'Electron Framework.framework', 'Versions', 'A', 'Resources', 'Info.plist'),
    path.join(contents, 'Frameworks', 'Electron Framework.framework', 'Resources', 'Info.plist'),
  ]);
  const framework = frameworkInfo ? readPlistSync(frameworkInfo) : null;

  let exeArchs = [];
  if (exePath) {
    try {
      const fd = await fsp.open(exePath, 'r');
      const head = Buffer.alloc(64);
      await fd.read(head, 0, 64, 0);
      await fd.close();
      exeArchs = machOArchs(head);
    } catch { /* ignore */ }
  }

  const isElectron = Boolean(asarPath || appDir) && Boolean(
    framework || /electron/i.test(String(info.CFBundleIdentifier || '')) || asarPath,
  );

  let asarEntries = [];
  let dataStart = 0;
  if (asarPath) {
    try {
      const parsed = await readAsarEntries(asarPath);
      asarEntries = parsed.entries;
      dataStart = parsed.dataStart;
    } catch { /* ignore */ }
  }

  let electronVersion = String(framework?.CFBundleShortVersionString || framework?.CFBundleVersion || '').trim();
  if (!electronVersion) {
    // 未找到 Electron Framework 时，版本通常写在 Resources/app/package.json；asar 打包的应用需要从 asar 内读取。
    let pkg = null;
    const pkgEntry = asarEntries.find((entry) => entry.path === 'package.json');
    if (asarPath && pkgEntry) {
      try {
        const raw = await readAsarEntryBuffer(asarPath, pkgEntry, dataStart);
        if (raw) pkg = JSON.parse(raw.toString('utf8').replace(/^\uFEFF/, ''));
      } catch { /* ignore */ }
    }
    if (!pkg) {
      try {
        pkg = JSON.parse(fs.readFileSync(path.join(resourcesDir, 'app', 'package.json'), 'utf8').replace(/^\uFEFF/, ''));
      } catch { /* ignore */ }
    }
    electronVersion = String(pkg?.devDependencies?.electron || pkg?.dependencies?.electron || '').trim().replace(/^[^\d]*/, '');
  }
  const nativeModules = await inspectNativeModules(asarPath || '', asarEntries, dataStart, unpackedRoot || '');
  const machoNative = nativeModules.filter((entry) => entry.archs.length > 0);

  const reasons = [];
  let grade = 'D';
  if (isElectron && !machoNative.length) {
    grade = 'A';
    reasons.push({ code: 'electron-transcode', severity: 'info', title: 'Electron 应用', detail: '可在 Windows 上重组为原生 Electron 应用，不依赖 Wine。' });
  } else if (isElectron && machoNative.length) {
    grade = 'C';
    reasons.push({ code: 'native-modules', severity: 'warn', title: `含 ${machoNative.length} 个 macOS 原生模块`, detail: '这些 .node 是 Mach-O，Windows 上无法加载；除非应用用不到它们，否则会启动失败。' });
  } else {
    reasons.push({ code: 'not-electron', severity: 'block', title: '非 Electron 应用', detail: '当前版本只支持把 Electron 的 macOS 应用重组为 Windows 版；原生 Cocoa 应用需要 macOS 运行时，Windows 上没有等价方案。' });
  }
  if (exeArchs.length) reasons.push({ code: 'arch', severity: 'info', title: `主程序架构：${exeArchs.join(' / ')}`, detail: '架构信息用于判断原应用是否同时支持 Intel 与 Apple Silicon。' });

  return {
    platform: 'mac',
    path: bundlePath,
    name: String(info.CFBundleDisplayName || info.CFBundleName || path.basename(bundlePath, '.app')),
    bundleId: String(info.CFBundleIdentifier || ''),
    version: String(info.CFBundleShortVersionString || info.CFBundleVersion || '1.0'),
    minimumSystemVersion: String(info.LSMinimumSystemVersion || ''),
    executable,
    exePath,
    exeArchs,
    isElectron,
    electronVersion,
    asarPath,
    appDir,
    unpackedRoot,
    fileCount: asarEntries.length,
    nativeModules: nativeModules.slice(0, 40),
    nativeModuleCount: nativeModules.length,
    grade,
    summary: grade === 'A'
      ? 'Electron（纯 JS）· 可直接重组为 Windows 应用'
      : grade === 'C'
        ? 'Electron（含原生模块）· 可能无法启动'
        : '非 Electron · 暂不支持',
    reasons,
  };
}

module.exports = {
  analyzeMacApp,
  parseXmlPlist,
  parseBinaryPlist,
  readPlistSync,
  machOArchs,
  isMachO,
  readAsarEntries,
};
