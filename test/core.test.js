'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { parsePE } = require('../engine/pe');
const { buildInfoPlist, sanitizeBundleVersion } = require('../engine/plist');
const { buildIcns, readIcnsLayers } = require('../engine/icns');
const { parseCommandLine } = require('../engine/packager');
const { shortcutScore } = require('../engine/scanner');
const { normalizeAdvanced, normalizeExpectedExe, defaultInstallerAnalysis } = require('../engine/packager');
const { scanDirectoryRisks, analyzeApp } = require('../engine/analyzer');
const {
  shellQuote,
  payloadRelativeForWindowsPath,
  isPathInside,
  bundleIdentifier,
  sanitizeFilename,
  nameSimilarity,
} = require('../engine/util');

function makePE() {
  const buffer = Buffer.alloc(0x800);
  buffer.write('MZ', 0, 'ascii');
  buffer.writeUInt32LE(0x80, 0x3c);
  buffer.write('PE\0\0', 0x80, 'ascii');
  const coff = 0x84;
  buffer.writeUInt16LE(0x8664, coff); // x64
  buffer.writeUInt16LE(1, coff + 2); // one section
  buffer.writeUInt16LE(0xf0, coff + 16); // optional header size
  buffer.writeUInt16LE(0x0022, coff + 18); // executable + large address
  const opt = coff + 20;
  buffer.writeUInt16LE(0x20b, opt); // PE32+
  buffer.writeUInt16LE(2, opt + 68); // GUI subsystem
  buffer.writeUInt32LE(16, opt + 108);
  const dirs = opt + 112;
  buffer.writeUInt32LE(0x1000, dirs + 1 * 8); // import RVA
  buffer.writeUInt32LE(40, dirs + 1 * 8 + 4);
  buffer.writeUInt32LE(0x100, dirs + 2 * 8); // resources
  buffer.writeUInt32LE(0x100, dirs + 2 * 8 + 4);
  buffer.writeUInt32LE(0x1100, dirs + 14 * 8); // CLR
  buffer.writeUInt32LE(0x48, dirs + 14 * 8 + 4);

  const sectionTable = opt + 0xf0;
  buffer.write('.rdata', sectionTable, 'ascii');
  buffer.writeUInt32LE(0x200, sectionTable + 8);
  buffer.writeUInt32LE(0x1000, sectionTable + 12);
  buffer.writeUInt32LE(0x200, sectionTable + 16);
  buffer.writeUInt32LE(0x400, sectionTable + 20);

  const importDesc = 0x400;
  buffer.writeUInt32LE(0, importDesc);
  buffer.writeUInt32LE(0, importDesc + 4);
  buffer.writeUInt32LE(0, importDesc + 8);
  buffer.writeUInt32LE(0x1060, importDesc + 12);
  buffer.writeUInt32LE(0, importDesc + 16);
  buffer.write('KERNEL32.dll\0', 0x460, 'ascii');
  return buffer;
}

test('PE parser reads x64 GUI imports and CLR directory', () => {
  const pe = parsePE(makePE());
  assert.equal(pe.ok, true);
  assert.equal(pe.arch, 'x64');
  assert.equal(pe.is64Bit, true);
  assert.equal(pe.subsystem, 'gui');
  assert.deepEqual(pe.imports, ['kernel32.dll']);
  assert.equal(pe.isDotNet, true);
  assert.equal(pe.hasResources, true);
  assert.equal(pe.fileSize, 0x800);
});

test('PE parser rejects non-PE data', () => {
  const pe = parsePE(Buffer.from('not a windows executable'));
  assert.equal(pe.ok, false);
  assert.match(pe.error, /MZ|PE/);
});

test('Info.plist escapes values and normalizes versions', () => {
  const plist = buildInfoPlist({
    name: 'A & B',
    displayName: 'A <B>',
    identifier: 'com.win2mac.test',
    version: '1.2.3 beta',
    iconFile: 'icon',
    minimumSystemVersion: '11.0',
  });
  assert.match(plist, /<string>A &amp; B<\/string>/);
  assert.match(plist, /<string>A &lt;B&gt;<\/string>/);
  assert.match(plist, /<string>1\.2\.3<\/string>/);
  assert.match(plist, /CFBundlePackageType/);
  assert.equal(sanitizeBundleVersion('v2.5.1-beta'), '2.5.1');
  assert.equal(sanitizeBundleVersion(''), '1.0.0');
});

