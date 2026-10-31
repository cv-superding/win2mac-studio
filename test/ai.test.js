'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const { chat, normalizeEndpoint, parseChatResponse } = require('../engine/ai/client');
const { runAgent } = require('../engine/ai/agent');
const { createFixerTools } = require('../engine/ai/fixer');
const { normalizeAiSettings, publicAiSettings } = require('../engine/ai/settings');
const { patchConfigText, isConfigKeyAllowed } = require('../engine/ai/config');

function startServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (chunk) => { data += chunk; });
    req.on('end', () => resolve(data));
  });
}

test('AI 设置规范化并隐藏 API Key', () => {
  assert.equal(normalizeEndpoint('https://api.example.com/v1'), 'https://api.example.com/v1/chat/completions');
  assert.equal(normalizeEndpoint('https://api.example.com/v1/chat/completions'), 'https://api.example.com/v1/chat/completions');
  assert.throws(() => normalizeEndpoint('ftp://x'), /http/);

  const ai = normalizeAiSettings({ apiKey: '  sk-test-123456  ', model: 'deepseek-chat', temperature: 5 }, {});
  assert.equal(ai.apiKey, 'sk-test-123456');
  assert.equal(ai.model, 'deepseek-chat');
  assert.equal(ai.temperature, 2);
  const pub = publicAiSettings(ai);
  assert.equal(pub.hasKey, true);
  assert.equal(pub.keyHint, 'sk-…3456');
  assert.equal(pub.apiKey, undefined);
  assert.equal(publicAiSettings({}).hasKey, false);

  const cleared = normalizeAiSettings({ clearKey: true }, ai);
  assert.equal(cleared.apiKey, '');
});

test('AI 配置补丁只允许白名单键', () => {
  assert.equal(isConfigKeyAllowed('WIN2MAC_WINEDEBUG'), true);
  assert.equal(isConfigKeyAllowed('WIN2MAC_ENV_1_NAME'), true);
  assert.equal(isConfigKeyAllowed('WIN2MAC_EXE_PAYLOAD'), false);
  const source = "WIN2MAC_WINEDEBUG='-all'\nWIN2MAC_ARG_COUNT='0'\n";
  const { text, applied } = patchConfigText(source, { WIN2MAC_WINEDEBUG: 'fixme-all', WIN2MAC_DLL_OVERRIDES: 'mshtml=' });
  assert.match(text, /WIN2MAC_WINEDEBUG='fixme-all'/);
  assert.match(text, /WIN2MAC_DLL_OVERRIDES='mshtml='/);
  assert.equal(applied.WIN2MAC_WINEDEBUG.from, "'-all'");
  assert.throws(() => patchConfigText(source, { WIN2MAC_EXE_PAYLOAD: 'x' }), /不允许/);
});

test('OpenAI 兼容客户端解析 tool_calls 与错误', async () => {
  let received = null;
  const { server, port } = await startServer(async (req, res) => {
    received = JSON.parse(await readBody(req));
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({
      choices: [{
        finish_reason: 'tool_calls',
        message: {
          content: null,
          tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'get_status', arguments: '{"x":1}' } }],
        },
      }],
      usage: { total_tokens: 12 },
    }));
  });
  try {
    const reply = await chat({
      baseUrl: `http://127.0.0.1:${port}/v1`,
      apiKey: 'sk-test',
      model: 'mock-model',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [{ type: 'function', function: { name: 'get_status', parameters: { type: 'object', properties: {} } } }],
    });
    assert.equal(received.model, 'mock-model');
    assert.equal(received.tools.length, 1);
    assert.equal(reply.toolCalls[0].name, 'get_status');
    assert.deepEqual(reply.toolCalls[0].arguments, { x: 1 });
    assert.equal(reply.usage.total_tokens, 12);
  } finally {
    server.close();
  }

  const bad = await startServer((_req, res) => {
    res.statusCode = 401;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: { message: 'invalid api key' } }));
  });
  try {
    await assert.rejects(() => chat({
      baseUrl: `http://127.0.0.1:${bad.port}/v1`,
      apiKey: 'bad',
      messages: [{ role: 'user', content: 'hi' }],
    }), /401.*invalid api key/);
  } finally {
    bad.server.close();
  }
});

test('parseChatResponse 拒绝空 choices', () => {
  assert.throws(() => parseChatResponse({ choices: [] }), /choices/);
});

