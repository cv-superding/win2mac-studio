'use strict';

const DEFAULT_AI = {
  baseUrl: 'https://api.openai.com/v1',
  model: 'gpt-4o-mini',
  apiKey: '',
  temperature: 0.2,
  timeoutMs: 120000,
};

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

function normalizeAiSettings(patch = {}, current = {}) {
  const next = { ...DEFAULT_AI, ...current };
  if (patch.clearKey) next.apiKey = '';
  if (patch.apiKey !== undefined && !patch.clearKey) {
    next.apiKey = String(patch.apiKey || '').trim();
    if (next.apiKey.length > 4096) throw new Error('API Key 过长');
  }
  if (patch.baseUrl !== undefined) {
    const baseUrl = String(patch.baseUrl || '').trim() || DEFAULT_AI.baseUrl;
    if (!/^https?:\/\//i.test(baseUrl)) throw new Error('Base URL 必须以 http:// 或 https:// 开头');
    next.baseUrl = baseUrl.replace(/\/+$/, '');
  }
  if (patch.model !== undefined) {
    const model = String(patch.model || '').trim();
    if (model.length > 200) throw new Error('模型名过长');
    next.model = model || DEFAULT_AI.model;
  }
  if (patch.temperature !== undefined) next.temperature = clampNumber(patch.temperature, 0, 2, DEFAULT_AI.temperature);
  if (patch.timeoutMs !== undefined) next.timeoutMs = Math.trunc(clampNumber(patch.timeoutMs, 5000, 300000, DEFAULT_AI.timeoutMs));
  return next;
}

function publicAiSettings(ai = {}) {
  const merged = { ...DEFAULT_AI, ...ai };
  const apiKey = String(merged.apiKey || '');
  return {
    baseUrl: merged.baseUrl,
    model: merged.model,
    temperature: merged.temperature,
    hasKey: Boolean(apiKey),
    keyHint: apiKey ? `${apiKey.slice(0, 3)}…${apiKey.slice(-4)}` : '',
  };
}

function assertAiReady(ai = {}) {
  if (!ai.apiKey) throw new Error('还没有配置 API Key，请先在设置里填写 OpenAI 兼容接口的 Key');
  return true;
}

module.exports = { DEFAULT_AI, normalizeAiSettings, publicAiSettings, assertAiReady };