const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex');
test('ICNS builder writes valid PNG layers', () => {
  const icns = buildIcns({ 16: PNG, 256: PNG, 512: PNG });
  assert.equal(icns.toString('ascii', 0, 4), 'icns');
  assert.equal(icns.readUInt32BE(4), icns.length);
  const file = `${require('node:os').tmpdir()}/win2mac-test-${Date.now()}.icns`;
  require('node:fs').writeFileSync(file, icns);
  const layers = readIcnsLayers(file);
  assert.ok(layers.length >= 3);
  assert.ok(layers.some((layer) => layer.type === 'ic08'));
  require('node:fs').unlinkSync(file);
});

test('Steam client DLL is not treated as DRM but anti-cheat directories are', async () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'win2mac-risk-'));
  fs.writeFileSync(path.join(dir, 'steam_api64.dll'), 'x');
  fs.writeFileSync(path.join(dir, 'game.exe'), 'x');
  let risks = await scanDirectoryRisks(dir);
  assert.equal(risks.drmHits.length, 0);
  fs.mkdirSync(path.join(dir, 'EasyAntiCheat'));
  fs.writeFileSync(path.join(dir, 'EasyAntiCheat', 'EasyAntiCheat.exe'), 'x');
  risks = await scanDirectoryRisks(dir);
  assert.ok(risks.antiCheatHits.length > 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('advanced runtime options merge env vars and validate names', () => {
  const advanced = normalizeAdvanced({
    metalHud: true,
    dxvkHud: true,
    wineDebug: 'warn',
    verifyIntegrity: true,
    preventSleep: true,
    launchArgs: '--flag "value"',
    envText: ['CUSTOM=1', '# comment', 'EMPTY='].join(String.fromCharCode(10)),
  });
  assert.equal(advanced.wineDebug, 'warn');
  assert.equal(advanced.verifyIntegrity, true);
  assert.equal(advanced.preventSleep, true);
  assert.equal(advanced.launchArgs, '--flag "value"');
  assert.deepEqual(advanced.env, [
    { name: 'MTL_HUD_ENABLED', value: '1' },
    { name: 'DXVK_HUD', value: 'fps' },
    { name: 'CUSTOM', value: '1' },
    { name: 'EMPTY', value: '' },
  ]);
  assert.throws(() => normalizeAdvanced({ envText: 'BAD NAME=1' }), /环境变量名无效/);
  assert.throws(() => normalizeAdvanced({ envText: 'NO_EQUALS' }), /KEY=VALUE/);
});

test('installer mode normalizes expected exe and starts at C', () => {
  assert.equal(normalizeExpectedExe('C:/Program Files/App/App'), 'App.exe');
  assert.equal(normalizeExpectedExe('App.EXE'), 'App.EXE');
  assert.equal(normalizeExpectedExe(''), '');
  const analysis = defaultInstallerAnalysis('Setup App');
  assert.equal(analysis.grade, 'C');
  assert.equal(analysis.blocked, false);
  assert.ok(analysis.reasons.some((reason) => reason.code === 'installer-mode'));
});

test('Windows service dependencies downgrade to C instead of blocking', async () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'win2mac-svc-'));
  const exe = path.join(dir, 'notepad.exe');
  fs.writeFileSync(exe, makePE());
  const app = {
    name: 'Service Test', publisher: 'Test', version: '1.0', installPath: dir, exePath: exe,
    workingDirectory: dir, registryKeys: [], source: 'test', launchArgs: '',
  };
  const analysis = await analyzeApp(app, {
    services: [{ Name: 'TestService', DisplayName: 'Test Service', PathName: `"${exe}" -run` }],
  });
  assert.equal(analysis.blocked, false);
  assert.equal(analysis.grade, 'C');
  assert.ok(analysis.reasons.some((reason) => reason.code === 'windows-service' && reason.severity === 'warn'));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('shortcut matching never accepts unrelated system shortcuts', () => {
  const app = {
    name: 'Docker Desktop',
    installLocation: 'C:\\Program Files\\Docker\\Docker',
    exeCandidates: [{ path: 'C:\\Program Files\\Docker\\Docker\\Docker Desktop.exe' }],
  };
  assert.equal(shortcutScore(app, { name: 'Steps Recorder', target: 'C:\\Windows\\system32\\psr.exe' }), -100);
  assert.ok(shortcutScore(app, { name: 'Docker Desktop', target: 'C:\\Program Files\\Docker\\Docker\\Docker Desktop.exe' }) > 20);
});

