'use strict';

const fsp = require('node:fs/promises');
const path = require('node:path');

const MACHINES = {
  0x014c: { arch: 'x86', bits: 32, label: '32 位 x86' },
  0x8664: { arch: 'x64', bits: 64, label: '64 位 x64' },
  0xaa64: { arch: 'arm64', bits: 64, label: '64 位 ARM64' },
  0x01c4: { arch: 'arm', bits: 32, label: '32 位 ARM' },
};

const SUBSYSTEMS = {
  1: 'native',
  2: 'gui',
  3: 'console',
  5: 'os2',
  7: 'posix',
  9: 'windows-ce',
  10: 'efi',
  16: 'efi-boot',
};

function readAsciiString(buffer, offset, maxLen = 260) {
  if (offset < 0 || offset >= buffer.length) return '';
  let end = offset;
  const limit = Math.min(buffer.length, offset + maxLen);
  while (end < limit && buffer[end] !== 0) end += 1;
  if (end <= offset) return '';
  return buffer.toString('latin1', offset, end);
}

function parsePE(buffer, options = {}) {
  const result = {
    ok: false,
    exists: true,
    error: null,
    arch: 'unknown',
    bits: 0,
    machineLabel: '未知架构',
    subsystem: 'unknown',
    is64Bit: false,
    isDll: false,
    isDotNet: false,
    imports: [],
    delayImports: [],
    hasResources: false,
    timestamp: null,
    sectionCount: 0,
    fileSize: options.fileSize || buffer.length,
  };

  try {
    if (!buffer || buffer.length < 0x40) throw new Error('文件太小，不是有效的 PE 文件');
    if (buffer[0] !== 0x4d || buffer[1] !== 0x5a) throw new Error('缺少 MZ 头');
    const peOffset = buffer.readUInt32LE(0x3c);
    if (peOffset + 24 > buffer.length) throw new Error('PE 头越界');
    if (buffer.readUInt32LE(peOffset) !== 0x00004550) throw new Error('缺少 PE 签名');

    const coff = peOffset + 4;
    const machine = buffer.readUInt16LE(coff);
    const sectionCount = buffer.readUInt16LE(coff + 2);
    const timestamp = buffer.readUInt32LE(coff + 4);
    const optionalSize = buffer.readUInt16LE(coff + 16);
    const characteristics = buffer.readUInt16LE(coff + 18);
    const opt = coff + 20;
    if (opt + optionalSize > buffer.length) throw new Error('可选头越界');

    const info = MACHINES[machine] || { arch: 'unknown', bits: 0, label: `未知 (0x${machine.toString(16)})` };
    const magic = buffer.readUInt16LE(opt);
    if (magic !== 0x10b && magic !== 0x20b) throw new Error('未知的可选头格式');
    const is64 = magic === 0x20b;
    const dirOffset = is64 ? 112 : 96;
    const numDirsOffset = is64 ? 108 : 92;
    const numDirs = buffer.readUInt32LE(opt + numDirsOffset);
    const subsystem = SUBSYSTEMS[buffer.readUInt16LE(opt + 68)] || 'unknown';
    const dllCharacteristics = buffer.readUInt16LE(opt + 70);

    result.ok = true;
    result.arch = info.arch;
    result.bits = info.bits;
    result.machineLabel = info.label;
    result.is64Bit = info.bits === 64;
    result.machine = machine;
    result.subsystem = subsystem;
    result.dllCharacteristics = dllCharacteristics;
    result.isDll = Boolean(characteristics & 0x2000);
    result.isExecutableImage = Boolean(characteristics & 0x0002);
    result.timestamp = timestamp ? new Date(timestamp * 1000).toISOString() : null;
    result.sectionCount = sectionCount;

    const sections = [];
    const sectionTable = opt + optionalSize;
    for (let i = 0; i < sectionCount; i += 1) {
      const off = sectionTable + i * 40;
      if (off + 40 > buffer.length) break;
      sections.push({
        name: readAsciiString(buffer, off, 8),
        virtualSize: buffer.readUInt32LE(off + 8),
        virtualAddress: buffer.readUInt32LE(off + 12),
        rawSize: buffer.readUInt32LE(off + 16),
        rawOffset: buffer.readUInt32LE(off + 20),
      });
    }

    const rvaToOffset = (rva, length = 1) => {
      if (!Number.isFinite(rva) || rva <= 0) return -1;
      for (const section of sections) {
        const span = Math.max(section.virtualSize, section.rawSize);
        if (rva >= section.virtualAddress && rva < section.virtualAddress + span) {
          const delta = rva - section.virtualAddress;
          if (delta >= section.rawSize) return -1;
          const offset = section.rawOffset + delta;
          if (offset < 0 || offset + length > buffer.length) return -1;
          return offset;
        }
      }
      if (rva < buffer.length) return rva;
      return -1;
    };

    const dataDir = (index) => {
      if (index >= numDirs || index >= 16) return { rva: 0, size: 0 };
      const off = opt + dirOffset + index * 8;
      if (off + 8 > opt + optionalSize) return { rva: 0, size: 0 };
      return { rva: buffer.readUInt32LE(off), size: buffer.readUInt32LE(off + 4) };
    };

    const clr = dataDir(14);
    result.isDotNet = clr.rva !== 0 && clr.size !== 0;
    const resources = dataDir(2);
    result.hasResources = resources.rva !== 0 && resources.size !== 0;

    const parseImportNames = (dir, descriptorSize, nameOffset, isDelay) => {
      if (!dir.rva) return [];
      const names = [];
      let offset = rvaToOffset(dir.rva, descriptorSize);
      if (offset < 0) return names;
      for (let i = 0; i < 512; i += 1) {
        if (offset + descriptorSize > buffer.length) break;
        const fields = [];
        for (let j = 0; j < descriptorSize; j += 4) {
          fields.push(buffer.readUInt32LE(offset + j));
        }
        if (fields.every((value) => value === 0)) break;
        const nameRva = fields[nameOffset];
        const nameOff = rvaToOffset(nameRva, 2);
        if (nameOff >= 0) {
          const dll = readAsciiString(buffer, nameOff, 260).trim();
          if (dll && /^[\w.\-+ ]+$/.test(dll)) names.push(dll.toLowerCase());
        }
        offset += descriptorSize;
      }
      return names;
    };

    result.imports = [...new Set(parseImportNames(dataDir(1), 20, 3, false))];
    result.delayImports = [...new Set(parseImportNames(dataDir(13), 32, 1, true))];
    result.allImports = [...new Set([...result.imports, ...result.delayImports])];
    result.sections = sections.map((s) => s.name).filter(Boolean);
  } catch (error) {
    result.error = error.message;
  }

  return result;
}

