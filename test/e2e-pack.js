'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const http = require('node:http');
const { analyzeApp } = require('../engine/analyzer');
const { buildBundle } = require('../engine/packager');
const { buildRecipe } = require('../engine/recipe');
const { safeRemove, sha256File } = require('../engine/util');

const ROOT = path.join(__dirname, '..');
const WORK = path.join(__dirname, '.e2e');
const FIXTURE_ROOT = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Win2Mac-E2E');
const FIXTURE = path.join(FIXTURE_ROOT, 'NativeApp');
const REG_KEY = 'HKCU\\Software\\Win2MacE2E';

function toMsys(p) {
  const abs = path.resolve(p);
  return `/${abs[0].toLowerCase()}${abs.slice(2).replace(/\\/g, '/')}`;
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], ...options, windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr?.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

async function setupFixture() {
  await safeRemove(FIXTURE_ROOT);
  await fsp.mkdir(path.join(FIXTURE, 'data'), { recursive: true });
  await fsp.copyFile(path.join(process.env.SystemRoot, 'System32', 'notepad.exe'), path.join(FIXTURE, 'notepad.exe'));
  await fsp.writeFile(path.join(FIXTURE, 'data', 'hello.txt'), 'Win2Mac E2E 中文文件\n', 'utf8');
  await fsp.writeFile(path.join(FIXTURE, 'readme.ini'), '[app]\nname=Win2Mac E2E\n', 'utf8');
  const reg = await run('reg.exe', ['add', REG_KEY, '/v', 'InstallDir', '/t', 'REG_SZ', '/d', FIXTURE, '/f']);
  assert.equal(reg.code, 0, reg.stderr);
}

async function cleanupFixture() {
  await run('reg.exe', ['delete', REG_KEY, '/f']);
  await safeRemove(FIXTURE_ROOT);
}

async function createWineStub(dir) {
  await fsp.mkdir(dir, { recursive: true });
  const stub = path.join(dir, 'wine-stub');
  const wineserver = path.join(dir, 'wineserver');
  await fsp.writeFile(
    stub,
    `#!/bin/bash
printf '%s\\n' "WINE $*" >> "$STUB_LOG"
case "$1" in
  wineboot)
    mkdir -p "$WINEPREFIX/drive_c/users/tester/AppData/Roaming"
    ;;
  reg)
    ;;
  start)
    ;;
  msiexec)
    ;;
  *win2mac-installer*)
    mkdir -p "$WINEPREFIX/drive_c/Program Files/Fake App"
    printf 'fake exe' > "$WINEPREFIX/drive_c/Program Files/Fake App/Fake App.exe"
    printf 'INSTALLED:%s\\n' "$*" >> "$STUB_LOG"
    ;;
  *)
    printf 'ENV:%s\\n' "\${WIN2MAC_ADV_TEST:-}" >> "$STUB_LOG"
    printf 'launched:%s\\n' "$*" >> "$STUB_LOG"
    touch "$WINEPREFIX/launched.marker"
    ;;
esac
exit 0
`,
  );
  await fsp.writeFile(
    wineserver,
    `#!/bin/bash
printf '%s\\n' "WINESERVER $*" >> "$STUB_LOG"
exit 0
`,
  );
  await fsp.chmod(stub, 0o755);
  await fsp.chmod(wineserver, 0o755);
  return { stub, wineserver };
}


async function createFakeEngineArchive() {
  const base = path.join(WORK, 'fake-engine');
  const stubDir = path.join(base, 'stub');
  const { stub, wineserver } = await createWineStub(stubDir);
  const nested = path.join(base, 'tree', 'Fake Wine.app', 'Contents', 'Resources', 'wine', 'bin');
  await fsp.mkdir(nested, { recursive: true });
  await fsp.copyFile(stub, path.join(nested, 'wine'));
  await fsp.copyFile(wineserver, path.join(nested, 'wineserver'));
  await fsp.chmod(path.join(nested, 'wine'), 0o755);
  await fsp.chmod(path.join(nested, 'wineserver'), 0o755);
  const archive = path.join(WORK, 'fake-wine.tar.xz');
  const py = `
import os, sys, tarfile
src, dst = sys.argv[1], sys.argv[2]
with tarfile.open(dst, 'w:xz') as t:
    for root, dirs, files in os.walk(src):
        for name in files:
            p = os.path.join(root, name)
            t.add(p, arcname=os.path.relpath(p, src).replace(os.sep, '/'))
`;
  const result = await run('python', ['-c', py, path.join(base, 'tree'), archive]);
  assert.equal(result.code, 0, result.stderr);
  return archive;
}