test('Windows command line parser preserves quoted arguments', () => {
  assert.deepEqual(parseCommandLine('--test "hello world" "C:\\Program Files\\App\\a.exe" /q'), [
    '--test',
    'hello world',
    'C:\\Program Files\\App\\a.exe',
    '/q',
  ]);
  assert.deepEqual(parseCommandLine(''), []);
});

test('path mapping and shell quoting', () => {
  assert.equal(payloadRelativeForWindowsPath('C:\\Program Files\\Foo'), 'C/Program Files/Foo');
  assert.equal(payloadRelativeForWindowsPath('D:\\Apps\\Foo'), 'D/Apps/Foo');
  assert.ok(isPathInside('C:\\Program Files\\Foo\\a.exe', 'C:\\Program Files\\Foo'));
  assert.ok(!isPathInside('C:\\Program Files\\Foo2\\a.exe', 'C:\\Program Files\\Foo'));
  assert.equal(shellQuote("it's a test"), `'it'\\''s a test'`);
  assert.equal(bundleIdentifier('Foo', 'Bar', 'C:\\Foo').startsWith('com.win2mac.bar-foo.'), true);
  assert.equal(sanitizeFilename('A/B:C*D?'), 'A B C D');
  assert.ok(nameSimilarity('Adobe Photoshop 2024', 'Photoshop') > 0.5);
});

test('portable recipe round-trips build options without local paths', () => {
  const { buildRecipe, normalizeRecipe, recipeBuildOptions, inferInstallerPreset, recipeMatchScore, RECIPE_FORMAT } = require('../engine/recipe');
  const exePath = String.raw`C:\Apps\Recipe\Recipe.exe`;
  const installPath = String.raw`C:\Apps\Recipe`;
  const recipe = buildRecipe({
    app: {
      name: 'Recipe App', publisher: 'Recipe Co', version: '2.1.0', exePath,
      installPath, estimatedSizeBytes: 123456, bits: 64, source: 'registry',
    },
    analysis: { grade: 'B', gradeLabel: '通常可运行', gradeSummary: '.NET Framework', recommendedEngine: 'wine' },
    options: {
      engineMode: 'bundled', includeRuntimes: true, includeWineMono: true, includeUserData: false,
      advanced: { metalHud: true, verifyIntegrity: true, preventSleep: true, wineDebug: 'warn', launchArgs: '--safe', envText: 'CUSTOM=1' },
    },
    generatorVersion: '0.3.0',
  });
  assert.equal(recipe.format, RECIPE_FORMAT);
  assert.equal(recipe.app.exeName, 'Recipe.exe');
  assert.equal(recipe.match.name, 'Recipe App');
  assert.equal(JSON.stringify(recipe).includes(exePath), false);
  assert.equal(recipe.options.engineMode, 'bundled');
  assert.equal(recipe.options.advanced.metalHud, true);
  assert.equal(recipe.options.advanced.env, undefined);

  const restored = normalizeRecipe(JSON.parse(JSON.stringify(recipe)));
  assert.deepEqual(restored, recipe);
  const options = recipeBuildOptions(restored);
  assert.equal(options.engineMode, 'bundled');
  assert.equal(options.advanced.verifyIntegrity, true);
  assert.equal(options.advanced.envText, 'CUSTOM=1');
  assert.equal(options.includeRuntimes, true);

  assert.throws(() => normalizeRecipe({ ...recipe, format: 'v0' }), /不支持的配方格式/);
  assert.throws(() => normalizeRecipe({ ...recipe, options: { ...recipe.options, engineMode: 'magic' } }), /运行引擎选项无效/);
  assert.throws(() => normalizeRecipe({ ...recipe, options: { ...recipe.options, advanced: { envText: 'BAD NAME=1' } } }), /环境变量名无效/);
  assert.throws(() => buildRecipe({ ...recipe, notes: 'x'.repeat(3000) }), /备注过长/);
  assert.equal(inferInstallerPreset('/S', 'exe'), 'nsis');
  assert.equal(inferInstallerPreset('/VERYSILENT /SUPPRESSMSGBOXES /NORESTART', 'exe'), 'inno');
  assert.equal(inferInstallerPreset('/qn /norestart', 'msi'), 'msi');
  assert.equal(inferInstallerPreset('/D=C:\Apps', 'exe'), 'custom');
  assert.ok(recipeMatchScore(recipe, { name: 'Recipe App', exePath: 'D:\Other\Recipe.exe', publisher: 'Recipe Co' }) >= 100);
});

