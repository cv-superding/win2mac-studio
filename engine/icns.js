'use strict';

const fs = require('node:fs');

const SIZE_TO_TYPES = {
  16: ['icp4'],
  32: ['icp5', 'ic11'],
  64: ['icp6', 'ic12'],
  128: ['ic07'],
  256: ['ic08', 'ic13'],
  512: ['ic09', 'ic14'],
  1024: ['ic10'],
};

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function isPNG(buffer) {
  return Boolean(buffer && buffer.length > 8 && buffer.subarray(0, 8).equals(PNG_SIGNATURE));
}

function buildIcns(pngBySize) {
  const entries = [];
  for (const [sizeRaw, buffer] of Object.entries(pngBySize)) {
    const size = Number(sizeRaw);
    if (!Number.isFinite(size) || !isPNG(buffer)) continue;
    const types = SIZE_TO_TYPES[size] || [];
    for (const type of types) entries.push({ type, buffer });
  }
  entries.sort((a, b) => a.type.localeCompare(b.type));
  if (!entries.length) throw new Error('ICNS 至少需要一个有效的 PNG 图层');

  const total = 8 + entries.reduce((sum, entry) => sum + 8 + entry.buffer.length, 0);
  const output = Buffer.allocUnsafe(total);
  output.write('icns', 0, 'ascii');
  output.writeUInt32BE(total, 4);
  let offset = 8;
  for (const entry of entries) {
    output.write(entry.type, offset, 'ascii');
    output.writeUInt32BE(entry.buffer.length + 8, offset + 4);
    entry.buffer.copy(output, offset + 8);
    offset += 8 + entry.buffer.length;
  }
  return output;
}

function readIcnsLayers(file) {
  const buffer = fs.readFileSync(file);
  if (buffer.toString('ascii', 0, 4) !== 'icns') throw new Error('不是 ICNS 文件');
  const total = buffer.readUInt32BE(4);
  const layers = [];
  let offset = 8;
  while (offset + 8 <= Math.min(total, buffer.length)) {
    const type = buffer.toString('ascii', offset, offset + 4);
    const length = buffer.readUInt32BE(offset + 4);
    if (length < 8 || offset + length > buffer.length) break;
    layers.push({ type, length, data: buffer.subarray(offset + 8, offset + length) });
    offset += length;
  }
  return layers;
}

module.exports = { buildIcns, isPNG, SIZE_TO_TYPES, readIcnsLayers };
