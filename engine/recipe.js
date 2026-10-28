'use strict';

const path = require('node:path');
const { normalizeAdvanced, normalizeExpectedExe } = require('./packager');

const RECIPE_FORMAT = 'win2mac-recipe/v1';
const MAX_RECIPE_BYTES = 256 * 1024;
const ENGINE_MODES = new Set(['auto', 'bundled', 'reuse']);
const INSTALLER_TYPES = new Set(['exe', 'msi']);
const WINE_DEBUG = new Set(['off', 'warn', 'all']);
const PRESETS = {
  '': 'interactive',
  '/S': 'nsis',
  '/VERYSILENT /SUPPRESSMSGBOXES /NORESTART': 'inno',
  '/qn /norestart': 'msi',
};

function text(value, max, label) {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') throw new Error(`${label}必须是字符串`);
  const trimmed = value.trim();
  if (trimmed.length > max) throw new Error(`${label}过长（最多 ${max} 字符）`);
  return trimmed;
}

function exactString(value, max, label) {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') throw new Error(`${label}必须是字符串`);
  if (value.length > max) throw new Error(`${label}过长（最多 ${max} 字符）`);
  return value;
}

function exeName(value) {
  const raw = text(value, 255, '主程序名');
  if (!raw) return '';
  return path.win32.basename(raw);
}

function sourceName(value) {
  return ['registry', 'shortcut', 'manual', 'installer', 'store', 'archive'].includes(value) ? value : 'manual';
}

function finiteSize(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
}

function inferInstallerPreset(args, type = 'exe') {
  const normalized = String(args || '').trim();
  if (!normalized) return 'interactive';
  if (PRESETS[normalized]) return PRESETS[normalized];
  if (type === 'msi' && /(^|\s)\/q[nbf]?(\s|$)/i.test(normalized)) return 'msi';
  return 'custom';
}

function normalizeInstaller(input) {
  if (input === undefined || input === null) return null;
  if (typeof input !== 'object' || Array.isArray(input)) throw new Error('安装器配置格式无效');
  const type = String(input.type || 'exe').toLowerCase();
  if (!INSTALLER_TYPES.has(type)) throw new Error('安装器类型只能是 exe 或 msi');
  return {
    type,
    args: exactString(input.args, 1024, '安装参数').trim(),
    expectedExe: normalizeExpectedExe(input.expectedExe),
  };
}

function normalizeAdvancedOptions(input) {
  if (input === undefined || input === null) input = {};
  if (typeof input !== 'object' || Array.isArray(input)) throw new Error('高级选项格式无效');
  normalizeAdvanced(input);
  return {
    metalHud: Boolean(input.metalHud),
    dxvkHud: Boolean(input.dxvkHud),
    verifyIntegrity: Boolean(input.verifyIntegrity),
    preventSleep: Boolean(input.preventSleep),
    wineDebug: WINE_DEBUG.has(input.wineDebug) ? input.wineDebug : 'off',
    launchArgs: exactString(input.launchArgs, 2048, '启动参数').trim(),
    envText: exactString(input.envText, 8192, '环境变量').replace(/\r\n?/g, '\n').trim(),
  };
}

function normalizeRecipe(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('配方文件不是有效的 JSON 对象');
  if (input.format !== RECIPE_FORMAT) {
    throw new Error(`不支持的配方格式：${String(input.format || '(缺失)')}。当前版本支持 ${RECIPE_FORMAT}`);
  }
  const app = input.app && typeof input.app === 'object' ? input.app : {};
  const match = input.match && typeof input.match === 'object' ? input.match : {};
  const compatibility = input.compatibility && typeof input.compatibility === 'object' ? input.compatibility : {};
  const options = input.options && typeof input.options === 'object' ? input.options : {};
  const installer = normalizeInstaller(input.installer);
  if (!ENGINE_MODES.has(options.engineMode)) {
    throw new Error(`运行引擎选项无效：${String(options.engineMode || '(缺失)')}`);
  }
  const advanced = normalizeAdvancedOptions(options.advanced);
  const recipe = {
    format: RECIPE_FORMAT,
    createdAt: text(input.createdAt, 40, '创建时间') || new Date().toISOString(),
    generator: {
      name: text(input.generator?.name, 80, '生成器名称') || 'Win2Mac Studio',
      version: text(input.generator?.version, 40, '生成器版本'),
    },
    app: {
      name: text(app.name, 200, '应用名称'),
      publisher: text(app.publisher, 200, '发布者'),
      version: text(app.version, 80, '应用版本'),
      exeName: exeName(app.exeName),
      source: sourceName(app.source),
    },
    match: {
      name: text(match.name, 200, '匹配名称'),
      publisher: text(match.publisher, 200, '匹配发布者'),
      exeName: exeName(match.exeName),
      bits: [32, 64].includes(Number(match.bits)) ? Number(match.bits) : 0,
      size: finiteSize(match.size),
    },
    compatibility: {
      grade: ['A', 'B', 'C', 'D'].includes(compatibility.grade) ? compatibility.grade : '',
      label: text(compatibility.label, 80, '兼容性标签'),
      summary: text(compatibility.summary, 300, '兼容性摘要'),
      recommendedEngine: ['wine', 'gptk', 'vm', 'none'].includes(compatibility.recommendedEngine)
        ? compatibility.recommendedEngine
        : '',
    },
    installer,
    options: {
      engineMode: options.engineMode,
      includeRuntimes: options.includeRuntimes !== false,
      includeWineMono: options.includeWineMono !== false,
      includeUserData: Boolean(options.includeUserData),
      advanced,
    },
    notes: text(input.notes, 2000, '备注'),
  };
  if (!recipe.app.name && !recipe.match.name && !recipe.match.exeName && !recipe.installer) {
    throw new Error('配方缺少应用信息，无法匹配目标');
  }
  return recipe;
}

