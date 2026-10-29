'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { analyzeMacApp, parseXmlPlist, machOArchs, readAsarEntries } = require('../engine/macapp');
const { normalizeElectronVersion, readShasum, assembleWindowsApp } = require('../engine/mactowin');

const MACHO_X64 = Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 0x07, 0x00, 0x00, 0x01, 0x03, 0x00, 0x00, 0x00]);
const MACHO_ARM64 = Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 0x0c, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00]);

const INFO_PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleExecutable</key><string>DemoApp</string>
  <key>CFBundleIdentifier</key><string>com.example.demo</string>
  <key>CFBundleName</key><string>Demo</string>
  <key>CFBundleShortVersionString</key><string>2.3.4</string>
  <key>LSMinimumSystemVersion</key><string>11.0</string>
</dict>
</plist>`;

const FRAMEWORK_PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict><key>CFBundleShortVersionString</key><string>30.0.0</string></dict></plist>`;

function writeAsar(file, files) {
  const header = { files: {} };
  let offset = 0;
  const chunks = [];
  for (const [name, content] of Object.entries(files)) {
    const data = Buffer.from(content);
    header.files[name] = { size: data.length, offset };
    chunks.push(data);
    offset += data.length;
  }
  const headerJson = Buffer.from(JSON.stringify(header), 'utf8');
  const padding = Buffer.alloc((4 - (headerJson.length % 4)) % 4);
  const sizeBuffer = Buffer.alloc(16);
  sizeBuffer.writeUInt32LE(4, 0);
  sizeBuffer.writeUInt32LE(headerJson.length, 12);
  fs.writeFileSync(file, Buffer.concat([sizeBuffer, headerJson, padding, ...chunks]));
}

async function createMacApp(root, { withNative = false } = {}) {
  const bundle = path.join(root, 'Demo.app');
  const contents = path.join(bundle, 'Contents');
  const macos = path.join(contents, 'MacOS');
  const resources = path.join(contents, 'Resources');
  const framework = path.join(contents, 'Frameworks', 'Electron Framework.framework', 'Versions', 'A', 'Resources');
  await fsp.mkdir(macos, { recursive: true });
  await fsp.mkdir(resources, { recursive: true });
  await fsp.mkdir(framework, { recursive: true });
  await fsp.writeFile(path.join(contents, 'Info.plist'), INFO_PLIST);
  await fsp.writeFile(path.join(framework, 'Info.plist'), FRAMEWORK_PLIST);
  await fsp.writeFile(path.join(macos, 'DemoApp'), MACHO_ARM64);
  writeAsar(path.join(resources, 'app.asar'), {
    'package.json': JSON.stringify({ name: 'demo', main: 'main.js' }),
    'main.js': 'console.log(1)',
  });
  if (withNative) {
    const unpacked = path.join(resources, 'app.asar.unpacked', 'node_modules', 'native');
    await fsp.mkdir(unpacked, { recursive: true });
    await fsp.writeFile(path.join(unpacked, 'demo.node'), MACHO_X64);
  }
  return bundle;
}

test('macOS plist 解析与 Mach-O 架构识别', () => {
  const info = parseXmlPlist(INFO_PLIST);
  assert.equal(info.CFBundleExecutable, 'DemoApp');
  assert.equal(info.CFBundleShortVersionString, '2.3.4');
  assert.deepEqual(machOArchs(MACHO_X64), ['x86_64']);
  assert.deepEqual(machOArchs(MACHO_ARM64), ['arm64']);
  const fat = Buffer.alloc(48);
  fat.writeUInt32BE(0xcafebabe, 0);
  fat.writeUInt32BE(2, 4);
  fat.writeUInt32BE(0x01000007, 8);
  fat.writeUInt32BE(0x0100000c, 28);
  assert.deepEqual(machOArchs(fat), ['x86_64', 'arm64']);
  assert.deepEqual(machOArchs(Buffer.from('MZ')), []);
});

