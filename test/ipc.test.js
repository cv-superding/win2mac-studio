'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

let tmpRoot = '';
let ipc = null;
let agentCalls = 0;
let releaseAgent = () => {};
const agentGate = new Promise((resolve) => {
  releaseAgent = resolve;
});
const defaultAgentImpl = async () => {
  agentCalls += 1;
  await agentGate;
  return { finished: true, finalText: 'ok', trace: [], messages: [] };
};
let agentImpl = defaultAgentImpl;

function fakeEvent() {
  return { sender: { isDestroyed: () => false, send: () => {} } };
}

async function loadMain(userData, runAgent) {
  const handlers = new Map();
  const opened = [];
  const fakeApp = {
    setPath() {},
    getPath(name) {
      if (name === 'appData') return userData;
      if (name === 'temp') return os.tmpdir();
      if (name === 'documents') return path.join(userData, 'documents');
      return path.join(userData, 'app');
    },
    getName: () => 'Win2Mac',
    getVersion: () => '0.0.0',
    requestSingleInstanceLock: () => true,
    quit() {},
    on() {},
    whenReady: () => Promise.resolve(),
    exit() {},
  };
  class FakeBrowserWindow {
    constructor() {
      this.webContents = {
        send() {},
        once() {},
        on() {},
        setWindowOpenHandler() {},
      };
    }
    loadFile() {}
    once() {}
    on() {}
    isDestroyed() { return false; }
    isMaximized() { return false; }
    show() {}
    destroy() {}
    minimize() {}
    maximize() {}
    unmaximize() {}
    static getAllWindows() { return []; }
  }
  const electron = {
    app: fakeApp,
    BrowserWindow: FakeBrowserWindow,
    dialog: {
      showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
      showSaveDialog: async () => ({ canceled: true }),
      showMessageBox: async () => ({ response: 0 }),
    },
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    Menu: { setApplicationMenu() {} },
    shell: {
      openPath: async (target) => { opened.push(target); return ''; },
      showItemInFolder() {},
      openExternal: async () => {},
    },
  };

  const agentPath = require.resolve('../engine/ai/agent');
  const cachedAgent = require.cache[agentPath];
  if (runAgent) {
    const realAgent = require(agentPath);
    require.cache[agentPath] = {
      id: agentPath,
      filename: agentPath,
      loaded: true,
      exports: { ...realAgent, runAgent },
    };
  }
  const originalLoad = Module._load;
  Module._load = function load(request, parent, isMain) {
    if (request === 'electron') return electron;
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    const mainPath = require.resolve('../electron/main.js');
    delete require.cache[mainPath];
    require(mainPath);
  } finally {
    Module._load = originalLoad;
    if (runAgent) {
      if (cachedAgent) require.cache[agentPath] = cachedAgent;
      else delete require.cache[agentPath];
    }
  }
  for (let i = 0; i < 200 && !handlers.has('shell:open'); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  if (!handlers.has('shell:open')) throw new Error('IPC handlers 未注册');
  return { handlers, opened };
}

before(async () => {
  tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'win2mac-ipc-'));
  ipc = await loadMain(tmpRoot, (options) => agentImpl(options));
});

after(async () => {
  await fsp.rm(tmpRoot, { recursive: true, force: true });
});

test('shell:open 只允许打开文件夹，不能执行任意文件', async () => {
  const dir = path.join(tmpRoot, 'open-dir');
  await fsp.mkdir(dir, { recursive: true });
  const exe = path.join(dir, 'calc.exe');
  await fsp.writeFile(exe, 'MZ');
  await assert.rejects(
    () => ipc.handlers.get('shell:open')(fakeEvent(), exe),
    /只能打开文件夹/,
  );
  assert.deepEqual(ipc.opened, []);
  const result = await ipc.handlers.get('shell:open')(fakeEvent(), dir);
  assert.equal(result, '');
  assert.deepEqual(ipc.opened, [dir]);
});