test('dragged folder prefers the plausible main executable', async () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { resolveDroppedFolder } = require('../engine/drop');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'win2mac-drop-'));
  fs.mkdirSync(path.join(dir, 'bin'));
  fs.writeFileSync(path.join(dir, 'My App.exe'), Buffer.alloc(6000));
  fs.writeFileSync(path.join(dir, 'unins000.exe'), Buffer.alloc(7000));
  fs.writeFileSync(path.join(dir, 'setup.exe'), Buffer.alloc(8000));
  fs.writeFileSync(path.join(dir, 'bin', 'My App Helper.exe'), Buffer.alloc(9000));
  fs.writeFileSync(path.join(dir, 'readme.txt'), 'hello');
  const result = await resolveDroppedFolder(dir);
  assert.equal(path.basename(result.exePath), 'My App.exe');
  assert.ok(result.candidates.length >= 2);
  fs.rmSync(dir, { recursive: true, force: true });
  await assert.rejects(resolveDroppedFolder(path.join(os.tmpdir(), 'win2mac-missing-folder')), /不存在/);
});

test('cache stats and clearing stay inside Win2Mac local cache', async () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const saved = process.env.LOCALAPPDATA;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'win2mac-cache-'));
  process.env.LOCALAPPDATA = root;
  try {
    const { cachePaths, collectCacheStats, clearCaches } = require('../engine/cache');
    const paths = cachePaths();
    fs.mkdirSync(paths.engines, { recursive: true });
    fs.mkdirSync(paths.runtimes, { recursive: true });
    fs.writeFileSync(path.join(paths.engines, 'wine.tar.xz'), Buffer.alloc(4096));
    fs.writeFileSync(path.join(paths.runtimes, 'vc_redist.x64.exe'), Buffer.alloc(2048));
    const before = await collectCacheStats();
    assert.equal(before.groups.find((group) => group.key === 'engines').bytes, 4096);
    assert.equal(before.groups.find((group) => group.key === 'runtimes').files, 1);
    const cleared = await clearCaches(['engines']);
    assert.ok(cleared.clearedBytes >= 4096);
    assert.equal(cleared.stats.groups.find((group) => group.key === 'engines').bytes, 0);
    assert.equal(cleared.stats.groups.find((group) => group.key === 'runtimes').bytes, 2048);
    assert.ok(fs.existsSync(paths.engines));
    await assert.rejects(clearCaches([]), /没有选择/);
  } finally {
    if (saved === undefined) delete process.env.LOCALAPPDATA;
    else process.env.LOCALAPPDATA = saved;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('macOS shell templates use LF line endings', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const templates = ['launcher.sh', 'open-me.command', 'verify-integrity.command', 'reset-runtime.command', 'mac-check.command'];
  for (const name of templates) {
    const data = fs.readFileSync(path.join(__dirname, '..', 'resources', 'templates', name));
    assert.equal(data.includes(Buffer.from('\r\n')), false, `${name} contains CRLF`);
    assert.equal(data[0], 0x23, `${name} should start with #`);
  }
});

