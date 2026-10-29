'use strict';

const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  DEFAULT_ELECTRON_FLAGS,
  align4,
  detectElectronApp,
  findHostAdb,
  readAsarManifest,
  readMachOArch,
  readMachOArches,
} = require('../engine/electron');

function buildAsar(packageJson) {
  const content = Buffer.from(JSON.stringify(packageJson));
  const headerJson = Buffer.from(JSON.stringify({
    files: { 'package.json': { size: content.length, offset: '0' } },
  }));
  const header = Buffer.alloc(align4(headerJson.length));
  headerJson.copy(header);
  const prefix = Buffer.alloc(16);
  prefix.writeUInt32LE(4, 0);
  prefix.writeUInt32LE(headerJson.length + 11, 4);
  prefix.writeUInt32LE(headerJson.length + 7, 8);
  prefix.writeUInt32LE(headerJson.length, 12);
  return Buffer.concat([prefix, header, content]);
}

async function makeElectronTree(root, packageJson = { name: 'baokeai', productName: '客源雷达' }) {
  await fsp.mkdir(path.join(root, 'resources'), { recursive: true });
  const asar = buildAsar(packageJson);
  await fsp.writeFile(path.join(root, 'resources', 'app.asar'), asar);
  return asar;
}

test('detectElectronApp reads app.asar package metadata', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'win2mac-electron-'));
  try {
    await makeElectronTree(root, {
      name: 'baokeai',
      productName: '客源雷达',
      version: '2.0.31',
      main: './public/electron/main.js',
      build: { appId: 'com.example.baokeai' },
    });
    const info = await detectElectronApp(root);
    assert.equal(info.isElectron, true);
    assert.equal(info.packageName, 'baokeai');
    assert.equal(info.productName, '客源雷达');
    assert.equal(info.appId, 'com.example.baokeai');
    assert.equal(info.version, '2.0.31');
    assert.match(info.asarPath, /resources[\\/]app\.asar$/);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('detectElectronApp reports unpacked native modules', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'win2mac-electron-native-'));
  try {
    await makeElectronTree(root);
    const nativeDir = path.join(root, 'resources', 'app.asar.unpacked', 'node_modules', 'better-sqlite3', 'build', 'Release');
    await fsp.mkdir(nativeDir, { recursive: true });
    await fsp.writeFile(path.join(nativeDir, 'better_sqlite3.node'), 'MZ');
    const info = await detectElectronApp(root);
    assert.equal(info.isElectron, true);
    assert.equal(info.nativeModuleCount, 1);
    assert.match(info.nativeModules[0], /better_sqlite3\.node$/);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('findHostAdb locates arm64 and x86_64 Mach-O adb binaries', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'win2mac-electron-adb-'));
  try {
    const arm = path.join(root, 'resources', 'scrcpy', 'mac-arm', 'adb');
    const x86 = path.join(root, 'resources', 'scrcpy', 'mac-x86', 'adb');
    await fsp.mkdir(path.dirname(arm), { recursive: true });
    await fsp.mkdir(path.dirname(x86), { recursive: true });
    const header = (cpu) => {
      const buffer = Buffer.alloc(8);
      buffer.writeUInt32LE(0xfeedfacf, 0);
      buffer.writeUInt32LE(cpu, 4);
      return buffer;
    };
    await fsp.writeFile(arm, header(0x0100000c));
    await fsp.writeFile(x86, header(0x01000007));
    assert.equal(await readMachOArch(arm), 'arm64');
    assert.equal(await readMachOArch(x86), 'x86_64');
    const found = await findHostAdb(root);
    assert.match(found.arm64, /mac-arm\/adb$/);
    assert.match(found.x86_64, /mac-x86\/adb$/);
    assert.equal(found.all.length, 2);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('findHostAdb handles universal FAT Mach-O binaries', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'win2mac-electron-fat-'));
  try {
    const adb = path.join(root, 'scrcpy', 'mac', 'adb');
    await fsp.mkdir(path.dirname(adb), { recursive: true });
    const fat = Buffer.alloc(8 + 2 * 20);
    fat.writeUInt32BE(0xcafebabe, 0);
    fat.writeUInt32BE(2, 4);
    fat.writeUInt32BE(0x0100000c, 8);
    fat.writeUInt32BE(0x01000007, 28);
    await fsp.writeFile(adb, fat);
    assert.deepEqual(await readMachOArches(adb), ['arm64', 'x86_64']);
    const found = await findHostAdb(root);
    assert.equal(found.arm64, 'scrcpy/mac/adb');
    assert.equal(found.x86_64, 'scrcpy/mac/adb');
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('detectElectronApp recognizes Chromium payload without app.asar', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'win2mac-electron-chromium-'));
  try {
    await fsp.writeFile(path.join(root, 'chrome_100_percent.pak'), 'pak');
    await fsp.writeFile(path.join(root, 'ffmpeg.dll'), 'dll');
    const info = await detectElectronApp(root);
    assert.equal(info.isElectron, true);
    assert.equal(info.asarPath, '');
    assert.equal(info.packageName, '');
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('detectElectronApp ignores ordinary Win32 directories', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'win2mac-electron-plain-'));
  try {
    await fsp.writeFile(path.join(root, 'App.exe'), 'MZ');
    const info = await detectElectronApp(root);
    assert.deepEqual(info, { isElectron: false });
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('readAsarManifest tolerates malformed archives', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'win2mac-electron-bad-'));
  try {
    const bad = path.join(root, 'bad.asar');
    await fsp.writeFile(bad, Buffer.alloc(32, 0xff));
    assert.equal(await readAsarManifest(bad), null);
    assert.equal(await readAsarManifest(path.join(root, 'missing.asar')), null);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('default Electron flags cover Wine sandbox and GPU failures', () => {
  assert.deepEqual(DEFAULT_ELECTRON_FLAGS, ['--no-sandbox', '--disable-gpu', '--in-process-gpu']);
});
