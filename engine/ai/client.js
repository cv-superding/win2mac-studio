'use strict';

const { spawn } = require('node:child_process');

const DEFAULT_BASE_URL = 'https://api.openai.com/v1';
const DEFAULT_MODEL = 'gpt-4o-mini';
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

function normalizeEndpoint(baseUrl) {
  let url = String(baseUrl || DEFAULT_BASE_URL).trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(url)) {
    throw new Error('API Base URL 必须以 http:// 或 https:// 开头');
  }
  if (/\/chat\/completions$/i.test(url)) return url;
  return `${url}/chat/completions`;
}

function normalizeBody({ model, messages, temperature, tools, toolChoice, maxTokens }) {
  const body = {
    model: String(model || DEFAULT_MODEL),
    messages,
    stream: false,
  };
  if (Number.isFinite(temperature)) body.temperature = temperature;
  if (Number.isFinite(maxTokens) && maxTokens > 0) body.max_tokens = Math.trunc(maxTokens);
  if (Array.isArray(tools) && tools.length) {
    body.tools = tools;
    body.tool_choice = toolChoice || 'auto';
  }
  return body;
}

function parseChatResponse(data) {
  const choice = data?.choices?.[0];
  if (!choice) {
    const detail = data?.error?.message || JSON.stringify(data).slice(0, 300);
    throw new Error(`模型没有返回 choices：${detail}`);
  }
  const message = choice.message || {};
  const toolCalls = [];
  for (const call of message.tool_calls || []) {
    let args = {};
    const raw = call.function?.arguments;
    if (raw) {
      try {
        args = typeof raw === 'string' ? JSON.parse(raw) : raw;
      } catch {
        args = { _raw: String(raw) };
      }
    }
    toolCalls.push({ id: call.id || '', name: call.function?.name || '', arguments: args });
  }
  return {
    content: typeof message.content === 'string' ? message.content : '',
    toolCalls,
    finishReason: choice.finish_reason || '',
    usage: data.usage || null,
  };
}

function runCurl(endpoint, apiKey, body, { proxy, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const args = [
      '-sS',
      '--max-time', String(Math.max(5, Math.round(timeoutMs / 1000))),
      '-H', 'Content-Type: application/json',
      '-H', `Authorization: Bearer ${apiKey}`,
      '--data-binary', '@-',
      endpoint,
    ];
    if (proxy) args.unshift('--proxy', proxy);
    const child = spawn(process.platform === 'win32' ? 'curl.exe' : 'curl', args, {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    let size = 0;
    child.stdout.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_RESPONSE_BYTES) {
        child.kill();
        reject(new Error('模型响应超过 2 MB，已中止'));
        return;
      }
      out += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk) => { err += chunk.toString('utf8'); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`请求模型失败（curl ${code}）：${(err || out).trim().slice(0, 500)}`));
        return;
      }
      resolve(out);
    });
    child.stdin.end(JSON.stringify(body));
  });
}

async function runFetch(endpoint, apiKey, body, { timeoutMs }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await response.text();
    if (text.length > MAX_RESPONSE_BYTES) throw new Error('模型响应超过 2 MB，已中止');
    if (!response.ok) {
      let detail = text.slice(0, 500);
      try {
        const parsed = JSON.parse(text);
        detail = parsed?.error?.message || detail;
      } catch { /* keep raw */ }
      throw new Error(`模型接口返回 ${response.status}：${detail}`);
    }
    return text;
  } finally {
    clearTimeout(timer);
  }
}

async function chat(options) {
  const {
    baseUrl = DEFAULT_BASE_URL,
    apiKey,
    model = DEFAULT_MODEL,
    messages,
    temperature = 0.2,
    tools = [],
    toolChoice = 'auto',
    maxTokens = 0,
    proxy = '',
    timeoutMs = 120000,
  } = options || {};
  if (!apiKey) throw new Error('缺少 API Key，请先在设置中填写');
  if (!Array.isArray(messages) || !messages.length) throw new Error('缺少对话内容');
  const endpoint = normalizeEndpoint(baseUrl);
  const body = normalizeBody({ model, messages, temperature, tools, toolChoice, maxTokens });
  const text = proxy
    ? await runCurl(endpoint, apiKey, body, { proxy, timeoutMs })
    : await runFetch(endpoint, apiKey, body, { timeoutMs });
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`模型返回的不是 JSON：${text.slice(0, 300)}`);
  }
  if (data?.error) throw new Error(data.error.message || JSON.stringify(data.error).slice(0, 300));
  return parseChatResponse(data);
}

async function testConnection(options) {
  const started = Date.now();
  const result = await chat({
    ...options,
    messages: [
      { role: 'system', content: '你是连通性测试助手，只回复 OK。' },
      { role: 'user', content: 'ping' },
    ],
    tools: [],
    maxTokens: 16,
    timeoutMs: Math.min(options?.timeoutMs || 30000, 30000),
  });
  return { ok: true, latencyMs: Date.now() - started, reply: (result.content || '').trim().slice(0, 80) };
}

module.exports = {
  chat,
  testConnection,
  normalizeEndpoint,
  parseChatResponse,
  DEFAULT_BASE_URL,
  DEFAULT_MODEL,
};
