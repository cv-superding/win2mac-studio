'use strict';

const { spawn } = require('node:child_process');

const DEFAULT_BASE_URL = 'https://api.openai.com/v1';
const DEFAULT_MODEL = 'gpt-4o-mini';
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_ERROR_CHARS = 4096;

function redactSecret(text, secret) {
  const value = String(text == null ? '' : text);
  const key = String(secret || '');
  if (!key) return value;
  return value.split(key).join('***');
}

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
  // 兼容接口可能返回非数组 tool_calls 或缺少 function.name；这些条目不能进入下一轮请求，否则会破坏配对。
  const rawCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
  for (const call of rawCalls) {
    if (!call || typeof call !== 'object') continue;
    const name = typeof call.function?.name === 'string' ? call.function.name.trim() : '';
    if (!name) continue;
    let args = {};
    const raw = call.function?.arguments;
    if (raw) {
      try {
        args = typeof raw === 'string' ? JSON.parse(raw) : raw;
      } catch {
        args = { _raw: String(raw) };
      }
    }
    toolCalls.push({ id: typeof call.id === 'string' ? call.id : '', name, arguments: args });
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
    const chunks = [];
    let err = '';
    let size = 0;
    let aborted = false;
    child.stdout.on('data', (chunk) => {
      if (aborted) return;
      size += chunk.length;
      if (size > MAX_RESPONSE_BYTES) {
        aborted = true;
        child.kill();
        reject(new Error('模型响应超过 2 MB，已中止'));
        return;
      }
      // 不能逐块 toString：多字节 UTF-8 字符可能被 TCP 分块截断。
      chunks.push(chunk);
    });
    child.stdout.on('error', () => {});
    child.stderr.on('data', (chunk) => {
      if (err.length < MAX_ERROR_CHARS) err += chunk.toString('utf8');
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        const output = Buffer.concat(chunks).toString('utf8');
        reject(new Error(`请求模型失败（curl ${code}）：${redactSecret((err || output).trim(), apiKey).slice(0, 500)}`));
        return;
      }
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
    // curl 可能在读完请求体前退出（例如代理拒绝），此时 stdin 的 EPIPE 不能变成未捕获异常。
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify(body));
  });
}

async function readResponseText(response) {
  if (!response.body || typeof response.body.getReader !== 'function') {
    const text = await response.text();
    if (Buffer.byteLength(text, 'utf8') > MAX_RESPONSE_BYTES) throw new Error('模型响应超过 2 MB，已中止');
    return text;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let received = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      received += value.byteLength;
      if (received > MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => {});
        throw new Error('模型响应超过 2 MB，已中止');
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    try { reader.releaseLock(); } catch { /* already released */ }
  }
  return Buffer.concat(chunks).toString('utf8');
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
    const text = await readResponseText(response);
    if (!response.ok) {
      let detail = text.slice(0, 500);
      try {
        const parsed = JSON.parse(text);
        detail = parsed?.error?.message || detail;
      } catch { /* keep raw */ }
      throw new Error(`模型接口返回 ${response.status}：${redactSecret(detail, apiKey).slice(0, 500)}`);
    }
    return text;
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(`模型请求超时（${Math.max(1, Math.round(timeoutMs / 1000))} 秒）`);
    }
    throw new Error(`模型请求失败：${redactSecret(error?.message || error, apiKey).slice(0, 500)}`);
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
  let text;
  try {
    text = proxy
      ? await runCurl(endpoint, apiKey, body, { proxy, timeoutMs })
      : await runFetch(endpoint, apiKey, body, { timeoutMs });
  } catch (error) {
    // Transient network / 5xx: retry once before surfacing the failure.
    if (!/返回 (429|5\d\d)|fetch failed|curl|socket|timeout|EAI_AGAIN|ECONNRESET/i.test(error.message)) throw error;
    await new Promise((resolve) => setTimeout(resolve, 1200));
    text = proxy
      ? await runCurl(endpoint, apiKey, body, { proxy, timeoutMs })
      : await runFetch(endpoint, apiKey, body, { timeoutMs });
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`模型返回的不是 JSON：${redactSecret(text, apiKey).slice(0, 300)}`);
  }
  if (data?.error) {
    const message = data.error.message || JSON.stringify(data.error);
    throw new Error(redactSecret(String(message), apiKey).slice(0, 300));
  }
  try {
    return parseChatResponse(data);
  } catch (error) {
    throw new Error(redactSecret(error.message, apiKey));
  }
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
