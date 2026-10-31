'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { diagnoseBundle } = require('../engine/ai/diagnose');

test('缺失文件与大小不符判定为传输问题', () => {
  const issues = diagnoseBundle({
    report: { payload: { missingCount: 2, sizeMismatchCount: 1, issues: ['MISSING\tC/a.exe', 'SIZE_MISMATCH\tC/b.dll'] } },
  });
  assert.ok(issues.some((i) => i.id === 'payload-missing' && i.severity === 'block'));
  assert.ok(issues.some((i) => i.id === 'payload-size-mismatch'));
  assert.ok(!issues.some((i) => i.fix?.config), '传输问题不能被配置修复');
});

test('reuse 策略且无引擎时给出配置修复', () => {
  const issues = diagnoseBundle({
    configText: "WIN2MAC_ENGINE_POLICY='reuse'\n",
    logText: 'engine: policy=reuse and no local engine',
  });
  const issue = issues.find((i) => i.id === 'engine-unavailable');
  assert.ok(issue);
  assert.equal(issue.fix.config.WIN2MAC_ENGINE_POLICY, 'auto');
  assert.equal(issue.fix.rebuild, true);
});

test('Electron 兼容关闭时建议开启', () => {
  const issues = diagnoseBundle({
    configText: "WIN2MAC_ELECTRON='1'\nWIN2MAC_ELECTRON_COMPAT='0'\n",
    logText: 'STAGE launch',
  });
  const issue = issues.find((i) => i.id === 'electron-compat-off');
  assert.ok(issue);
  assert.equal(issue.fix.config.WIN2MAC_ELECTRON_COMPAT, '1');
});

test('Rosetta 与 Gatekeeper 关键字识别', () => {
  const issues = diagnoseBundle({ logText: '未安装 Rosetta 2，无法运行\nquarantine: detected' });
  assert.ok(issues.some((i) => i.id === 'rosetta-missing'));
  assert.ok(issues.some((i) => i.id === 'gatekeeper-blocked'));
});

test('无异常时不编造问题', () => {
  assert.deepEqual(diagnoseBundle({ report: {}, configText: '', logText: 'STAGE launch\napp exited status=0' }), []);
});