test('Agent 循环执行工具并调用 finish', async () => {
  const script = [
    { content: '', toolCalls: [{ id: 'a', name: 'get_status', arguments: {} }], finishReason: 'tool_calls' },
    { content: '', toolCalls: [{ id: 'b', name: 'finish', arguments: { summary: '已修复' } }], finishReason: 'tool_calls' },
  ];
  let step = 0;
  const events = [];
  const result = await runAgent({
    settings: { baseUrl: 'http://x', apiKey: 'k', model: 'm' },
    client: async () => script[step++] || { content: 'done', toolCalls: [] },
    tools: createFixerTools({
      ctx: {
        status: async () => ({ ok: true }),
        readFile: async () => ({ text: '' }),
        searchLogs: async () => ({ hits: [] }),
        patchConfig: async () => ({ changed: true }),
        rebuild: async () => ({ zipPath: 'x.zip' }),
      },
    }),
    userPrompt: '修复',
    onEvent: (event) => events.push(event),
  });
  assert.equal(result.finished, true);
  assert.equal(result.finalText, '已修复');
  assert.ok(result.trace.some((item) => item.type === 'tool' && item.name === 'get_status'));
  assert.ok(events.some((event) => event.type === 'tool' && event.name === 'finish'));
});

test('Agent 在工具报错时继续运行并受步数限制', async () => {
  let calls = 0;
  const result = await runAgent({
    settings: { baseUrl: 'http://x', apiKey: 'k', model: 'm' },
    client: async () => {
      calls += 1;
      return { content: '', toolCalls: [{ id: `t${calls}`, name: 'read_file', arguments: { path: 'nope' } }] };
    },
    tools: [{
      name: 'read_file',
      description: 'read',
      parameters: { type: 'object', properties: {} },
      run: async () => { throw new Error('文件不存在'); },
    }],
    userPrompt: 'x',
    maxSteps: 3,
  });
  assert.equal(result.finished, false);
  assert.equal(calls, 3);
  assert.ok(result.trace.every((item) => item.type === 'tool' && item.result.includes('文件不存在')));
});

test('Agent 为缺少 id 的并行工具调用生成唯一 id', async () => {
  const result = await runAgent({
    settings: { baseUrl: 'http://x', apiKey: 'k', model: 'm' },
    client: async () => ({
      content: '',
      toolCalls: [
        { name: 'read_file', arguments: { path: 'a' } },
        { name: 'read_file', arguments: { path: 'b' } },
      ],
    }),
    tools: [{
      name: 'read_file',
      description: 'read',
      parameters: { type: 'object', properties: {} },
      run: async (args) => ({ got: args.path }),
    }],
    userPrompt: 'x',
    maxSteps: 1,
  });
  const assistant = result.messages.find((message) => message.role === 'assistant');
  const ids = assistant.tool_calls.map((call) => call.id);
  assert.equal(new Set(ids).size, 2);
  assert.equal(ids.every(Boolean), true);
  assert.deepEqual(
    result.messages.filter((message) => message.role === 'tool').map((message) => message.tool_call_id),
    ids,
  );
});

test('客户端错误信息会抹掉 API Key', async () => {
  const secret = 'sk-test-super-secret-key';
  const { server, port } = await startServer((_req, res) => {
    res.statusCode = 401;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: { message: `invalid key ${secret}` } }));
  });
  try {
    await assert.rejects(
      () => chat({
        baseUrl: `http://127.0.0.1:${port}/v1`,
        apiKey: secret,
        messages: [{ role: 'user', content: 'hi' }],
      }),
      (error) => {
        assert.match(error.message, /401/);
        assert.equal(error.message.includes(secret), false);
        assert.match(error.message, /\*\*\*/);
        return true;
      },
    );
  } finally {
    server.close();
  }
});

test('parseChatResponse 忽略非数组/无名称的 tool_calls', () => {
  const reply = parseChatResponse({
    choices: [{
      message: {
        content: 'hi',
        tool_calls: [
          null,
          { id: 'a', function: { name: '   ', arguments: '{}' } },
          { id: 'b', function: { name: 'get_status', arguments: '{}' } },
        ],
      },
    }],
  });
  assert.equal(reply.toolCalls.length, 1);
  assert.equal(reply.toolCalls[0].name, 'get_status');

  const noArray = parseChatResponse({ choices: [{ message: { content: 'x', tool_calls: {} } }] });
  assert.deepEqual(noArray.toolCalls, []);
});