async function inspectPEFile(file, options = {}) {
  let stat;
  try {
    stat = await fsp.stat(file);
  } catch (error) {
    return {
      ok: false,
      exists: false,
      error: `无法访问文件：${error.message}`,
      file,
      fileName: path.basename(file),
      arch: 'unknown',
      bits: 0,
      machineLabel: '未知',
      imports: [],
      allImports: [],
      isDotNet: false,
    };
  }
  if (!stat.isFile()) {
    return {
      ok: false,
      exists: false,
      error: '路径不是文件',
      file,
      fileName: path.basename(file),
      arch: 'unknown',
      bits: 0,
      machineLabel: '未知',
      imports: [],
      allImports: [],
      isDotNet: false,
    };
  }
  const limit = options.maxBytes || 512 * 1024 * 1024;
  if (stat.size > limit) {
    return {
      ok: false,
      exists: true,
      error: `文件超过 ${Math.round(limit / 1024 / 1024)}MB，跳过 PE 解析`,
      file,
      fileName: path.basename(file),
      fileSize: stat.size,
      arch: 'unknown',
      bits: 0,
      machineLabel: '未知',
      imports: [],
      allImports: [],
      isDotNet: false,
    };
  }
  let buffer;
  try {
    buffer = await fsp.readFile(file);
  } catch (error) {
    return {
      ok: false,
      exists: true,
      error: `读取失败：${error.message}`,
      file,
      fileName: path.basename(file),
      fileSize: stat.size,
      arch: 'unknown',
      bits: 0,
      machineLabel: '未知',
      imports: [],
      allImports: [],
      isDotNet: false,
    };
  }
  const parsed = parsePE(buffer, { fileSize: stat.size });
  return { ...parsed, file, fileName: path.basename(file), mtimeMs: stat.mtimeMs };
}

async function inspectPEHeader(file) {
  let handle;
  try {
    handle = await fsp.open(file, 'r');
    const stat = await handle.stat();
    const size = Math.min(stat.size, 64 * 1024);
    const buffer = Buffer.alloc(size);
    await handle.read(buffer, 0, size, 0);
    const parsed = parsePE(buffer, { fileSize: stat.size });
    return { ...parsed, file, fileName: path.basename(file), mtimeMs: stat.mtimeMs };
  } catch (error) {
    return {
      ok: false,
      exists: false,
      error: error.message,
      file,
      fileName: path.basename(file),
      arch: 'unknown',
      bits: 0,
      machineLabel: '未知',
      imports: [],
      allImports: [],
      isDotNet: false,
    };
  } finally {
    if (handle) await handle.close().catch(() => {});
  }
}

module.exports = { parsePE, inspectPEFile, inspectPEHeader, MACHINES, SUBSYSTEMS };
