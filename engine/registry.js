'use strict';

const path = require('node:path');

const GENERIC_TOKENS = new Set([
  'app', 'application', 'program', 'desktop', 'client', 'launcher', 'setup',
  'installer', 'install', 'update', 'updater', 'electron', 'node', 'nodejs',
  'windows', 'microsoft', 'google', 'adobe', 'common', 'unknown', 'default',
  'software', 'system', 'utility', 'tools', 'x64', 'x86', 'win64', 'win32',
]);
const MAX_TOKENS = 12;
const MAX_KEYS = 56;

function cleanToken(value) {
  let token = String(value || '').trim();
  if (!token) return '';
  token = token
    .replace(/\((?:x64|x86|32-bit|64-bit)\)/gi, ' ')
    .replace(/\b(?:inc|llc|ltd|corp|corporation|co|gmbh|limited)\b\.?/gi, ' ')
    .replace(/\b(?:19|20)\d{2}\b/g, ' ')
    .replace(/\b(?:x64|x86|32-bit|64-bit|win64|win32)\b/gi, ' ')
    .replace(/[\\/:*?"<>|]+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[\s.,;_-]+|[\s.,;_-]+$/g, '');
  return token;
}

function addToken(tokens, seen, value) {
  const cleaned = cleanToken(value);
  if (!cleaned) return;
  const variants = [cleaned, cleaned.replace(/\s+/g, '')];
  for (const variant of variants) {
    const key = variant.toLowerCase();
    if (variant.length < 3 || variant.length > 64) continue;
    if (GENERIC_TOKENS.has(key)) continue;
    if (seen.has(key)) continue;
    seen.add(key);
    tokens.push(variant);
  }
}

function buildTokens({ app, electron }) {
  const tokens = [];
  const seen = new Set();
  const exeBase = path.win32.basename(String(app.exePath || ''), path.extname(String(app.exePath || '')));
  addToken(tokens, seen, app.name);
  addToken(tokens, seen, exeBase);
  addToken(tokens, seen, electron?.packageName);
  addToken(tokens, seen, electron?.productName);
  addToken(tokens, seen, electron?.appId);
  const publisher = String(app.publisher || '');
  for (const part of publisher.split(/[,;|/]+/)) addToken(tokens, seen, part);
  return tokens.slice(0, MAX_TOKENS);
}

function generateRegistryKeys({ app, electron } = {}) {
  const keys = [];
  const seen = new Set();
  const add = (key) => {
    const normalized = String(key || '').trim().replace(/^HKEY_/, '');
    if (!normalized) return;
    const id = normalized.toLowerCase();
    if (seen.has(id)) return;
    seen.add(id);
    keys.push(normalized);
  };

  for (const key of app?.registryKeys || []) add(key);

  const exeName = path.win32.basename(String(app?.exePath || ''));
  if (/\.exe$/i.test(exeName)) {
    add(`HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\${exeName}`);
    add(`HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\${exeName}`);
    add(`HKCU\\Software\\Classes\\Applications\\${exeName}`);
    add(`HKLM\\SOFTWARE\\Classes\\Applications\\${exeName}`);
  }

  const tokens = buildTokens({ app, electron });
  for (const token of tokens) {
    if (keys.length >= MAX_KEYS) return keys;
    add(`HKCU\\Software\\${token}`);
  }
  for (const vendor of tokens) {
    for (const product of tokens) {
      if (vendor.toLowerCase() === product.toLowerCase()) continue;
      if (keys.length >= MAX_KEYS) return keys;
      add(`HKCU\\Software\\${vendor}\\${product}`);
    }
  }
  for (const token of tokens) {
    if (keys.length + 2 > MAX_KEYS) break;
    add(`HKLM\\SOFTWARE\\${token}`);
    add(`HKLM\\SOFTWARE\\WOW6432Node\\${token}`);
  }
  for (const vendor of tokens) {
    for (const product of tokens) {
      if (vendor.toLowerCase() === product.toLowerCase()) continue;
      if (keys.length + 2 > MAX_KEYS) return keys;
      add(`HKLM\\SOFTWARE\\${vendor}\\${product}`);
      add(`HKLM\\SOFTWARE\\WOW6432Node\\${vendor}\\${product}`);
    }
  }
  return keys;
}

module.exports = {
  GENERIC_TOKENS,
  MAX_KEYS,
  buildTokens,
  cleanToken,
  generateRegistryKeys,
};
