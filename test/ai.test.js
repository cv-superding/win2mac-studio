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