test('诊断包 Logs 目录不能通过目录联接逃逸', async (t) => {
  const diag = path.join(tmpRoot, 'diag-user');
  const outside = path.join(tmpRoot, 'diag-outside');
  await fsp.mkdir(diag, { recursive: true });
  await fsp.mkdir(outside, { recursive: true });
  await fsp.writeFile(path.join(diag, 'Report.json'), JSON.stringify({ schema: 'win2mac-diagnostics/1' }));
  await fsp.writeFile(path.join(outside, 'secret.txt'), 'TOP SECRET');
  try {
    await fsp.symlink(outside, path.join(diag, 'Logs'), process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    t.skip(`当前环境无法创建目录链接：${error.code || error.message}`);
    return;
  }
  const result = await ipc.handlers.get('ai:import-diagnostics')(fakeEvent(), diag);
  assert.equal(result.report.schema, 'win2mac-diagnostics/1');
  assert.equal(result.logs.some((file) => path.basename(file) === 'secret.txt'), false);
});

test('IPC 对畸形 payload 返回中文错误', async () => {
  const event = fakeEvent();
  await assert.rejects(() => ipc.handlers.get('settings:set')(event, null), /设置参数无效/);
  await assert.rejects(() => ipc.handlers.get('apps:analyze')(event, null), /分析请求参数无效/);
  await assert.rejects(() => ipc.handlers.get('dialog:app-exe')(event, null), /应用信息参数无效/);
  await assert.rejects(() => ipc.handlers.get('recipe:export')(event, null), /配方请求参数无效/);
  await assert.rejects(() => ipc.handlers.get('dialog:output')(event, { path: 'x' }), /输出目录参数无效/);
});

test('AI read_file 不能通过目录联接读取包外文件', async (t) => {
  const appData = path.join(tmpRoot, 'Win2Mac');
  const appRoot = path.join(tmpRoot, 'Read.app');
  const win2mac = path.join(appRoot, 'Contents', 'Resources', 'win2mac');
  const outside = path.join(tmpRoot, 'read-outside');
  await fsp.mkdir(path.join(appData, 'build-contexts'), { recursive: true });
  await fsp.mkdir(win2mac, { recursive: true });
  await fsp.mkdir(outside, { recursive: true });
  await fsp.writeFile(path.join(appData, 'settings.json'), JSON.stringify({
    outputDir: path.join(tmpRoot, 'out'),
    ai: { apiKey: 'sk-test', baseUrl: 'http://x', model: 'm' },
  }), 'utf8');
  await fsp.writeFile(path.join(win2mac, 'config.env'), 'WIN2MAC_FORMAT=1\n', 'utf8');
  await fsp.writeFile(path.join(outside, 'secret.txt'), 'TOP SECRET', 'utf8');
  await fsp.writeFile(path.join(appData, 'build-contexts', 'read-test.json'), JSON.stringify({
    buildId: 'read-test',
    platform: 'mac',
    app: { name: 'Read Test' },
    options: { outputDir: path.join(tmpRoot, 'out'), advanced: {} },
    result: { appPath: appRoot },
  }), 'utf8');
  try {
    await fsp.symlink(outside, path.join(win2mac, 'leak'), process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    t.skip(`当前环境无法创建目录链接：${error.code || error.message}`);
    return;
  }
  agentImpl = async ({ tools }) => {
    const tool = tools.find((item) => item.name === 'read_file');
    let result;
    try {
      result = await tool.run({ path: 'leak/secret.txt' });
    } catch (error) {
      result = { error: error.message };
    }
    return { finished: true, finalText: JSON.stringify(result), trace: [] };
  };
  try {
    const result = await ipc.handlers.get('ai:fix')(fakeEvent(), { buildId: 'read-test' });
    assert.equal(String(result.summary).includes('TOP SECRET'), false);
    assert.match(String(result.summary), /路径不在允许范围|不存在/);
  } finally {
    agentImpl = defaultAgentImpl;
  }
});

test('ai:fix 并发请求会被拒绝', async () => {
  const appData = path.join(tmpRoot, 'Win2Mac');
  await fsp.mkdir(path.join(appData, 'build-contexts'), { recursive: true });
  await fsp.writeFile(path.join(appData, 'settings.json'), JSON.stringify({
    outputDir: path.join(tmpRoot, 'out'),
    ai: { apiKey: 'sk-test', baseUrl: 'http://x', model: 'm' },
  }), 'utf8');
  await fsp.writeFile(path.join(appData, 'build-contexts', 'lock-test.json'), JSON.stringify({
    buildId: 'lock-test',
    platform: 'mac',
    app: { name: 'Lock Test' },
    options: { outputDir: path.join(tmpRoot, 'out'), advanced: {} },
    result: { appPath: path.join(tmpRoot, 'Lock.app') },
  }), 'utf8');

  const first = ipc.handlers.get('ai:fix')(fakeEvent(), { buildId: 'lock-test', maxSteps: 1 });
  const second = ipc.handlers.get('ai:fix')(fakeEvent(), { buildId: 'lock-test' })
    .then((value) => ({ value }), (error) => ({ error: error.message }));
  await new Promise((resolve) => setTimeout(resolve, 100));
  const callsDuring = agentCalls;
  releaseAgent();
  const [firstResult, secondResult] = await Promise.all([first, second]);
  assert.equal(callsDuring, 1);
  assert.match(secondResult.error || '', /已有 AI 修复任务在运行/);
  assert.equal(firstResult.finished, true);
});
