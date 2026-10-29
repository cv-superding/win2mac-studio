'use strict';

const MAX_REBUILDS = 2;

function schema(name, description, properties = {}, required = []) {
  return { name, description, parameters: { type: 'object', properties, required } };
}

function buildFixerPrompt(ctx) {
  return [
    `应用：${ctx.appName || '未知'}（buildId=${ctx.buildId || 'unknown'}，目标平台=${ctx.platform || 'mac'}）`,
    ctx.analysisSummary ? `兼容性初判：${ctx.analysisSummary}` : '',
    ctx.diagnosticsSummary ? `已有诊断材料：\n${ctx.diagnosticsSummary}` : '当前没有 Mac 诊断包；如果需要真机日志，请让用户先运行 Start-Mac-Validation.command 并把桌面诊断 ZIP 导入。',
    '请先调用 get_status 了解现状，再按需要 read_file / patch_config / rebuild，最后调用 finish。',
  ].filter(Boolean).join('\n\n');
}

function createFixerTools({ ctx, limits = {} }) {
  const maxRebuilds = limits.maxRebuilds ?? MAX_REBUILDS;
  let rebuilds = 0;
  return [
    {
      ...schema('get_status', '获取当前构建、配置与诊断包的整体状态'),
      run: () => ctx.status(),
    },
    {
      ...schema('read_file', '读取白名单内的文本文件（config.env、bundle.json、诊断报告、日志等）', {
        path: { type: 'string', description: '绝对路径或相对路径（config.env、bundle.json、Report.md、Missing.txt、Logs/xxx.log）' },
        maxBytes: { type: 'integer', description: '最多读取字节数，默认 30000' },
      }, ['path']),
      run: (args) => ctx.readFile(args.path, args.maxBytes),
    },
    {
      ...schema('search_logs', '在启动日志与诊断报告里搜索关键字，返回命中行', {
        query: { type: 'string', description: '要搜索的关键字，例如 err:、not found、wineboot' },
        limit: { type: 'integer', description: '最多返回条数，默认 30' },
      }, ['query']),
      run: (args) => ctx.searchLogs(args.query, args.limit),
    },
    {
      ...schema('patch_config', '修改产物内的 config.env（仅允许白名单键）', {
        changes: {
          type: 'object',
          description: '键值对，例如 {"WIN2MAC_WINEDEBUG":"fixme-all","WIN2MAC_DLL_OVERRIDES":"mshtml=;d3d11=n"}',
          additionalProperties: { type: 'string' },
        },
      }, ['changes']),
      run: (args) => ctx.patchConfig(args.changes),
    },
    {
      ...schema('rebuild', '用新的高级选项重新构建产物（会覆盖同一输出目录下的旧 ZIP）', {
        advanced: {
          type: 'object',
          description: '可覆盖的高级选项：wineDebug、electronCompat(boolean)、dllOverrides、launchArgs、envText、engineMode(auto|bundled|reuse)',
          additionalProperties: true,
        },
      }),
      run: async (args) => {
        if (rebuilds >= maxRebuilds) return { error: `本次最多重建 ${maxRebuilds} 次，请先总结现有结论` };
        rebuilds += 1;
        return ctx.rebuild(args.advanced || {});
      },
    },
    {
      ...schema('finish', '结束修复并给出中文总结', {
        summary: { type: 'string', description: '已改什么、预期效果、用户下一步要做什么' },
      }, ['summary']),
      run: (args) => {
        const summary = String(args.summary || '').trim();
        if (!summary) throw new Error('总结不能为空');
        return { summary };
      },
    },
  ];
}

module.exports = { createFixerTools, buildFixerPrompt, MAX_REBUILDS };