function hashFile(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

async function main() {
  if (process.platform !== 'win32') throw new Error('E2E 仅支持 Windows');
  await safeRemove(WORK);
  await fsp.mkdir(WORK, { recursive: true });
  await setupFixture();
  try {
    const app = {
      name: 'Win2Mac E2E Notepad',
      publisher: 'Win2Mac Tests',
      version: '9.9.9',
      installPath: FIXTURE,
      exePath: path.join(FIXTURE, 'notepad.exe'),
      workingDirectory: FIXTURE,
      displayIcon: path.join(FIXTURE, 'notepad.exe'),
      launchArgs: '--test "hello world"',
      registryKeys: [REG_KEY],
      source: 'e2e',
      warnings: [],
    };
    console.log('Analyzing fixture…');
    const analysis = await analyzeApp(app, { services: [] });
    assert.equal(analysis.pe.arch, 'x64');
    console.log(`Grade ${analysis.grade} (${analysis.score})`);

    const outDir = path.join(WORK, 'out');
    console.log('Building bundle…');
    const result = await buildBundle(
      {
        app,
        analysis,
        outputDir: outDir,
        engineMode: 'reuse',
        includeRuntimes: false,
        advanced: {
          metalHud: true,
          dxvkHud: true,
          verifyIntegrity: false,
          preventSleep: false,
          wineDebug: 'warn',
          launchArgs: '--adv "advanced value"',
          envText: 'WIN2MAC_ADV_TEST=ok',
        },
      },
      (progress) => {
        if (progress.message) process.stdout.write(`  [${progress.stage}] ${progress.message}\n`);
      },
    );
    assert.ok(fs.existsSync(result.appPath), 'app bundle exists');
    assert.ok(fs.existsSync(result.zipPath), 'zip exists');
    assert.ok(result.zipSize > 0);
    assert.equal(result.bundleId.startsWith('com.win2mac.'), true);

    const contents = path.join(result.appPath, 'Contents');
    const win2mac = path.join(contents, 'Resources', 'win2mac');
    const config = fs.readFileSync(path.join(win2mac, 'config.env'), 'utf8');
    assert.match(config, /WIN2MAC_APP_NAME='Win2Mac E2E Notepad'/);
    assert.match(config, /WIN2MAC_EXE_PAYLOAD='C\/Users\//);
    assert.match(config, /WIN2MAC_ARG_COUNT='2'/);
    assert.match(config, /WIN2MAC_ARG_1='--adv'/);
    assert.match(config, /WIN2MAC_ARG_2='advanced value'/);
    assert.match(config, /WIN2MAC_ENV_COUNT='3'/);
    assert.match(config, /WIN2MAC_ENV_1_NAME='MTL_HUD_ENABLED'/);
    assert.match(config, /WIN2MAC_ENV_2_NAME='DXVK_HUD'/);
    assert.match(config, /WIN2MAC_ENV_3_NAME='WIN2MAC_ADV_TEST'/);
    assert.match(config, /WIN2MAC_WINEDEBUG='warn'/);
    assert.match(config, /WIN2MAC_REGISTRY_COUNT='1'/);
    assert.ok(fs.existsSync(path.join(win2mac, 'registry', '1.reg')));
    const plist = fs.readFileSync(path.join(contents, 'Info.plist'), 'utf8');
    assert.match(plist, /<string>Win2Mac E2E Notepad<\/string>/);
    assert.match(plist, /<string>9\.9\.9<\/string>/);
    assert.ok(fs.existsSync(path.join(contents, 'Resources', 'icon.icns')));

    const manifest = fs.readFileSync(path.join(win2mac, 'manifest.sha256'), 'utf8').trim().split('\n');
    assert.equal(manifest.length, 3);
    for (const line of manifest) {
      const [hash, rel] = line.split('  ');
      const file = path.join(win2mac, 'payload', ...rel.split('/'));
      assert.equal(await sha256File(file), hash, `manifest hash ${rel}`);
    }
    assert.equal(hashFile(path.join(win2mac, 'payload', ...config.match(/WIN2MAC_EXE_PAYLOAD='([^']+)'/)[1].split('/'))), hashFile(app.exePath));

    const zipCheck = await run('python', ['-c', `
import zipfile, sys, json
p = sys.argv[1]
z = zipfile.ZipFile(p)
assert z.testzip() is None
infos = z.infolist()
launcher = [i for i in infos if i.filename.endswith('/Contents/MacOS/launcher')][0]
cmd = [i for i in infos if i.filename.endswith('.command')]
root_cmd = [i for i in infos if i.filename.count('/') == 1 and i.filename.endswith('.command')]
print(json.dumps({'launcher_mode': (launcher.external_attr >> 16) & 0o777, 'root_command_modes': [(i.filename, (i.external_attr >> 16) & 0o777) for i in root_cmd], 'readme': [i.filename for i in infos if 'README' in i.filename], 'n': len(infos)}))
`, result.zipPath]);
    assert.equal(zipCheck.code, 0, zipCheck.stderr);
    const zipInfo = JSON.parse(zipCheck.stdout.trim());
    assert.equal(zipInfo.launcher_mode, 0o755);
    assert.ok(zipInfo.root_command_modes.length >= 4);
    assert.ok(zipInfo.root_command_modes.every(([, mode]) => mode === 0o755));
    assert.ok(zipInfo.root_command_modes.some(([name]) => name.endsWith('/Start-Mac-Validation.command')));
    assert.ok(fs.existsSync(path.join(path.dirname(result.appPath), 'Start-Mac-Validation.command')));

    assert.equal(fs.readFileSync(path.join(contents, 'MacOS', 'launcher')).includes(Buffer.from(String.fromCharCode(13, 10))), false, 'launcher must use LF');
    const generatedReadme = fs.readFileSync(path.join(path.dirname(result.appPath), 'README-使用说明.html'), 'utf8');
    assert.match(generatedReadme, /Start-Mac-Validation/);
    assert.equal(generatedReadme.includes('{{'), false, 'generated README must not contain placeholders');
    assert.ok(zipInfo.readme.some((name) => name.includes('使用说明')));

    const verify = await run('bash', ['Verify-Integrity.command'], { cwd: path.dirname(result.appPath) });
    assert.equal(verify.code, 0, `integrity helper failed: ${verify.stdout}
${verify.stderr}`);
    assert.match(verify.stdout, /校验通过/);

    const home = path.join(WORK, 'home');
    const prefixRoot = path.join(WORK, 'prefixes');
    const logDir = path.join(WORK, 'logs');
    const stubDir = path.join(WORK, 'stub');
    const { stub } = await createWineStub(stubDir);
    const stubLog = path.join(WORK, 'stub.log');
    await fsp.writeFile(stubLog, '', 'utf8');
    const launcher = path.join(contents, 'MacOS', 'launcher');
    const env = {
      ...process.env,
      HOME: toMsys(home),
      WIN2MAC_PREFIX_ROOT: toMsys(prefixRoot),
      WIN2MAC_LOG_DIR: toMsys(logDir),
      WIN2MAC_WINE: toMsys(stub),
      STUB_LOG: toMsys(stubLog),
      MSYS: 'winsymlinks:nativestrict',
    };
    console.log('Running launcher (first run)…');
    const first = await run('bash', [launcher], { env, cwd: WORK });
    assert.equal(first.code, 0, `first launch failed: ${first.stdout}\n${first.stderr}`);
    const firstStub = await fsp.readFile(stubLog, 'utf8');
    assert.match(firstStub, /WINE wineboot -u/);
    assert.match(firstStub, /WINE reg import/);
    assert.match(firstStub, /ENV:ok/);
    assert.match(firstStub, /launched:.*--adv advanced value/);
    const appLogPath = path.join(logDir, result.buildId + '.log');
    assert.ok(fs.existsSync(appLogPath), 'launcher log exists');
    const firstLog = await fsp.readFile(appLogPath, 'utf8');
    assert.match(firstLog, /Using engine: wine/);
    assert.match(firstLog, /Launching:/);

    const prefix = path.join(prefixRoot, result.buildId);
    assert.ok(fs.existsSync(path.join(prefix, '.win2mac', 'initialized')));
    assert.ok(fs.existsSync(path.join(prefix, '.win2mac', 'payload-version')));
    assert.ok(fs.existsSync(path.join(prefix, 'launched.marker')));
    const copiedExe = path.join(prefix, 'drive_c', ...config.match(/WIN2MAC_EXE_PAYLOAD='([^']+)'/)[1].split('/').slice(1));
    assert.ok(fs.existsSync(copiedExe), 'exe copied into prefix');
    assert.equal(hashFile(copiedExe), hashFile(app.exePath), 'exe copied byte-for-byte');

    console.log('Running launcher (second run)…');
    const second = await run('bash', [launcher], { env, cwd: WORK });
    assert.equal(second.code, 0, `second launch failed: ${second.stdout}\n${second.stderr}`);
    const fullLog = await fsp.readFile(appLogPath, 'utf8');
    assert.equal((fullLog.match(/Copying payload drive/g) || []).length, 1, 'payload copied only once');
    assert.equal((fullLog.match(/Initializing prefix/g) || []).length, 1, 'prefix initialized only once');

    console.log('Building bundle with bundled engine…');
    const fakeArchive = await createFakeEngineArchive();
    const fatResult = await buildBundle({
      app,
      analysis,
      outputDir: path.join(WORK, 'out-fat'),
      engineMode: 'bundled',
      manualEngineArchive: fakeArchive,
      includeRuntimes: false,
    });
    const fatContents = path.join(fatResult.appPath, 'Contents');
    const fatWin2mac = path.join(fatContents, 'Resources', 'win2mac');
    const fatConfig = fs.readFileSync(path.join(fatWin2mac, 'config.env'), 'utf8');
    assert.match(fatConfig, /WIN2MAC_ENGINE_POLICY='bundled'/);
    assert.match(fatConfig, /WIN2MAC_ENGINE_ARCHIVE='engine\//);
    assert.ok(fs.existsSync(path.join(fatWin2mac, 'engine', 'fake-wine.tar.xz')));
    assert.ok(fs.existsSync(path.join(fatResult.zipPath)));
    const fatHome = path.join(WORK, 'home-fat');
    const fatPrefixRoot = path.join(WORK, 'prefixes-fat');
    const fatLogDir = path.join(WORK, 'logs-fat');
    const fatCache = path.join(WORK, 'cache-fat');
    const fatStubLog = path.join(WORK, 'stub-fat.log');
    await fsp.writeFile(fatStubLog, '', 'utf8');
    const fatEnv = {
      ...process.env,
      HOME: toMsys(fatHome),
      WIN2MAC_PREFIX_ROOT: toMsys(fatPrefixRoot),
      WIN2MAC_LOG_DIR: toMsys(fatLogDir),
      WIN2MAC_CACHE_ROOT: toMsys(fatCache),
      STUB_LOG: toMsys(fatStubLog),
      MSYS: 'winsymlinks:nativestrict',
    };
    delete fatEnv.WIN2MAC_WINE;
    console.log('Running launcher with bundled engine…');
    const fatRun = await run('bash', [path.join(fatContents, 'MacOS', 'launcher')], { env: fatEnv, cwd: WORK });
    assert.equal(fatRun.code, 0, `bundled engine launch failed: ${fatRun.stdout}\n${fatRun.stderr}`);
    const fatLog = await fsp.readFile(path.join(fatLogDir, fatResult.buildId + '.log'), 'utf8');
    assert.match(fatLog, /Using engine: wine/);
    assert.match(fatLog, /Fake Wine\.app\/Contents\/Resources\/wine\/bin\/wine/);
    assert.ok(fs.existsSync(path.join(fatCache, 'engines')), 'engine extracted to cache');
    const fatStub = await fsp.readFile(fatStubLog, 'utf8');
    assert.match(fatStub, /WINE wineboot -u/);
    assert.match(fatStub, /launched:/);

    console.log('Testing runtime engine download + cache…');
    const thinConfigPath = path.join(win2mac, 'config.env');
    const fakeSha = await sha256File(fakeArchive);
    let requests = 0;
    const server = http.createServer((req, res) => {
      requests += 1;
      const data = fs.readFileSync(fakeArchive);
      const range = /bytes=(\d+)-(\d*)/.exec(req.headers.range || '');
      if (range) {
        const start = Number(range[1]);
        const end = range[2] ? Number(range[2]) : data.length - 1;
        res.writeHead(206, {
          'Content-Type': 'application/x-xz',
          'Accept-Ranges': 'bytes',
          'Content-Range': `bytes ${start}-${end}/${data.length}`,
          'Content-Length': end - start + 1,
        });
        res.end(data.subarray(start, end + 1));
      } else {
        res.writeHead(200, { 'Content-Type': 'application/x-xz', 'Accept-Ranges': 'bytes', 'Content-Length': data.length });
        res.end(data);
      }
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    try {
      let cfg = fs.readFileSync(thinConfigPath, 'utf8');
      cfg = cfg
        .replace(/WIN2MAC_ENGINE_POLICY='[^']*'/, "WIN2MAC_ENGINE_POLICY='auto'")
        .replace(/WIN2MAC_ENGINE_ORDER='[^']*'/, "WIN2MAC_ENGINE_ORDER='wine'")
        .replace(/WIN2MAC_ENGINE_URL='[^']*'/, `WIN2MAC_ENGINE_URL='http://127.0.0.1:${port}/fake-wine.tar.xz'`)
        .replace(/WIN2MAC_ENGINE_SHA256='[^']*'/, `WIN2MAC_ENGINE_SHA256='${fakeSha}'`);
      fs.writeFileSync(thinConfigPath, cfg);
      const thinHome = path.join(WORK, 'home-download');
      const thinPrefix = path.join(WORK, 'prefixes-download');
      const thinLogs = path.join(WORK, 'logs-download');
      const thinCache = path.join(WORK, 'cache-download');
      const thinStubLog = path.join(WORK, 'stub-download.log');
      await fsp.writeFile(thinStubLog, '', 'utf8');
      const thinEnv = {
        ...process.env,
        HOME: toMsys(thinHome),
        WIN2MAC_PREFIX_ROOT: toMsys(thinPrefix),
        WIN2MAC_LOG_DIR: toMsys(thinLogs),
        WIN2MAC_CACHE_ROOT: toMsys(thinCache),
        STUB_LOG: toMsys(thinStubLog),
        MSYS: 'winsymlinks:nativestrict',
      };
      delete thinEnv.WIN2MAC_WINE;
      const thinLauncher = path.join(contents, 'MacOS', 'launcher');
      const runDownload = await run('bash', [thinLauncher], { env: thinEnv, cwd: WORK });
      assert.equal(runDownload.code, 0, `runtime download launch failed: ${runDownload.stdout}\n${runDownload.stderr}`);
      assert.ok(requests >= 1, 'engine download was requested');
      const downloadLog = await fsp.readFile(path.join(thinLogs, result.buildId + '.log'), 'utf8');
      assert.match(downloadLog, /Download attempt 1\/5/);
      assert.match(downloadLog, /Using engine: wine/);
      assert.match(downloadLog, /Fake Wine\.app\/Contents\/Resources\/wine\/bin\/wine/);
      const downloadStub = await fsp.readFile(thinStubLog, 'utf8');
      assert.match(downloadStub, /launched:/);
      assert.ok(fs.existsSync(path.join(thinCache, 'engines')), 'downloaded engine extracted to cache');
      const requestsBefore = requests;
      const runCached = await run('bash', [thinLauncher], { env: thinEnv, cwd: WORK });
      assert.equal(runCached.code, 0, `cached engine launch failed: ${runCached.stdout}\n${runCached.stderr}`);
      assert.equal(requests, requestsBefore, 'second launch did not redownload the engine');
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }

    console.log('Testing installer-first workflow…');
    const fakeInstaller = path.join(WORK, 'FakeSetup.exe');
    await fsp.writeFile(fakeInstaller, 'fake installer payload');
    const installerResult = await buildBundle({
      app: { name: 'Fake Installer App', publisher: 'Win2Mac Tests', version: '1.0', source: 'installer' },
      installer: { path: fakeInstaller, type: 'exe', args: '/S', expectedExe: 'Fake App.exe' },
      outputDir: path.join(WORK, 'out-installer'),
      engineMode: 'reuse',
      includeRuntimes: false,
      advanced: { launchArgs: '--after-install "hello world"' },
    });
    assert.equal(installerResult.mode, 'installer');
    const instWin2mac = path.join(installerResult.appPath, 'Contents', 'Resources', 'win2mac');
    const instConfig = fs.readFileSync(path.join(instWin2mac, 'config.env'), 'utf8');
    assert.ok(instConfig.includes("WIN2MAC_INSTALLER_MODE='1'"));
    assert.ok(instConfig.includes("WIN2MAC_INSTALLER_ARG_1='/S'"));
    assert.ok(instConfig.includes("WIN2MAC_EXPECTED_EXE='Fake App.exe'"));
    assert.ok(fs.existsSync(path.join(instWin2mac, 'payload', 'C', 'win2mac-installer', 'FakeSetup.exe')));
    const instHome = path.join(WORK, 'home-installer');
    const instPrefix = path.join(WORK, 'prefixes-installer');
    const instLogs = path.join(WORK, 'logs-installer');
    const instStubLog = path.join(WORK, 'stub-installer.log');
    await fsp.writeFile(instStubLog, '', 'utf8');
    const instEnv = {
      ...process.env,
      HOME: toMsys(instHome),
      WIN2MAC_PREFIX_ROOT: toMsys(instPrefix),
      WIN2MAC_LOG_DIR: toMsys(instLogs),
      STUB_LOG: toMsys(instStubLog),
      WIN2MAC_WINE: toMsys(stub),
      MSYS: 'winsymlinks:nativestrict',
    };
    const instLauncher = path.join(installerResult.appPath, 'Contents', 'MacOS', 'launcher');
    const instFirst = await run('bash', [instLauncher], { env: instEnv, cwd: WORK });
    assert.equal(instFirst.code, 0, `installer launch failed: ${instFirst.stdout}\n${instFirst.stderr}`);
    const instStubFirst = await fsp.readFile(instStubLog, 'utf8');
    assert.ok(instStubFirst.includes('INSTALLED:'));
    assert.ok(instStubFirst.includes('Fake App.exe --after-install hello world'));
    const instLog = await fsp.readFile(path.join(instLogs, installerResult.buildId + '.log'), 'utf8');
    assert.match(instLog, /Discovered installed app:/);
    assert.ok(fs.existsSync(path.join(instPrefix, installerResult.buildId, '.win2mac', 'installer-ran')));
    assert.ok(fs.existsSync(path.join(instPrefix, installerResult.buildId, '.win2mac', 'discovered-exe')));
    await fsp.writeFile(instStubLog, '', 'utf8');
    const instSecond = await run('bash', [instLauncher], { env: instEnv, cwd: WORK });
    assert.equal(instSecond.code, 0, `installer second launch failed: ${instSecond.stdout}\n${instSecond.stderr}`);
    const instStubSecond = await fsp.readFile(instStubLog, 'utf8');
    assert.ok(!instStubSecond.includes('INSTALLED:'), 'installer runs only once');
    assert.ok(instStubSecond.includes('Fake App.exe'));

    console.log('Testing CLI recipe build…');
    const recipe = buildRecipe({
      app,
      analysis,
      options: {
        engineMode: 'reuse',
        includeRuntimes: false,
        includeWineMono: false,
        includeUserData: false,
        advanced: {
          verifyIntegrity: true,
          preventSleep: true,
          wineDebug: 'warn',
          launchArgs: '--recipe-arg "from recipe"',
          envText: 'CLI_RECIPE=1',
        },
      },
      generatorVersion: 'e2e',
      notes: 'E2E recipe',
    });
    const recipeFile = path.join(WORK, 'e2e.win2mac.json');
    await fsp.writeFile(recipeFile, `${JSON.stringify(recipe, null, 2)}\n`, 'utf8');
    const cliOut = path.join(WORK, 'out-cli');
    const cli = await run(process.execPath, [
      path.join(ROOT, 'cli.js'), 'build',
      '--exe', app.exePath,
      '--install', FIXTURE,
      '--recipe', recipeFile,
      '--out', cliOut,
      '--engine', 'reuse',
    ], { cwd: ROOT });
    assert.equal(cli.code, 0, `CLI recipe build failed:\n${cli.stderr}`);
    const cliResult = JSON.parse(cli.stdout);
    assert.equal(cliResult.engine.policy, 'reuse');
    const cliConfig = fs.readFileSync(path.join(cliResult.appPath, 'Contents', 'Resources', 'win2mac', 'config.env'), 'utf8');
    assert.match(cliConfig, /WIN2MAC_ARG_1='--recipe-arg'/);
    assert.match(cliConfig, /WIN2MAC_ARG_2='from recipe'/);
    assert.match(cliConfig, /WIN2MAC_ENV_1_NAME='CLI_RECIPE'/);
    assert.match(cliConfig, /WIN2MAC_VERIFY_ON_LAUNCH='1'/);
    assert.match(cliConfig, /WIN2MAC_PREVENT_SLEEP='1'/);
    assert.match(cliConfig, /WIN2MAC_WINEDEBUG='warn'/);

    console.log('\nE2E OK');
    console.log(JSON.stringify({ appPath: result.appPath, zipPath: result.zipPath, zipSha256: result.zipSha256, zipSize: result.zipSize, buildId: result.buildId, fatZip: fatResult.zipPath }, null, 2));
  } finally {
    await cleanupFixture();
  }
}

main().catch((error) => {
  console.error(error.stack || error);
  process.exit(1);
});
