#!/usr/bin/env node
'use strict';

const path = require('node:path');
const fsp = require('node:fs/promises');
const { runScanner } = require('./engine/scanner');
const { analyzeApp } = require('./engine/analyzer');
const { buildBundle } = require('./engine/packager');
const { resolveEngine } = require('./engine/resolver');
const { normalizeRecipe, recipeBuildOptions, MAX_RECIPE_BYTES } = require('./engine/recipe');
const { writeJson } = require('./engine/util');

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) {
      args._.push(token);
      continue;
    }
    const key = token.slice(2);
    if (key === 'no-runtimes') {
      args.runtimes = false;
      continue;
    }
    if (key === 'no-mono') {
      args.mono = false;
      continue;
    }
    if (key === 'user-data') {
      args.userData = true;
      continue;
    }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) {
      args[key] = true;
    } else {
      args[key] = value;
      i += 1;
    }
  }
  return args;
}

function usage() {
  console.log(`Win2Mac Studio CLI

  node cli.js scan [--out scan.json] [--proxy http://127.0.0.1:7897]
  node cli.js analyze --exe "C:\\Path\\App.exe" [--install "C:\\Path"] [--json]
  node cli.js build --exe "C:\\Path\\App.exe" [options]
  node cli.js engines [--proxy ...]

build options:
  --install <dir>        安装目录（默认取 exe 所在目录）
  --name <name>          应用显示名
  --publisher <name>
  --version <ver>
  --out <dir>            输出目录（默认 文档/Win2Mac）
  --engine auto|bundled|reuse
  --engine-archive <file> 手动指定 macOS Wine tar.xz
  --recipe <file>        应用 .win2mac.json 移植配方（CLI 参数优先）
  --registry <key>       额外导出注册表键（可重复）
  --args "<args>"        主程序启动参数
  --electron-flags "<args>" 覆盖 Electron 兼容启动参数
  --no-electron-compat   关闭 Electron 自动兼容参数
  --workdir <dir>        工作目录
  --user-data            包含用户数据
  --no-runtimes          不下载 VC++/Wine Mono
  --no-mono              不附带 Wine Mono
  --proxy <url>          构建时下载代理
  --app-json <file>      用 JSON 描述应用对象
`);
}

async function appFromArgs(args, recipe = null) {
  let app;
  if (args['app-json']) {
    app = JSON.parse((await fsp.readFile(path.resolve(args['app-json']), 'utf8')).replace(/^\uFEFF/, ''));
  } else {
    if (!args.exe) throw new Error('缺少 --exe');
    const exePath = path.resolve(args.exe);
    const installPath = args.install ? path.resolve(args.install) : path.dirname(exePath);
    app = {
      name: args.name || path.basename(exePath, path.extname(exePath)),
      publisher: args.publisher || '',
      version: args.version || '',
      installPath,
      exePath,
      workingDirectory: args.workdir ? path.resolve(args.workdir) : path.dirname(exePath),
      displayIcon: exePath,
      launchArgs: args.args || '',
      registryKeys: args.registry ? [].concat(args.registry) : [],
      source: 'cli',
      warnings: [],
    };
  }
  if (recipe) {
    app.name = args.name || recipe.app?.name || app.name;
    app.publisher = args.publisher || recipe.app?.publisher || app.publisher || '';
    app.version = args.version || recipe.app?.version || app.version || '';
  }
  return app;
}

async function loadRecipe(file) {
  try {
    const target = path.resolve(file);
    const stat = await fsp.stat(target);
    if (stat.size > MAX_RECIPE_BYTES) throw new Error(`配方文件过大（上限 ${MAX_RECIPE_BYTES} 字节）`);
    const raw = await fsp.readFile(target, 'utf8');
    return normalizeRecipe(JSON.parse(raw.replace(/^\uFEFF/, '')));
  } catch (error) {
    throw new Error(`配方无效：${error.message}`);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0];
  if (!command || args.help) {
    usage();
    return;
  }
  if (command === 'scan') {
    const result = await runScanner({
      onProgress: (progress) => console.error(progress.message),
    });
    if (args.out) {
      await writeJson(path.resolve(args.out), result);
      console.log(`已扫描 ${result.apps.length} 个应用 → ${path.resolve(args.out)}`);
    } else {
      console.log(JSON.stringify(result, null, 2));
    }
    return;
  }
  if (command === 'analyze') {
    const app = await appFromArgs(args);
    const analysis = await analyzeApp(app, { services: [] });
    if (args.json) {
      console.log(JSON.stringify({ app, analysis }, null, 2));
    } else {
      console.log(`${app.name}: ${analysis.grade} (${analysis.score}) ${analysis.gradeSummary}`);
      console.log(`${analysis.reasonSummary} · 推荐引擎 ${analysis.recommendedEngine}`);
      for (const reason of analysis.reasons) {
        console.log(`  [${reason.severity}] ${reason.title}: ${reason.detail}`);
      }
    }
    return;
  }
  if (command === 'build') {
    const recipe = args.recipe ? await loadRecipe(args.recipe) : null;
    const recipeOptions = recipe ? recipeBuildOptions(recipe) : null;
    const app = await appFromArgs(args, recipe);
    const outputDir = path.resolve(args.out || path.join(require('node:os').homedir(), 'Documents', 'Win2Mac'));
    console.error(`分析 ${app.name}…`);
    const analysis = await analyzeApp(app, { services: [] });
    console.error(`兼容性 ${analysis.grade} · ${analysis.gradeSummary}`);
    const result = await buildBundle(
      {
        app,
        analysis,
        outputDir,
        engineMode: args.engine || recipeOptions?.engineMode || 'auto',
        manualEngineArchive: args['engine-archive'] ? path.resolve(args['engine-archive']) : '',
        includeUserData: args.userData !== undefined ? Boolean(args.userData) : Boolean(recipeOptions?.includeUserData),
        includeRuntimes: args.runtimes === false ? false : recipeOptions ? recipeOptions.includeRuntimes : true,
        includeWineMono: args.mono === false ? false : recipeOptions ? recipeOptions.includeWineMono : true,
        advanced: {
          ...(recipeOptions?.advanced || {}),
          ...(args.args !== undefined ? { launchArgs: args.args } : {}),
          ...(args['electron-flags'] !== undefined ? { electronFlags: args['electron-flags'] } : {}),
          ...(args['no-electron-compat'] ? { electronCompat: false } : {}),
        },
        proxy: args.proxy || '',
      },
      (progress) => {
        if (progress.message) console.error(`[${progress.stage}] ${progress.message}`);
      },
    );
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (command === 'engines') {
    const result = await resolveEngine({
      mode: args.bundled ? 'bundled' : 'auto',
      proxy: args.proxy || '',
      onProgress: (progress) => console.error(progress.message),
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  throw new Error(`未知命令：${command}`);
}

main().catch((error) => {
  console.error(`错误：${error.message}`);
  if (process.env.WIN2MAC_DEBUG) console.error(error.stack);
  process.exit(1);
});
