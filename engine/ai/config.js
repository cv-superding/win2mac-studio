'use strict';

const { shellQuote } = require('../util');

const CONFIG_WHITELIST = new Set([
  'WIN2MAC_WINEDEBUG', 'WIN2MAC_DLL_OVERRIDES', 'WIN2MAC_ELECTRON_COMPAT', 'WIN2MAC_ENGINE_POLICY',
  'WIN2MAC_ENGINE_ORDER', 'WIN2MAC_VERIFY_ON_LAUNCH', 'WIN2MAC_PREVENT_SLEEP', 'WIN2MAC_WINEARCH',
]);

function isConfigKeyAllowed(key) {
  const name = String(key || '');
  if (CONFIG_WHITELIST.has(name)) return true;
  return /^WIN2MAC_ARG_(COUNT|[1-9][0-9]?)$/.test(name)
    || /^WIN2MAC_ENV_(COUNT|[1-9][0-9]?_(NAME|VALUE))$/.test(name);
}

function patchConfigText(text, changes) {
  const entries = Object.entries(changes || {});
  if (!entries.length) throw new Error('没有要修改的配置项');
  const lines = String(text).split(/\r?\n/);
  const applied = {};
  for (const [key, rawValue] of entries) {
    if (!isConfigKeyAllowed(key)) throw new Error(`不允许修改 ${key}`);
    const value = String(rawValue ?? '');
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)) throw new Error(`${key} 含非法控制字符`);
    if (value.length > 4000) throw new Error(`${key} 值过长`);
    const line = `${key}=${shellQuote(value)}`;
    const index = lines.findIndex((item) => item.startsWith(`${key}=`));
    if (index >= 0 && lines[index] !== line) {
      applied[key] = { from: lines[index].split('=').slice(1).join('='), to: line.split('=').slice(1).join('=') };
      lines[index] = line;
    } else if (index < 0) {
      applied[key] = { from: null, to: line.split('=').slice(1).join('=') };
      lines.push(line);
    }
  }
  return { text: lines.join('\n'), applied };
}

module.exports = { CONFIG_WHITELIST, isConfigKeyAllowed, patchConfigText };