test('Agent 对重复的 tool_call id 去重并保持配对', async () => {
  const result = await runAgent({
    settings: { baseUrl: 'http://x', apiKey: 'k', model: 'm' },
    client: async () => ({
      content: '',
      toolCalls: [
        { id: 'dup', name: 'read_file', arguments: { path: 'a' } },
        { id: 'dup', name: 'read_file', arguments: { path: 'b' } },
      ],
    }),
    tools: [{
      name: 'read_file',
      description: 'read',
      parameters: { type: 'object', properties: {} },
      run: async (args) => ({ got: args.path }),
    }],
    userPrompt: 'x',
    maxSteps: 1,
  });
  const assistant = result.messages.find((message) => message.role === 'assistant');
  const ids = assistant.tool_calls.map((call) => call.id);
  assert.equal(new Set(ids).size, 2);
  assert.deepEqual(
    result.messages.filter((message) => message.role === 'tool').map((message) => message.tool_call_id),
    ids,
  );
});

test('Agent 容忍缺少 toolCalls 字段的响应', async () => {
  const result = await runAgent({
    settings: { baseUrl: 'http://x', apiKey: 'k', model: 'm' },
    client: async () => ({ content: '没有工具调用' }),
    tools: [{
      name: 'read_file',
      description: 'read',
      parameters: { type: 'object', properties: {} },
      run: async () => ({}),
    }],
    userPrompt: 'x',
    maxSteps: 2,
  });
  assert.equal(result.finished, false);
  assert.equal(result.finalText, '没有工具调用');
});

test('curl 代理响应跨块截断 UTF-8 时仍能正确解码', async () => {
  const prefix = '{"choices":[{"message":{"content":"';
  const suffix = '","tool_calls":[]}}]}';
  // 让“中”的第一个字节正好落在 curl 常见的 16 KB 输出边界附近，并主动拆成多个 TCP 块。
  const content = `${'a'.repeat(16383 - Buffer.byteLength(prefix))}中文测试🚀`;
  const payload = Buffer.from(prefix + content + suffix, 'utf8');
  const cut = payload.indexOf(Buffer.from('中')) + 1;
  const { server, port } = await startServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': payload.length });
      res.write(payload.subarray(0, cut));
      setTimeout(() => {
        res.write(payload.subarray(cut, cut + 1));
        setTimeout(() => res.end(payload.subarray(cut + 1)), 20);
      }, 20);
    });
  });
  try {
    const reply = await chat({
      baseUrl: 'http://example.invalid/v1',
      apiKey: 'k',
      proxy: `http://127.0.0.1:${port}`,
      messages: [{ role: 'user', content: 'hi' }],
      timeoutMs: 10000,
    });
    assert.equal(reply.content, content);
  } finally {
    server.close();
  }
});

test('fetch 超时返回中文提示', async () => {
  const { server, port } = await startServer((req) => {
    req.resume();
  });
  try {
    await assert.rejects(
      () => chat({
        baseUrl: `http://127.0.0.1:${port}/v1`,
        apiKey: 'k',
        messages: [{ role: 'user', content: 'hi' }],
        timeoutMs: 100,
      }),
      /模型请求超时/,
    );
  } finally {
    if (server.closeAllConnections) server.closeAllConnections();
    server.close();
  }
});

test('客户端拒绝超过 2 MB 的响应', async () => {
  const { server, port } = await startServer((_req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.on('error', () => {});
    const chunk = Buffer.alloc(512 * 1024, 0x20);
    for (let i = 0; i < 5 && !res.destroyed; i += 1) res.write(chunk);
    res.end();
  });
  try {
    await assert.rejects(
      () => chat({
        baseUrl: `http://127.0.0.1:${port}/v1`,
        apiKey: 'k',
        messages: [{ role: 'user', content: 'hi' }],
      }),
      /超过 2 MB/,
    );
  } finally {
    server.close();
  }
});

test('修复 Agent 暴露确定性诊断、应用修复与构建校验工具', async () => {
  const calls = [];
  const tools = createFixerTools({
    ctx: {
      status: async () => ({}),
      knownIssues: async () => ({ issues: [{ id: 'engine-unavailable' }] }),
      applyFix: async (id) => { calls.push(['fix', id]); return { id, needsRebuild: true }; },
      verifyBuild: async () => { calls.push(['verify']); return { ok: true, checks: [] }; },
      readFile: async () => ({ text: '' }),
      searchLogs: async () => ({ hits: [] }),
      patchConfig: async () => ({ changed: true }),
      rebuild: async () => ({ zipPath: 'x.zip' }),
    },
  });
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  assert.deepEqual(await byName.get('list_known_issues').run({}), { issues: [{ id: 'engine-unavailable' }] });
  await byName.get('apply_fix').run({ id: 'engine-unavailable' });
  await byName.get('verify_build').run({});
  assert.deepEqual(calls, [['fix', 'engine-unavailable'], ['verify']]);
});
