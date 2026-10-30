'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { analyzeMacApp, parseXmlPlist, parseBinaryPlist, readPlistSync, machOArchs, readAsarEntries } = require('../engine/macapp');
const { normalizeElectronVersion, readShasum, assembleWindowsApp, resolveElectronRuntime, electronCacheRoot } = require('../engine/mactowin');

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

test('解析真实二进制 plist（plistlib 生成）', () => {
  const info = readPlistSync(path.join(__dirname, 'fixtures', 'mac', 'Info.bplist'));
  assert.equal(info.CFBundleExecutable, 'DemoApp');
  assert.equal(info.CFBundleShortVersionString, '2.3.4');
  assert.equal(info.NSHighResolutionCapable, true);
  assert.deepEqual(info.CFBundleURLTypes[0].CFBundleURLSchemes, ['demo']);
  const framework = readPlistSync(path.join(__dirname, 'fixtures', 'mac', 'FrameworkInfo.bplist'));
  assert.equal(framework.CFBundleShortVersionString, '30.0.0');
});

test('二进制 Info.plist 的 .app 也能识别 Electron 版本', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'win2mac-bplist-'));
  try {
    const bundle = path.join(root, 'Bin.app');
    const contents = path.join(bundle, 'Contents');
    const resources = path.join(contents, 'Resources');
    const framework = path.join(contents, 'Frameworks', 'Electron Framework.framework', 'Resources');
    await fsp.mkdir(path.join(contents, 'MacOS'), { recursive: true });
    await fsp.mkdir(resources, { recursive: true });
    await fsp.mkdir(framework, { recursive: true });
    await fsp.copyFile(path.join(__dirname, 'fixtures', 'mac', 'Info.bplist'), path.join(contents, 'Info.plist'));
    await fsp.copyFile(path.join(__dirname, 'fixtures', 'mac', 'FrameworkInfo.bplist'), path.join(framework, 'Info.plist'));
    await fsp.writeFile(path.join(contents, 'MacOS', 'DemoApp'), MACHO_X64);
    writeAsar(path.join(resources, 'app.asar'), { 'package.json': '{}' });
    const analysis = await analyzeMacApp(bundle);
    assert.equal(analysis.isElectron, true);
    assert.equal(analysis.electronVersion, '30.0.0');
    assert.equal(analysis.name, 'Demo');
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('XML plist 支持十六进制实体并忽略非法码点', () => {
  const info = parseXmlPlist('<plist><dict><key>name</key><string>&#x4e2d;&#1114112;</string></dict></plist>');
  assert.equal(info.name, '中');
});

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

test('Mach-O 识别 64 位 fat 与字节序变体', () => {
  const fat64 = Buffer.alloc(8 + 2 * 32);
  fat64.writeUInt32BE(0xcafebabf, 0);
  fat64.writeUInt32BE(2, 4);
  fat64.writeUInt32BE(0x01000007, 8);
  fat64.writeUInt32BE(0x0100000c, 8 + 32);
  assert.deepEqual(machOArchs(fat64), ['x86_64', 'arm64']);

  const cigam64 = Buffer.alloc(8 + 2 * 32);
  cigam64.writeUInt32BE(0xbfbafeca, 0);
  cigam64.writeUInt32LE(2, 4);
  cigam64.writeUInt32LE(0x01000007, 8);
  cigam64.writeUInt32LE(0x0100000c, 8 + 32);
  assert.deepEqual(machOArchs(cigam64), ['x86_64', 'arm64']);

  const cigam32 = Buffer.alloc(8 + 2 * 20);
  cigam32.writeUInt32BE(0xbebafeca, 0);
  cigam32.writeUInt32LE(2, 4);
  cigam32.writeUInt32LE(0x0100000c, 8);
  cigam32.writeUInt32LE(0x01000007, 8 + 20);
  assert.deepEqual(machOArchs(cigam32), ['arm64', 'x86_64']);
});

test('通用 Mach-O 原生模块（打包与解包）都能识别', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'win2mac-macapp-fatnode-'));
  try {
    const bundle = await createMacApp(root, { withNative: true });
    const fat = Buffer.alloc(8 + 2 * 32);
    fat.writeUInt32BE(0xcafebabf, 0);
    fat.writeUInt32BE(2, 4);
    fat.writeUInt32BE(0x01000007, 8);
    fat.writeUInt32BE(0x0100000c, 8 + 32);
    const resources = path.join(bundle, 'Contents', 'Resources');
    await fsp.writeFile(path.join(resources, 'app.asar.unpacked', 'node_modules', 'native', 'demo.node'), fat);
    writeAsar(path.join(resources, 'app.asar'), {
      'package.json': '{}',
      'packed.node': fat,
    });
    const analysis = await analyzeMacApp(bundle);
    assert.equal(analysis.nativeModuleCount, 2);
    assert.equal(analysis.grade, 'C');
    assert.equal(analysis.nativeModules.length, 2);
    for (const module of analysis.nativeModules) {
      assert.ok(module.archs.includes('arm64'), JSON.stringify(module));
      assert.ok(module.archs.includes('x86_64'), JSON.stringify(module));
    }
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('缺少 Framework 时从 app.asar 内的 package.json 读取 Electron 版本', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'win2mac-macapp-asar-version-'));
  try {
    const bundle = path.join(root, 'AsarOnly.app');
    const contents = path.join(bundle, 'Contents');
    const resources = path.join(contents, 'Resources');
    await fsp.mkdir(path.join(contents, 'MacOS'), { recursive: true });
    await fsp.mkdir(resources, { recursive: true });
    await fsp.writeFile(path.join(contents, 'Info.plist'), INFO_PLIST);
    await fsp.writeFile(path.join(contents, 'MacOS', 'DemoApp'), MACHO_ARM64);
    writeAsar(path.join(resources, 'app.asar'), {
      'package.json': JSON.stringify({ name: 'demo', devDependencies: { electron: '^28.2.0' } }),
    });
    const analysis = await analyzeMacApp(bundle);
    assert.equal(analysis.isElectron, true);
    assert.equal(analysis.electronVersion, '28.2.0');
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('CFBundleExecutable 不能越过 Contents/MacOS 读取包外文件', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'win2mac-macapp-exe-path-'));
  try {
    const bundle = path.join(root, 'Demo.app');
    const contents = path.join(bundle, 'Contents');
    await fsp.mkdir(path.join(contents, 'MacOS'), { recursive: true });
    await fsp.writeFile(path.join(contents, 'Info.plist'), INFO_PLIST.replace('<string>DemoApp</string>', '<string>../../outside</string>'));
    await fsp.writeFile(path.join(root, 'outside'), MACHO_ARM64);
    const analysis = await analyzeMacApp(bundle);
    assert.equal(analysis.executable, '');
    assert.equal(analysis.exePath, '');
    assert.deepEqual(analysis.exeArchs, []);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
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
    await fsp.mkdir(path.join(outputDir, 'Other-Windows-x64'), { recursive: true });
    await fsp.writeFile(path.join(outputDir, 'Other-Windows-x64', 'x.txt'), 'other');
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
    assert.equal(entries.some((name) => name.includes('Other-Windows-x64')), false, 'ZIP 不能打包输出目录里的其他应用');
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

test('畸形二进制 plist 不会越界崩溃或超大循环', () => {
  assert.throws(() => parseBinaryPlist(Buffer.from('bplist00')), /二进制 plist/);
  // 构造“数组声明 2^32-1 个引用”的 bplist：解析器必须拒绝而不是循环 40 亿次。
  const buffer = Buffer.alloc(72);
  buffer.write('bplist00', 0, 'ascii');
  buffer[8] = 0xaf;
  buffer[9] = 0x12;
  buffer.writeUInt32BE(0xffffffff, 10);
  buffer[16] = 8;
  const trailer = 40;
  buffer[trailer + 6] = 1;
  buffer[trailer + 7] = 1;
  buffer.writeBigUInt64BE(1n, trailer + 8);
  buffer.writeBigUInt64BE(0n, trailer + 16);
  buffer.writeBigUInt64BE(16n, trailer + 24);
  assert.equal(parseBinaryPlist(buffer), null);
  // 偏移表越出文件也必须是受控错误。
  const badTable = Buffer.from(buffer);
  badTable.writeBigUInt64BE(4096n, trailer + 24);
  assert.throws(() => parseBinaryPlist(badTable), /偏移表/);
});

test('app.asar 条目尺寸异常时分析不抛出', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'win2mac-asar-bad-'));
  try {
    const bundle = await createMacApp(root);
    const asarPath = path.join(bundle, 'Contents', 'Resources', 'app.asar');
    const header = {
      files: {
        'package.json': { size: 2, offset: 0 },
        'broken.node': { size: -1, offset: -5 },
        'huge.node': { size: 1e15, offset: 0 },
      },
    };
    const headerJson = Buffer.from(JSON.stringify(header), 'utf8');
    const prefix = Buffer.alloc(16);
    prefix.writeUInt32LE(4, 0);
    prefix.writeUInt32LE(headerJson.length, 12);
    await fsp.writeFile(asarPath, Buffer.concat([prefix, headerJson, Buffer.from('{}')]));
    const analysis = await analyzeMacApp(bundle);
    assert.equal(analysis.isElectron, true);
    assert.equal(analysis.nativeModuleCount, 2);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('重组只复制源 .app 内的载荷', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'win2mac-mactowin-traversal-'));
  try {
    const bundle = await createMacApp(root);
    const analysis = await analyzeMacApp(bundle);
    const electronDir = path.join(root, 'electron-dist');
    await fsp.mkdir(path.join(electronDir, 'resources'), { recursive: true });
    await fsp.writeFile(path.join(electronDir, 'electron.exe'), Buffer.from('MZ fake electron'));
    const outside = path.join(root, 'outside.asar');
    await fsp.writeFile(outside, 'not part of the bundle');
    const outputDir = path.join(root, 'out');
    await assert.rejects(
      () => assembleWindowsApp({ analysis: { ...analysis, asarPath: outside }, electronDir, outputDir }),
      /不在源 \.app 内/,
    );
    assert.deepEqual(await fsp.readdir(outputDir), []);
    await assert.rejects(
      () => assembleWindowsApp({ analysis: { ...analysis, path: '' }, electronDir, outputDir }),
      /源 \.app 路径无效/,
    );
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('重组拒绝不是 .app 的源目录', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'win2mac-mactowin-notapp-'));
  try {
    const fake = path.join(root, 'not-an-app');
    await fsp.mkdir(fake, { recursive: true });
    await fsp.writeFile(path.join(fake, 'payload.asar'), 'fake');
    const outputDir = path.join(root, 'out');
    await assert.rejects(
      () => assembleWindowsApp({
        analysis: {
          isElectron: true,
          nativeModuleCount: 0,
          name: 'Fake',
          path: fake,
          asarPath: path.join(fake, 'payload.asar'),
        },
        electronDir: path.join(root, 'electron'),
        outputDir,
      }),
      /不是有效的 macOS/,
    );
    assert.equal(fs.existsSync(outputDir), false);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('重组拒绝通过目录联接读取 .app 外的载荷', async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'win2mac-mactowin-link-'));
  try {
    const bundle = await createMacApp(root);
    const outside = path.join(root, 'outside-unpacked');
    await fsp.mkdir(outside, { recursive: true });
    await fsp.writeFile(path.join(outside, 'secret.txt'), 'TOP SECRET');
    const unpacked = path.join(bundle, 'Contents', 'Resources', 'app.asar.unpacked');
    try {
      await fsp.symlink(outside, unpacked, process.platform === 'win32' ? 'junction' : 'dir');
    } catch (error) {
      t.skip(`当前环境无法创建目录链接：${error.code || error.message}`);
      return;
    }
    const analysis = await analyzeMacApp(bundle);
    const electronDir = path.join(root, 'electron-dist');
    await fsp.mkdir(path.join(electronDir, 'resources'), { recursive: true });
    await fsp.writeFile(path.join(electronDir, 'electron.exe'), Buffer.from('MZ fake electron'));
    const outputDir = path.join(root, 'out');
    await assert.rejects(
      () => assembleWindowsApp({ analysis, electronDir, outputDir }),
      /不在源 \.app 内/,
    );
    assert.deepEqual(await fsp.readdir(outputDir), []);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('手动 Electron 运行时缓存残缺时会重新解压并清理临时目录', async () => {
  const yazl = require('yazl');
  const { pipeline } = require('node:stream/promises');
  const saved = process.env.LOCALAPPDATA;
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'win2mac-electron-runtime-'));
  process.env.LOCALAPPDATA = root;
  try {
    const zipPath = path.join(root, 'electron-manual.zip');
    const electronExe = path.join(root, 'electron.exe');
    await fsp.writeFile(electronExe, Buffer.from('MZ fake electron'));
    await fsp.writeFile(path.join(root, 'icudtl.dat'), 'icu');
    const zip = new yazl.ZipFile();
    zip.addFile(electronExe, 'electron.exe');
    zip.addFile(path.join(root, 'icudtl.dat'), 'icudtl.dat');
    zip.end();
    await pipeline(zip.outputStream, fs.createWriteStream(zipPath));

    const first = await resolveElectronRuntime({ manualZip: zipPath });
    assert.equal(first.reused, false);
    assert.ok(fs.existsSync(path.join(first.dir, 'electron.exe')));

    // 模拟缓存目录只剩部分文件：旧实现会因 rename 目标已存在而永远无法恢复。
    await fsp.rm(path.join(first.dir, 'electron.exe'));
    await fsp.writeFile(path.join(first.dir, 'stale.bin'), 'stale');
    const second = await resolveElectronRuntime({ manualZip: zipPath });
    assert.equal(second.reused, false);
    assert.ok(fs.existsSync(path.join(second.dir, 'electron.exe')));
    assert.equal(fs.existsSync(path.join(second.dir, 'stale.bin')), false);

    const badZipPath = path.join(root, 'bad.zip');
    const badZip = new yazl.ZipFile();
    badZip.addFile(path.join(root, 'icudtl.dat'), 'icudtl.dat');
    badZip.end();
    await pipeline(badZip.outputStream, fs.createWriteStream(badZipPath));
    await assert.rejects(() => resolveElectronRuntime({ manualZip: badZipPath }), /缺少 electron\.exe/);

    const cacheEntries = await fsp.readdir(electronCacheRoot());
    assert.equal(cacheEntries.some((name) => name.endsWith('.tmp')), false);
  } finally {
    if (saved === undefined) delete process.env.LOCALAPPDATA;
    else process.env.LOCALAPPDATA = saved;
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('重组失败时清理半成品目录与 ZIP', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'win2mac-mactowin-cleanup-'));
  try {
    const bundle = await createMacApp(root);
    const analysis = await analyzeMacApp(bundle);
    const electronDir = path.join(root, 'electron-broken');
    await fsp.mkdir(path.join(electronDir, 'resources'), { recursive: true });
    await fsp.writeFile(path.join(electronDir, 'resources', 'icudtl.dat'), 'icu');
    const outputDir = path.join(root, 'out');
    await assert.rejects(() => assembleWindowsApp({ analysis, electronDir, outputDir }), /electron\.exe/);
    assert.deepEqual(await fsp.readdir(outputDir), []);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});
