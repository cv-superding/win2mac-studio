'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { buildTokens, cleanToken, generateRegistryKeys, MAX_KEYS } = require('../engine/registry');

test('registry token cleanup strips vendors and architecture noise', () => {
  assert.equal(cleanToken('Acme Studio (x64)'), 'Acme Studio');
  assert.equal(cleanToken('Acme, Inc.'), 'Acme');
  assert.equal(cleanToken('2024 Widget Corp'), 'Widget');
  assert.equal(cleanToken('微软'), '微软');
});

test('registry candidates include uninstall, App Paths and vendor keys', () => {
  const keys = generateRegistryKeys({
    app: {
      name: '客源雷达',
      publisher: 'creturn, Inc',
      exePath: 'C:\\Users\\Old\\AppData\\Local\\Programs\\客源雷达\\客源雷达.exe',
      registryKeys: ['HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\baokeai'],
    },
    electron: { packageName: 'baokeai', productName: '客源雷达', appId: 'com.creturn.baokeai' },
  });
  assert.equal(keys[0], 'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\baokeai');
  assert.ok(keys.includes('HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\客源雷达.exe'));
  assert.ok(keys.includes('HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\客源雷达.exe'));
  assert.ok(keys.includes('HKCU\\Software\\baokeai'));
  assert.ok(keys.includes('HKLM\\SOFTWARE\\WOW6432Node\\creturn'));
  assert.ok(keys.includes('HKCU\\Software\\creturn\\baokeai'));
  assert.ok(keys.length <= MAX_KEYS);
});

test('registry candidates drop generic and duplicate tokens', () => {
  const tokens = buildTokens({
    app: { name: 'App', publisher: 'Microsoft', exePath: 'C:\\App\\App.exe' },
    electron: { packageName: 'electron', productName: 'client' },
  });
  assert.deepEqual(tokens, []);
  const keys = generateRegistryKeys({ app: { name: 'Acme', exePath: 'C:\\Acme\\Acme.exe', registryKeys: [] } });
  const lower = keys.map((key) => key.toLowerCase());
  assert.equal(new Set(lower).size, lower.length);
});
