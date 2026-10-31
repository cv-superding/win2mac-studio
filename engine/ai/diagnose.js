'use strict';

function parseConfig(text) {
  const map = {};
  for (const line of String(text || '').split(/\r?\n/)) {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (!match) continue;
    let value = match[2].trim();
    if (value.startsWith("'") && value.endsWith("'")) {
      value = value.slice(1, -1).replace(/'\\''/g, "'");
    }
    map[match[1]] = value;
  }
  return map;
}

function addIssue(list, seen, issue) {
  if (seen.has(issue.id)) return;
  seen.add(issue.id);
  list.push(issue);
}

function diagnoseBundle({ report = {}, configText = '', manifestIssues = [], logText = '' } = {}) {
  const config = parseConfig(configText);
  const log = String(logText || '');
  const issues = [];
  const seen = new Set();
  const has = (pattern) => pattern.test(log);
  const missing = Number(report?.payload?.missingCount) || 0;
  const mismatched = Number(report?.payload?.sizeMismatchCount) || 0;
  const manualMissing = manifestIssues.filter((line) => /^MISSING/i.test(line)).slice(0, 5);
  const manualMismatch = manifestIssues.filter((line) => /^SIZE_MISMATCH/i.test(line)).slice(0, 5);

  if (missing > 0 || manualMissing.length) {
    addIssue(issues, seen, {
      id: 'payload-missing',
      severity: 'block',
      title: `${missing || manualMissing.length} 个应用文件缺失`,
      detail: '这是传输/解压不完整，不是 Wine 配置问题，改配置无法修复。',
      evidence: manualMissing,
      fix: { manual: ['让用户用 Finder 重新解压原始 ZIP', '若仍缺失，重新发送完整 ZIP（不要经过会改写文件的同步盘）'] },
    });
  }
  if (mismatched > 0 || manualMismatch.length) {
    addIssue(issues, seen, {
      id: 'payload-size-mismatch',
      severity: 'block',
      title: `${mismatched || manualMismatch.length} 个文件大小不符`,
      detail: '文件在传输过程中被截断或改写。',
      evidence: manualMismatch,
      fix: { manual: ['重新解压/重新发送原始 ZIP', '不要用会重写文件的压缩软件二次压缩'] },
    });
  }

  if (has(/bad interpreter|unbound variable|syntax error near/i)) {
    addIssue(issues, seen, {
      id: 'launcher-script-broken',
      severity: 'block',
      title: '启动器脚本损坏或被旧版本覆盖',
      detail: 'macOS bash 无法解析 launcher，常见于行尾被改成 CRLF 或产物来自旧版本。',
      evidence: (log.match(/.*(bad interpreter|unbound variable|syntax error).*/gi) || []).slice(0, 3),
      fix: { manual: ['用当前版本重新转换该应用', '确认 ZIP 用 Finder 解压，不要用会改行尾的工具'] },
    });
  }

  if (has(/未找到可用的 Wine 引擎|engine: policy=reuse and no local engine|no URL configured/i)) {
    const reuse = String(config.WIN2MAC_ENGINE_POLICY || '') === 'reuse';
    addIssue(issues, seen, {
      id: 'engine-unavailable',
      severity: 'block',
      title: reuse ? '只复用引擎，但 Mac 上没有可用 Wine' : 'Mac 上找不到可用 Wine 引擎',
      detail: reuse
        ? '该产物被设置为仅复用本机引擎，但目标 Mac 未安装 CrossOver / GPTK / Whisky。'
        : '自动模式未能发现本地引擎，且下载也失败。',
      evidence: (log.match(/.*(engine:|未找到可用的 Wine 引擎|no URL configured).*/gi) || []).slice(0, 3),
      fix: reuse
        ? { config: { WIN2MAC_ENGINE_POLICY: 'auto' }, advanced: { engineMode: 'auto' }, rebuild: true }
        : { manual: ['让 Mac 连接网络后重试，或安装 CrossOver / GPTK', '或在 Windows 端用「内置 Wine」重新打包'] },
    });
  }

  if (has(/engine download: failed|curl_rc=[1-9]|Could not resolve host/i)) {
    addIssue(issues, seen, {
      id: 'engine-download-failed',
      severity: 'warn',
      title: 'Wine 引擎下载失败',
      detail: '首次启动需要下载约 184 MB 引擎，网络被拦截或 DNS 不可用。',
      evidence: (log.match(/.*(engine download:|curl|resolve host).*/gi) || []).slice(0, 3),
      fix: { manual: ['换网络/代理后重试', '或让打包者选择「内置 Wine 引擎」重新打包'] },
    });
  }

  if (has(/prefix check: drive_c missing|wineboot rc=[1-9]/i)) {
    addIssue(issues, seen, {
      id: 'prefix-init-failed',
      severity: 'block',
      title: 'Wine 前缀初始化失败',
      detail: 'wineboot 没有生成 drive_c，常见于引擎不可执行、磁盘权限或安全软件拦截。',
      evidence: (log.match(/.*(wineboot rc|prefix check|drive_c missing).*/gi) || []).slice(0, 3),
      fix: { advanced: { wineDebug: 'fixme-all' }, manual: ['在 Mac 上运行 Reset-Runtime.command 后重试'] },
    });
  }

  if (String(config.WIN2MAC_ELECTRON || '0') === '1' && String(config.WIN2MAC_ELECTRON_COMPAT || '1') === '0') {
    addIssue(issues, seen, {
      id: 'electron-compat-off',
      severity: 'warn',
      title: 'Electron 应用关闭了 Wine 兼容参数',
      detail: 'Electron 在 Wine 下通常需要 --no-sandbox / --disable-gpu，否则白屏或直接退出。',
      evidence: [`WIN2MAC_ELECTRON_COMPAT=${config.WIN2MAC_ELECTRON_COMPAT}`],
      fix: { config: { WIN2MAC_ELECTRON_COMPAT: '1' }, advanced: { electronCompat: true }, rebuild: true },
    });
  }

  if (has(/runtime install \d+ rc=[1-9]/i)) {
    addIssue(issues, seen, {
      id: 'runtime-install-failed',
      severity: 'warn',
      title: 'VC++ / Wine Mono 运行时安装失败',
      detail: '缺运行库时应用可能报 0xc000007b 或缺少 DLL。',
      evidence: (log.match(/.*runtime install.*/gi) || []).slice(0, 3),
      fix: { advanced: { includeRuntimes: true }, manual: ['用带运行库的配置重新打包'] },
    });
  }

  if (has(/err:module:import_dll|0xc000007b|missing dll/i)) {
    addIssue(issues, seen, {
      id: 'missing-dll',
      severity: 'warn',
      title: 'Wine 加载 DLL 失败',
      detail: '应用依赖的 DLL 未随包携带，或需要系统运行库。',
      evidence: (log.match(/.*(import_dll|0xc000007b|missing dll).*/gi) || []).slice(0, 3),
      fix: { advanced: { includeRuntimes: true }, manual: ['在 Windows 端确认依赖 DLL 与安装目录一起打包'] },
    });
  }

  if (has(/未安装 Rosetta|bad CPU type|arch -x86_64/i)) {
    addIssue(issues, seen, {
      id: 'rosetta-missing',
      severity: 'block',
      title: 'Apple Silicon 缺少 Rosetta 2',
      detail: 'x86_64 Wine 引擎需要 Rosetta 2。',
      evidence: (log.match(/.*(Rosetta|bad CPU type).*/gi) || []).slice(0, 3),
      fix: { manual: ['在终端运行：softwareupdate --install-rosetta --agree-to-license'] },
    });
  }

  if (has(/quarantine|Gatekeeper|无法打开|developer cannot be verified/i)) {
    addIssue(issues, seen, {
      id: 'gatekeeper-blocked',
      severity: 'warn',
      title: 'macOS Gatekeeper 拦截未签名应用',
      detail: '这不是转换失败，需要用户手动允许。',
      evidence: (log.match(/.*(quarantine|Gatekeeper).*/gi) || []).slice(0, 3),
      fix: { manual: ['右键 .app → 打开；或到「系统设置 → 隐私与安全性 → 仍要打开」', '也可先运行 Open-Win2Mac-App.command'] },
    });
  }

  if (has(/No space left|磁盘空间不足|ENOSPC/i)) {
    addIssue(issues, seen, {
      id: 'disk-full',
      severity: 'block',
      title: '磁盘空间不足',
      detail: '复制 payload 或初始化 prefix 时空间耗尽。',
      evidence: (log.match(/.*(No space left|ENOSPC|磁盘空间).*/gi) || []).slice(0, 3),
      fix: { manual: ['清理磁盘后运行 Reset-Runtime.command 重试'] },
    });
  }

  if (has(/未找到主程序|exe expected:.*not found/i)) {
    addIssue(issues, seen, {
      id: 'exe-not-found',
      severity: 'block',
      title: 'Wine 中找不到主程序',
      detail: '安装路径映射不完整，或安装器模式没有安装成功。',
      evidence: (log.match(/.*(未找到主程序|exe expected).*/gi) || []).slice(0, 3),
      fix: { manual: ['重置运行环境后重试', '安装器模式请填写准确的预期主程序名'] },
    });
  }

  return issues;
}

module.exports = { diagnoseBundle, parseConfig };