test('zip import rejects unsafe paths and finds the app root', async () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const yazl = require('yazl');
  const { pipeline } = require('node:stream/promises');
  const { extractZip, findAppRoot, safeEntryPath } = require('../engine/archive');
  const { resolveDroppedFolder } = require('../engine/drop');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'win2mac-zip-'));
  try {
    const source = path.join(root, '客源雷达');
    fs.mkdirSync(path.join(source, 'resources'), { recursive: true });
    fs.writeFileSync(path.join(source, '客源雷达.exe'), Buffer.alloc(6000));
    fs.writeFileSync(path.join(source, 'Uninstall 客源雷达.exe'), Buffer.alloc(5000));
    fs.writeFileSync(path.join(source, 'resources', 'app.asar'), Buffer.from('fake asar'));
    const zipPath = path.join(root, 'app.zip');
    const zip = new yazl.ZipFile();
    zip.addFile(path.join(source, '客源雷达.exe'), '客源雷达/客源雷达.exe');
    zip.addFile(path.join(source, 'Uninstall 客源雷达.exe'), '客源雷达/Uninstall 客源雷达.exe');
    zip.addFile(path.join(source, 'resources', 'app.asar'), '客源雷达/resources/app.asar');
    zip.end();
    await pipeline(zip.outputStream, fs.createWriteStream(zipPath));

    const extracted = path.join(root, 'extracted');
    const result = await extractZip(zipPath, extracted);
    assert.equal(result.files, 3);
    assert.ok(fs.existsSync(path.join(extracted, '客源雷达', '客源雷达.exe')));
    assert.equal(await findAppRoot(extracted), path.join(extracted, '客源雷达'));
    assert.equal((await resolveDroppedFolder(path.join(extracted, '客源雷达'))).exePath, path.join(extracted, '客源雷达', '客源雷达.exe'));

    // Mirror a Windows "compress contents" ZIP: files at archive root and a random extraction folder name.
    const flatRoot = path.join(root, 'flat');
    fs.mkdirSync(flatRoot, { recursive: true });
    fs.writeFileSync(path.join(flatRoot, '客源雷达.exe'), Buffer.alloc(6000));
    fs.writeFileSync(path.join(flatRoot, 'Uninstall 客源雷达.exe'), Buffer.alloc(7000));
    const flatZip = new yazl.ZipFile();
    flatZip.addFile(path.join(flatRoot, '客源雷达.exe'), '客源雷达.exe');
    flatZip.addFile(path.join(flatRoot, 'Uninstall 客源雷达.exe'), 'Uninstall 客源雷达.exe');
    flatZip.end();
    const flatZipPath = path.join(root, 'flat.zip');
    await pipeline(flatZip.outputStream, fs.createWriteStream(flatZipPath));
    const flatExtract = path.join(root, 'zip-random-name');
    await extractZip(flatZipPath, flatExtract);
    assert.equal(await findAppRoot(flatExtract), flatExtract);
    assert.equal((await resolveDroppedFolder(flatExtract)).exePath, path.join(flatExtract, '客源雷达.exe'));

    assert.equal(safeEntryPath('客源雷达/客源雷达.exe'), '客源雷达/客源雷达.exe');
    assert.equal(safeEntryPath('../evil.txt'), null);
    assert.equal(safeEntryPath('C:\Windows\evil.txt'), null);
    assert.equal(safeEntryPath('/absolute/evil.txt'), null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('macOS shell templates brace variables before Unicode text', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  for (const name of ['launcher.sh', 'mac-check.command', 'open-me.command', 'verify-integrity.command', 'reset-runtime.command']) {
    const source = fs.readFileSync(path.join(__dirname, '..', 'resources', 'templates', name), 'utf8');
    assert.equal(/\$[A-Za-z_][A-Za-z0-9_]*(?=[^ -])/.test(source), false, `${name} has an unbraced variable before Unicode text`);
  }
});