function buildRecipe({ app = {}, analysis = {}, options = {}, installer = null, generatorVersion = '', notes = '' }) {
  const advanced = options.advanced || {};
  const name = app.name || '';
  const exe = exeName(app.exePath || '');
  const isInstaller = Boolean(installer) || app.source === 'installer';
  const recipe = {
    format: RECIPE_FORMAT,
    createdAt: new Date().toISOString(),
    generator: { name: 'Win2Mac Studio', version: generatorVersion },
    app: {
      name,
      publisher: app.publisher || '',
      version: app.version || '',
      exeName: exe,
      source: isInstaller ? 'installer' : sourceName(app.source),
    },
    match: {
      name,
      publisher: app.publisher || '',
      exeName: exe,
      bits: app.bits || 0,
      size: app.estimatedSizeBytes || 0,
    },
    compatibility: {
      grade: analysis.grade || '',
      label: analysis.gradeLabel || '',
      summary: analysis.gradeSummary || analysis.reasonSummary || '',
      recommendedEngine: analysis.recommendedEngine || '',
    },
    installer: isInstaller
      ? normalizeInstaller({
        type: installer?.type || 'exe',
        args: options.installerArgs || installer?.args || '',
        expectedExe: options.expectedExe || installer?.expectedExe || '',
      })
      : null,
    options: {
      engineMode: options.engineMode || 'auto',
      includeRuntimes: options.includeRuntimes !== false,
      includeWineMono: options.includeWineMono !== false,
      includeUserData: Boolean(options.includeUserData),
      advanced: {
        metalHud: Boolean(advanced.metalHud),
        dxvkHud: Boolean(advanced.dxvkHud),
        verifyIntegrity: Boolean(advanced.verifyIntegrity),
        preventSleep: Boolean(advanced.preventSleep),
        wineDebug: advanced.wineDebug || 'off',
        launchArgs: advanced.launchArgs || '',
        envText: advanced.envText || '',
      },
    },
    notes: text(notes, 2000, '备注'),
  };
  return normalizeRecipe(recipe);
}

function recipeBuildOptions(recipe) {
  const normalized = normalizeRecipe(recipe);
  const installer = normalized.installer;
  return {
    engineMode: normalized.options.engineMode,
    includeRuntimes: normalized.options.includeRuntimes,
    includeWineMono: normalized.options.includeWineMono,
    includeUserData: normalized.options.includeUserData,
    manualEngineArchive: '',
    installerArgs: installer?.args || '',
    installerArgsPreset: installer ? inferInstallerPreset(installer.args, installer.type) : 'interactive',
    expectedExe: installer?.expectedExe || '',
    advanced: {
      metalHud: normalized.options.advanced.metalHud,
      dxvkHud: normalized.options.advanced.dxvkHud,
      verifyIntegrity: normalized.options.advanced.verifyIntegrity,
      preventSleep: normalized.options.advanced.preventSleep,
      wineDebug: normalized.options.advanced.wineDebug,
      launchArgs: normalized.options.advanced.launchArgs,
      envText: normalized.options.advanced.envText,
    },
  };
}

function normalizeMatchText(value) {
  return String(value || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

function recipeMatchScore(recipe, app) {
  if (!recipe || !app) return 0;
  const name = normalizeMatchText(recipe.match?.name || recipe.app?.name);
  const exe = path.win32.basename(String(recipe.match?.exeName || recipe.app?.exeName || '')).toLowerCase();
  const appName = normalizeMatchText(app.name);
  const appExe = path.win32.basename(String(app.exePath || '')).toLowerCase();
  let score = 0;
  if (name && name === appName) score += 100;
  else if (name && (appName.includes(name) || name.includes(appName))) score += 55;
  if (exe && exe === appExe) score += 70;
  const publisher = normalizeMatchText(recipe.match?.publisher || recipe.app?.publisher);
  if (publisher && publisher === normalizeMatchText(app.publisher)) score += 20;
  return score;
}

module.exports = {
  RECIPE_FORMAT,
  MAX_RECIPE_BYTES,
  ENGINE_MODES,
  buildRecipe,
  normalizeRecipe,
  recipeBuildOptions,
  inferInstallerPreset,
  recipeMatchScore,
};