test('分析 Electron .app：可重组为 Windows', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'win2mac-macapp-'));
  try {
    const bundle = await createMacApp(root);
    const analysis = await analyzeMacApp(bundle);
    assert.equal(analysis.platform, 'mac');
    assert.equal(analysis.name, 'Demo');
    assert.equal(analysis.bundleId, 'com.example.demo');
    assert.equal(analysis.isElectron, true);
    assert.equal(analysis.electronVersion, '30.0.0');
    assert.equal(analysis.grade, 'A');
    assert.deepEqual(analysis.exeArchs, ['arm64']);
    assert.equal(analysis.nativeModuleCount, 0);
    const entries = await readAsarEntries(analysis.asarPath);
    assert.ok(entries.entries.some((entry) => entry.path === 'package.json'));
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('分析含 macOS 原生模块的 .app：降级为 C', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'win2mac-macapp-native-'));
  try {
    const bundle = await createMacApp(root, { withNative: true });
    const analysis = await analyzeMacApp(bundle);
    assert.equal(analysis.grade, 'C');
    assert.equal(analysis.nativeModuleCount, 1);
    assert.equal(analysis.nativeModules[0].archs[0], 'x86_64');
    await assert.rejects(
      () => assembleWindowsApp({ analysis, electronDir: root, outputDir: root }),
      /原生模块/,
    );
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('非 Electron .app 被明确拒绝', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'win2mac-macapp-nativeonly-'));
  try {
    const bundle = path.join(root, 'Native.app');
    await fsp.mkdir(path.join(bundle, 'Contents', 'MacOS'), { recursive: true });
    await fsp.writeFile(path.join(bundle, 'Contents', 'Info.plist'), INFO_PLIST);
    await fsp.writeFile(path.join(bundle, 'Contents', 'MacOS', 'DemoApp'), MACHO_ARM64);
    const analysis = await analyzeMacApp(bundle);
    assert.equal(analysis.isElectron, false);
    assert.equal(analysis.grade, 'D');
    assert.match(analysis.summary, /非 Electron/);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('组装 Windows 免安装包：重命名 exe、写入载荷与说明', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'win2mac-mactowin-'));
  try {
    const bundle = await createMacApp(root);
    const analysis = await analyzeMacApp(bundle);
    const electronDir = path.join(root, 'electron-dist');
    await fsp.mkdir(path.join(electronDir, 'resources'), { recursive: true });
    await fsp.writeFile(path.join(electronDir, 'electron.exe'), Buffer.from('MZ fake electron'));
    await fsp.writeFile(path.join(electronDir, 'resources', 'default_app.asar'), 'default');
    await fsp.writeFile(path.join(electronDir, 'icudtl.dat'), 'icu');
    const outputDir = path.join(root, 'out');
    const result = await assembleWindowsApp({ analysis, electronDir, outputDir });
    assert.ok(fs.existsSync(result.folderPath));
    assert.ok(fs.existsSync(path.join(result.folderPath, 'Demo.exe')));
    assert.equal(fs.existsSync(path.join(result.folderPath, 'electron.exe')), false);
    assert.equal(fs.existsSync(path.join(result.folderPath, 'resources', 'default_app.asar')), false);
    assert.ok(fs.existsSync(path.join(result.folderPath, 'resources', 'app.asar')));
    assert.ok(fs.existsSync(path.join(result.folderPath, 'Win2Mac-build.json')));
    assert.ok(fs.existsSync(path.join(result.folderPath, 'README-运行说明.txt')));
    assert.ok(fs.existsSync(result.zipPath));
    assert.ok(result.zipSize > 0);
    assert.equal(result.platform, 'windows');
    const entries = await new Promise((resolve, reject) => {
      const names = [];
      require('yauzl').open(result.zipPath, { lazyEntries: true }, (error, zip) => {
        if (error) return reject(error);
        zip.on('entry', (entry) => { names.push(entry.fileName); zip.readEntry(); });
        zip.on('end', () => resolve(names));
        zip.readEntry();
      });
    });
    assert.ok(entries.some((name) => name.endsWith('Demo.exe')), entries.join(','));
    assert.equal(entries.some((name) => name.endsWith('.zip')), false, 'ZIP 不能把自身写进包里');
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('Electron 版本与 SHASUMS 解析', async () => {
  assert.equal(normalizeElectronVersion('v30.0.0'), '30.0.0');
  assert.equal(normalizeElectronVersion('30.0'), '');
  const line = `${'a'.repeat(64)}  electron-v30.0.0-win32-x64.zip`;
  assert.equal(await readShasum(`x\n${line}\n`, 'electron-v30.0.0-win32-x64.zip'), 'a'.repeat(64));
  assert.equal(await readShasum(line, 'other.zip'), '');
});
