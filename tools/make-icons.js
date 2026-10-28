'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { extractIconFiles } = require('../engine/icons');
const { buildIcns } = require('../engine/icns');

function buildIco(pngBySize) {
  const sizes = Object.keys(pngBySize)
    .map(Number)
    .filter((size) => size <= 256)
    .sort((a, b) => a - b);
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(sizes.length, 4);
  const entries = [];
  let offset = 6 + sizes.length * 16;
  for (const size of sizes) {
    const data = pngBySize[size];
    const entry = Buffer.alloc(16);
    entry[0] = size === 256 ? 0 : size;
    entry[1] = size === 256 ? 0 : size;
    entry[2] = 0;
    entry[3] = 0;
    entry.writeUInt16LE(1, 4);
    entry.writeUInt16LE(32, 6);
    entry.writeUInt32LE(data.length, 8);
    entry.writeUInt32LE(offset, 12);
    entries.push(entry);
    offset += data.length;
  }
  return Buffer.concat([header, ...entries, ...sizes.map((size) => pngBySize[size])]);
}

async function main() {
  const workDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'win2mac-brand-'));
  try {
    const icon = await extractIconFiles({
      exe: '',
      name: 'Win2Mac',
      sizes: [16, 32, 48, 64, 128, 256, 512],
      outDir: workDir,
    });
    await fsp.mkdir(path.join(__dirname, '..', 'build'), { recursive: true });
    await fsp.mkdir(path.join(__dirname, '..', 'app', 'assets'), { recursive: true });
    await fsp.writeFile(path.join(__dirname, '..', 'resources', 'fallback.icns'), icon.icns);
    await fsp.writeFile(path.join(__dirname, '..', 'build', 'icon.ico'), buildIco(icon.bySize));
    await fsp.writeFile(path.join(__dirname, '..', 'build', 'icon.png'), icon.bySize[512]);
    await fsp.writeFile(path.join(__dirname, '..', 'app', 'assets', 'icon.png'), icon.bySize[512]);
    console.log(
      JSON.stringify(
        {
          ok: true,
          source: icon.source,
          icns: path.join(__dirname, '..', 'resources', 'fallback.icns'),
          ico: path.join(__dirname, '..', 'build', 'icon.ico'),
          sizes: Object.keys(icon.bySize),
        },
        null,
        2,
      ),
    );
  } finally {
    await fsp.rm(workDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
