'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const test = require('node:test');
const { shellQuote } = require('../engine/util');

const ROOT = path.join(__dirname, '..');
const IS_WIN = process.platform === 'win32';
const BASH = findBash();

function findBash() {
  if (process.env.WIN2MAC_BASH) return process.env.WIN2MAC_BASH;
  const probe = spawnSync('bash', ['-c', 'printf ok'], { encoding: 'utf8', windowsHide: true });
  return probe.status === 0 ? 'bash' : null;
}

function toShell(target) {
  const abs = path.resolve(target);
  if (!IS_WIN) return abs;
  return `/${abs[0].toLowerCase()}${abs.slice(2).split(String.fromCharCode(92)).join('/')}`;
}

function runBash(args, { env, cwd } = {}) {
  return new Promise((resolve) => {
    const child = spawn(BASH, args, { env, cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', (error) => resolve({ code: -1, stdout, stderr: error.message }));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

async function writeExecutable(file, content) {
  await fsp.writeFile(file, content, 'utf8');
  await fsp.chmod(file, 0o755);
}

async function createShims(dir) {
  await fsp.mkdir(dir, { recursive: true });
  const scripts = {
    uname: `#!/bin/bash
case "$1" in
  -m) printf '%s\\n' "\${STUB_UNAME_M:-x86_64}" ;;
  *) printf '%s\\n' "Darwin" ;;
esac
`,
    'sw_vers': `#!/bin/bash
if [ "$1" = "-productVersion" ]; then
  printf '%s\\n' "\${STUB_MACOS:-14.6.1}"
else
  printf '%s\\n' "ProductVersion:\t\${STUB_MACOS:-14.6.1}"
fi
`,
    arch: `#!/bin/bash
if [ "$1" = "-x86_64" ]; then
  [ "\${STUB_ROSETTA:-1}" = "1" ] && exit 0
  exit 1
fi
exit 0
`,
    osascript: `#!/bin/bash
printf 'OSASCRIPT\\n' >> "$STUB_LOG"
exit 0
`,
    sysctl: `#!/bin/bash
if [ "$1" = "-n" ]; then
  case "$2" in
    hw.model) printf '%s\\n' "Mac14,2" ;;
    machdep.cpu.brand_string) printf '%s\\n' "Apple M2" ;;
    *) printf '%s\\n' "0" ;;
  esac
fi
exit 0
`,
    spctl: `#!/bin/bash
printf 'rejected (unsigned)\\n' >&2
exit 1
`,
    plutil: `#!/bin/bash
case "$1" in
  -lint) printf '%s: OK\\n' "$2" ;;
  -p) cat "$2" ;;
  -extract)
    case "$2" in
      CFBundleIdentifier) printf '%s\\n' "com.win2mac.sim" ;;
      CFBundleShortVersionString) printf '%s\\n' "1.0" ;;
      LSMinimumSystemVersion) printf '%s\\n' "11.0" ;;
      *) exit 1 ;;
    esac
    ;;
esac
exit 0
`,
    open: `#!/bin/bash
printf 'OPEN %s\\n' "$*" >> "$STUB_OPEN_LOG"
exit 0
`,
    xattr: '#!/bin/bash\nexit 0\n',
    codesign: '#!/bin/bash\nexit 0\n',
    caffeinate: `#!/bin/bash
printf 'CAFFEINATE\\n' >> "$STUB_LOG"
if [ "\${1#-}" != "$1" ]; then shift; fi
exec "$@"
`,
    wineserver: `#!/bin/bash
printf 'WINESERVER %s\\n' "$*" >> "$STUB_LOG"
exit 0
`,
    wine: `#!/bin/bash
printf 'WINE %s\\n' "$*" >> "$STUB_LOG"
case "$1" in
  wineboot)
    mkdir -p "$WINEPREFIX/drive_c/users/tester"
    ;;
  reg)
    ;;
  *)
    printf 'ENV:%s\\n' "\${WIN2MAC_TEST_ENV:-}" >> "$STUB_LOG"
    printf 'LAUNCHED:%s\\n' "$*" >> "$STUB_LOG"
    touch "$WINEPREFIX/launched.marker"
    ;;
esac
exit 0
`,
  };
  if (IS_WIN) {
    scripts.shasum = `#!/bin/bash
if [ "$1" = "-a" ] && [ "$2" = "256" ] && [ "$3" = "-c" ]; then
  sha256sum -c "$4"
else
  sha256sum "$1" | awk '{print $1}'
fi
`;
  }
  for (const [name, content] of Object.entries(scripts)) {
    await writeExecutable(path.join(dir, name), content);
  }
}

function sha256(content) {
  return crypto.createHash('sha256').update(content).digest('hex');
}

async function createFixture(root) {
  const bundle = path.join(root, 'Fixture App.app');
  const contents = path.join(bundle, 'Contents');
  const macos = path.join(contents, 'MacOS');
  const win2mac = path.join(contents, 'Resources', 'win2mac');
  const payload = path.join(win2mac, 'payload', 'C', 'App');
  await fsp.mkdir(macos, { recursive: true });
  await fsp.mkdir(payload, { recursive: true });
  await fsp.copyFile(path.join(ROOT, 'resources', 'templates', 'launcher.sh'), path.join(macos, 'launcher'));
  await fsp.chmod(path.join(macos, 'launcher'), 0o755);
  const exeContent = Buffer.from('MZ fake simulator executable\n');
  const dataContent = Buffer.from('macOS launcher simulation 中文\n');
  await fsp.writeFile(path.join(payload, 'App.exe'), exeContent);
  await fsp.writeFile(path.join(payload, 'data.ini'), dataContent);
  const manifest = [
    `${sha256(exeContent)}  C/App/App.exe`,
    `${sha256(dataContent)}  C/App/data.ini`,
  ].join('\n') + '\n';
  await fsp.writeFile(path.join(win2mac, 'manifest.sha256'), manifest, 'utf8');
  const config = [
    `WIN2MAC_APP_NAME=${shellQuote('Mac Sim App')}`,
    `WIN2MAC_APP_ID=${shellQuote('sim-app')}`,
    `WIN2MAC_PAYLOAD_VERSION=${shellQuote('sim-1')}`,
    `WIN2MAC_ENGINE_POLICY=${shellQuote('reuse')}`,
    `WIN2MAC_ENGINE_ORDER=${shellQuote('wine')}`,
    `WIN2MAC_ENGINE_ARCHIVE=${shellQuote('')}`,
    `WIN2MAC_ENGINE_URL=${shellQuote('')}`,
    `WIN2MAC_ENGINE_SHA256=${shellQuote('')}`,
    `WIN2MAC_WINEDEBUG=${shellQuote('-all')}`,
    `WIN2MAC_WINEARCH=${shellQuote('win64')}`,
    `WIN2MAC_PAYLOAD_BYTES=${shellQuote(String(exeContent.length + dataContent.length))}`,
    `WIN2MAC_EXE_PAYLOAD=${shellQuote('C/App/App.exe')}`,
    `WIN2MAC_WORKDIR_PAYLOAD=${shellQuote('C/App')}`,
    `WIN2MAC_DLL_OVERRIDES=${shellQuote('mshtml=')}`,
    `WIN2MAC_ARG_COUNT=${shellQuote('2')}`,
    `WIN2MAC_ARG_1=${shellQuote('--hello')}`,
    `WIN2MAC_ARG_2=${shellQuote('hello world')}`,
    `WIN2MAC_ENV_COUNT=${shellQuote('1')}`,
    `WIN2MAC_ENV_1_NAME=${shellQuote('WIN2MAC_TEST_ENV')}`,
    `WIN2MAC_ENV_1_VALUE=${shellQuote('ok')}`,
    `WIN2MAC_VERIFY_ON_LAUNCH=${shellQuote('1')}`,
    `WIN2MAC_PREVENT_SLEEP=${shellQuote('1')}`,
    `WIN2MAC_REGISTRY_COUNT=${shellQuote('0')}`,
    `WIN2MAC_RUNTIME_COUNT=${shellQuote('0')}`,
    `WIN2MAC_USERDATA_COUNT=${shellQuote('0')}`,
    `WIN2MAC_EXTRA_DRIVES=${shellQuote('')}`,
    '',
  ].join('\n');
  await fsp.writeFile(path.join(win2mac, 'config.env'), config, 'utf8');
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>com.win2mac.sim</string>
<key>CFBundleShortVersionString</key><string>1.0</string>
<key>LSMinimumSystemVersion</key><string>11.0</string>
</dict></plist>
`;
  await fsp.writeFile(path.join(contents, 'Info.plist'), plist, 'utf8');
  for (const [template, name] of [
    ['open-me.command', 'Open-Win2Mac-App.command'],
    ['verify-integrity.command', 'Verify-Integrity.command'],
    ['reset-runtime.command', 'Reset-Runtime.command'],
    ['mac-check.command', 'Start-Mac-Validation.command'],
  ]) {
    await fsp.copyFile(path.join(ROOT, 'resources', 'templates', template), path.join(root, name));
  }
  return { bundle, launcher: path.join(macos, 'launcher'), win2mac, payload };
}

function baseEnv(root, shims, extra = {}) {
  const home = path.join(root, 'home');
  const prefixRoot = path.join(root, 'prefixes');
  const logDir = path.join(root, 'logs');
  const cacheRoot = path.join(root, 'cache');
  const stubLog = path.join(root, 'stub.log');
  const openLog = path.join(root, 'open.log');
  return {
    ...process.env,
    HOME: toShell(home),
    WIN2MAC_PREFIX_ROOT: toShell(prefixRoot),
    WIN2MAC_LOG_DIR: toShell(logDir),
    WIN2MAC_CACHE_ROOT: toShell(cacheRoot),
    WIN2MAC_WINE: toShell(path.join(shims, 'wine')),
    STUB_LOG: toShell(stubLog),
    STUB_OPEN_LOG: toShell(openLog),
    STUB_UNAME_M: 'arm64',
    STUB_ROSETTA: '1',
    STUB_MACOS: '14.6.1',
    PATH: `${toShell(shims)}:${process.env.PATH || ''}`,
    MSYS: 'winsymlinks:nativestrict',
    ...extra,
  };
}

test('macOS launcher runs on Darwin-shaped hosts (simulated on Windows)', { skip: BASH ? false : 'bash not available' }, async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'win2mac-macos-'));
  let passed = false;
  try {
    const fixture = await createFixture(root);
    const shims = path.join(root, 'shims');
    await createShims(shims);
    const env = baseEnv(root, shims);
    const stubLog = path.join(root, 'stub.log');
    const logDir = path.join(root, 'logs');
    const prefix = path.join(root, 'prefixes', 'sim-app');

    const first = await runBash([toShell(fixture.launcher)], { env, cwd: root });
    assert.equal(first.code, 0, `first launch failed:\n${first.stdout}\n${first.stderr}`);
    const stubFirst = await fsp.readFile(stubLog, 'utf8');
    assert.match(stubFirst, /WINE wineboot -u/);
    assert.match(stubFirst, /ENV:ok/);
    assert.match(stubFirst, /CAFFEINATE/);
    assert.match(stubFirst, /LAUNCHED:.*--hello hello world/);
    assert.ok(fs.existsSync(path.join(prefix, '.win2mac', 'initialized')));
    assert.ok(fs.existsSync(path.join(prefix, '.win2mac', 'payload-version')));
    assert.ok(fs.existsSync(path.join(prefix, 'launched.marker')));
    assert.ok(fs.existsSync(path.join(prefix, 'drive_c', 'App', 'App.exe')));
    const appLog = await fsp.readFile(path.join(logDir, 'sim-app.log'), 'utf8');
    assert.match(appLog, /Using engine: wine/);
    assert.match(appLog, /Launching:/);
    assert.match(appLog, /Copying payload drive C/);

    const second = await runBash([toShell(fixture.launcher)], { env, cwd: root });
    assert.equal(second.code, 0, `second launch failed:\n${second.stdout}\n${second.stderr}`);
    const appLogSecond = await fsp.readFile(path.join(logDir, 'sim-app.log'), 'utf8');
    assert.equal((appLogSecond.match(/Copying payload drive/g) || []).length, 1);
    assert.equal((appLogSecond.match(/Initializing prefix/g) || []).length, 1);

    const verify = await runBash([toShell(path.join(root, 'Verify-Integrity.command'))], { env, cwd: root });
    assert.equal(verify.code, 0, `verify failed:\n${verify.stdout}\n${verify.stderr}`);
    assert.match(verify.stdout, /校验通过/);

    const open = await runBash([toShell(path.join(root, 'Open-Win2Mac-App.command'))], { env, cwd: root });
    assert.equal(open.code, 0, `open helper failed:\n${open.stdout}\n${open.stderr}`);
    const openLog = await fsp.readFile(path.join(root, 'open.log'), 'utf8');
    assert.match(openLog, /Fixture App\.app/);

    const reset = await runBash([toShell(path.join(root, 'Reset-Runtime.command'))], { env, cwd: root });
    assert.equal(reset.code, 1);
    assert.match(reset.stdout, /非交互环境，已取消重置/);
    assert.ok(fs.existsSync(prefix), 'non-interactive reset must not delete the prefix');
    passed = true;
  } finally {
    if (passed) await fsp.rm(root, { recursive: true, force: true });
    else console.error(`macOS launcher artifacts kept at ${root}`);
  }
});

test('macOS launcher refuses ARM Macs without Rosetta and old macOS', { skip: BASH ? false : 'bash not available' }, async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'win2mac-macos-guard-'));
  let passed = false;
  try {
    const fixture = await createFixture(root);
    const shims = path.join(root, 'shims');
    await createShims(shims);
    const env = baseEnv(root, shims, { STUB_ROSETTA: '0' });
    const logDir = path.join(root, 'logs');
    const first = await runBash([toShell(fixture.launcher)], { env, cwd: root });
    assert.equal(first.code, 1);
    const log = await fsp.readFile(path.join(logDir, 'sim-app.log'), 'utf8');
    assert.match(log, /未安装 Rosetta 2/);
    assert.ok(!fs.existsSync(path.join(root, 'prefixes', 'sim-app', '.win2mac', 'initialized')));

    const oldEnv = { ...baseEnv(root, shims), STUB_MACOS: '10.15.7' };
    const old = await runBash([toShell(fixture.launcher)], { env: oldEnv, cwd: root });
    assert.equal(old.code, 1);
    const oldLog = await fsp.readFile(path.join(logDir, 'sim-app.log'), 'utf8');
    assert.match(oldLog, /需要 macOS 11 或更高版本/);
    passed = true;
  } finally {
    if (passed) await fsp.rm(root, { recursive: true, force: true });
    else console.error(`macOS launcher guard artifacts kept at ${root}`);
  }
});

test('macOS validation collector creates an obvious log and support folder', { skip: BASH ? false : 'bash not available' }, async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'win2mac-macos-check-'));
  let passed = false;
  try {
    const fixture = await createFixture(root);
    const shims = path.join(root, 'shims');
    await createShims(shims);
    const checkOut = path.join(root, 'check-out');
    const env = baseEnv(root, shims, {
      WIN2MAC_CHECK_APP: toShell(fixture.bundle),
      WIN2MAC_CHECK_OUTDIR: toShell(checkOut),
      WIN2MAC_CHECK_NO_PROMPT: '1',
      WIN2MAC_CHECK_NO_LAUNCH: '1',
      WIN2MAC_CHECK_NO_ZIP: '1',
    });
    const result = await runBash([toShell(path.join(root, 'Start-Mac-Validation.command'))], { env, cwd: root });
    const entries = await fsp.readdir(checkOut);
    const logName = entries.find((name) => name.startsWith('Win2Mac-验证日志-') && name.endsWith('.log'));
    const supportName = entries.find((name) => name.startsWith('Win2Mac-诊断-'));
    assert.ok(logName, `collector log missing; stdout:\n${result.stdout}\n${result.stderr}`);
    assert.ok(supportName, 'support folder missing');
    const report = await fsp.readFile(path.join(checkOut, logName), 'utf8');
    assert.equal(result.code, 0, `collector failed:\n${report}\n${result.stderr}`);
    assert.match(report, /\[PASS\] 完整性校验/);
    assert.match(report, /\[PASS\] 引擎策略 reuse/);
    assert.match(report, /\[WARN\] 启动测试/);
    assert.match(report, /PASS：/);
    const support = path.join(checkOut, supportName);
    assert.ok(fs.existsSync(path.join(support, 'Report.txt')));
    assert.match(await fsp.readFile(path.join(support, 'Report.txt'), 'utf8'), /\[PASS\] 完整性校验/);
    assert.ok(fs.existsSync(path.join(support, 'README.txt')));
    assert.ok(fs.existsSync(path.join(support, 'App', 'config.env')));
    assert.ok(fs.existsSync(path.join(support, 'App', 'manifest.sha256')));
    assert.ok(fs.existsSync(path.join(support, 'System', 'sw_vers.txt')));
    assert.match(await fsp.readFile(path.join(support, 'README.txt'), 'utf8'), /隐私提示/);
    passed = true;
  } finally {
    if (passed) await fsp.rm(root, { recursive: true, force: true });
    else console.error(`macOS validation collector artifacts kept at ${root}`);
  }
});

test('macOS validation collector survives missing app and failed integrity', { skip: BASH ? false : 'bash not available' }, async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'win2mac-macos-check-fail-'));
  let passed = false;
  try {
    const shims = path.join(root, 'shims');
    await createShims(shims);

    const emptyDir = path.join(root, 'empty');
    await fsp.mkdir(emptyDir, { recursive: true });
    await fsp.copyFile(path.join(ROOT, 'resources', 'templates', 'mac-check.command'), path.join(emptyDir, 'Start-Mac-Validation.command'));
    const emptyOut = path.join(root, 'empty-out');
    const emptyEnv = baseEnv(root, shims, {
      WIN2MAC_CHECK_OUTDIR: toShell(emptyOut),
      WIN2MAC_CHECK_NO_PROMPT: '1',
      WIN2MAC_CHECK_NO_LAUNCH: '1',
      WIN2MAC_CHECK_NO_ZIP: '1',
    });
    const emptyRun = await runBash([toShell(path.join(emptyDir, 'Start-Mac-Validation.command'))], { env: emptyEnv, cwd: emptyDir });
    assert.equal(emptyRun.code, 1, `missing-app run should fail cleanly:\n${emptyRun.stdout}\n${emptyRun.stderr}`);
    const emptyEntries = await fsp.readdir(emptyOut);
    const emptyLog = emptyEntries.find((name) => name.startsWith('Win2Mac-验证日志-'));
    assert.ok(emptyLog, 'missing-app run should still create a log');
    const emptyReport = await fsp.readFile(path.join(emptyOut, emptyLog), 'utf8');
    assert.match(emptyReport, /没有找到 \.app/);
    assert.match(emptyReport, /PASS：/);

    const fixture = await createFixture(root);
    await fsp.writeFile(path.join(fixture.payload, 'App.exe'), 'corrupted payload');
    const corruptOut = path.join(root, 'corrupt-out');
    const corruptEnv = baseEnv(root, shims, {
      WIN2MAC_CHECK_APP: toShell(fixture.bundle),
      WIN2MAC_CHECK_OUTDIR: toShell(corruptOut),
      WIN2MAC_CHECK_NO_PROMPT: '1',
      WIN2MAC_CHECK_NO_LAUNCH: '1',
      WIN2MAC_CHECK_NO_ZIP: '1',
    });
    const corruptRun = await runBash([toShell(path.join(root, 'Start-Mac-Validation.command'))], { env: corruptEnv, cwd: root });
    assert.equal(corruptRun.code, 1, `corrupt run should fail:\n${corruptRun.stdout}\n${corruptRun.stderr}`);
    const corruptEntries = await fsp.readdir(corruptOut);
    const corruptLog = corruptEntries.find((name) => name.startsWith('Win2Mac-验证日志-'));
    const supportName = corruptEntries.find((name) => name.startsWith('Win2Mac-诊断-'));
    assert.ok(corruptLog && supportName);
    const corruptReport = await fsp.readFile(path.join(corruptOut, corruptLog), 'utf8');
    assert.match(corruptReport, /\[FAIL\] 完整性校验/);
    assert.ok(fs.existsSync(path.join(corruptOut, supportName, 'Integrity.log')));
    assert.match(await fsp.readFile(path.join(corruptOut, supportName, 'Integrity.log'), 'utf8'), /FAILED/);
    passed = true;
  } finally {
    if (passed) await fsp.rm(root, { recursive: true, force: true });
    else console.error(`macOS validation failure-path artifacts kept at ${root}`);
  }
});
