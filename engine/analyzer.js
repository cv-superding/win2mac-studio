'use strict';

const path = require('node:path');
const { inspectPEFile } = require('./pe');
const { walkFiles, isPathInside, formatBytes } = require('./util');

const GRADE_LABELS = {
  A: { label: '可直接运行', tone: 'green', summary: '常规 Win32 程序，Wine 兼容性高' },
  B: { label: '通常可运行', tone: 'blue', summary: '可能需要少量运行时或图形配置' },
  C: { label: '需要调校', tone: 'amber', summary: '依赖较多，建议 CrossOver/GPTK 并准备排障' },
  D: { label: '不建议直接运行', tone: 'red', summary: '存在内核/反作弊/DRM 等硬性障碍' },
};

const ANTI_CHEAT_PATTERN =
  /(easyanticheat|easy anti-cheat|battleye|beclient|beservice|vgc\.exe|vanguard|anticheat|anti-cheat|denuvo|securom|safedisc|starforce|xigncode|nprotect|gameguard|mhyprot|tp3helper|faceit)/i;

const DRM_PATTERN = /(denuvo|securom|safedisc|starforce|drm|activation64)/i;

const USB_PATTERN = /(^|[\\/])(adb\.exe|scrcpy[^\\/]*\.exe|libusb[^\\/]*\.dll)$/i;

function importMatches(imports, patterns) {
  const names = Array.isArray(imports) ? imports : [...imports];
  return patterns.some((pattern) => {
    if (pattern instanceof RegExp) return names.some((name) => pattern.test(name));
    return names.includes(pattern);
  });
}

function addReason(reasons, severity, code, title, detail) {
  reasons.push({ severity, code, title, detail });
}

async function scanDirectoryRisks(installPath, options = {}) {
  const result = {
    files: 0,
    bytes: 0,
    truncated: false,
    antiCheatHits: [],
    kernelDrivers: [],
    drmHits: [],
    usbHits: [],
    warnings: [],
  };
  if (!installPath || options.scanDirectory === false) return result;
  const walk = await walkFiles(installPath, { maxFiles: options.maxFiles || 4000 });
  result.files = walk.files.length;
  result.bytes = walk.files.reduce((sum, file) => sum + file.size, 0);
  result.truncated = walk.truncated;
  result.warnings = walk.warnings;
  for (const file of walk.files) {
    const rel = path.relative(installPath, file.path);
    if (ANTI_CHEAT_PATTERN.test(rel)) result.antiCheatHits.push(rel);
    if (DRM_PATTERN.test(rel)) result.drmHits.push(rel);
    if (USB_PATTERN.test(rel)) result.usbHits.push(rel);
    if (/\.sys$/i.test(rel)) result.kernelDrivers.push(rel);
  }
  result.antiCheatHits = [...new Set(result.antiCheatHits)].slice(0, 12);
  result.drmHits = [...new Set(result.drmHits)].slice(0, 12);
  result.usbHits = [...new Set(result.usbHits)].slice(0, 12);
  result.kernelDrivers = [...new Set(result.kernelDrivers)].slice(0, 12);
  return result;
}

function matchServices(app, services = []) {
  if (!Array.isArray(services) || !app.installPath) return [];
  return services.filter((service) => {
    const image = String(service.PathName || service.pathName || service.imagePath || '');
    return image && isPathInside(image.replace(/^"|"$/g, '').split(/\s+-/)[0], app.installPath);
  });
}

async function analyzeApp(app, options = {}) {
  const reasons = [];
  const dependencies = {
    vcrun: false,
    dotnetFramework: false,
    dotnetCore: false,
    webview2: false,
    directx: [],
    openGL: false,
    vulkan: false,
    input: false,
    audio: false,
    kernel: false,
    antiCheat: false,
    drm: false,
    usb: false,
  };
  let score = 97;
  let blocked = false;

  const exe = app.exePath || app.exe;
  let pe = null;
  if (!exe) {
    score = Math.min(score, 62);
    addReason(
      reasons,
      'warn',
      'no-exe',
      '未定位主程序',
      '没有找到可启动的 .exe。请在应用详情里手动指定主程序，否则 Apple 端无法启动。',
    );
  } else {
    pe = await inspectPEFile(exe);
    if (!pe.ok) {
      score = Math.min(score, 58);
      addReason(
        reasons,
        'warn',
        'pe-read-failed',
        '主程序解析失败',
        pe.error || '无法读取 PE 头，可能是占位启动器或文件损坏。',
      );
    }
  }

  const imports = new Set((pe?.allImports || pe?.imports || []).map((name) => name.toLowerCase()));
  if (pe?.ok) {
    if (pe.arch === 'x64') {
      addReason(reasons, 'ok', 'x64', '64 位 Win32 程序', '可通过 Wine 以 64 位 Windows 环境运行。');
    } else if (pe.arch === 'x86') {
      score -= 8;
      addReason(
        reasons,
        'warn',
        'x86',
        '32 位 x86 程序',
        '需要 Wine 的 WoW64 支持（Wine 9+ / CrossOver 24+ 较稳）。旧引擎可能无法启动。',
      );
    } else if (pe.arch === 'arm64') {
      score = 12;
      blocked = true;
      addReason(
        reasons,
        'block',
        'arm64',
        'Windows ARM64 程序',
        'Wine 目前不能可靠运行 Windows ARM64 二进制，需虚拟机或原生移植。',
      );
    } else {
      score = Math.min(score, 55);
      addReason(reasons, 'warn', 'unknown-arch', '未知可执行架构', '无法确认 CPU 架构，运行风险较高。');
    }

    if (pe.subsystem === 'console') {
      score -= 2;
      addReason(reasons, 'info', 'console', '控制台程序', '启动后会打开终端窗口，属于正常行为。');
    } else if (pe.subsystem === 'gui') {
      addReason(reasons, 'info', 'gui', '图形界面程序', '将作为普通 macOS 应用启动。');
    }
  }

  if (importMatches(imports, [/^(mscoree|mscorlib)\.dll$/])) {
    dependencies.dotnetFramework = true;
    score -= 22;
    addReason(
      reasons,
      'warn',
      'dotnet-framework',
      '依赖 .NET Framework',
      '需要 Wine Mono 或 winetricks dotnet48。复杂 WinForms/WPF 应用可能需要额外字体与主题调整。',
    );
  }
  if (importMatches(imports, [/^(hostfxr|coreclr|clrjit|hostpolicy)\.dll$/])) {
    dependencies.dotnetCore = true;
    score -= 7;
    addReason(
      reasons,
      'warn',
      'dotnet-core',
      '依赖 .NET / .NET Core',
      '自包含 .NET 应用通常可运行；框架依赖型需要目标机安装对应 .NET 运行时。',
    );
  }
  if (importMatches(imports, [/webview2loader\.dll$/])) {
    dependencies.webview2 = true;
    score -= 18;
    addReason(
      reasons,
      'warn',
      'webview2',
      '依赖 WebView2',
      'Wine 对 Edge WebView2 支持有限，内嵌浏览器界面可能空白或崩溃。优先考虑 CrossOver 新版本。',
    );
  }
  if (importMatches(imports, [/api-ms-win-crt|vcruntime|msvcp|msvcr|concrt/])) {
    dependencies.vcrun = true;
    addReason(
      reasons,
      'info',
      'vcrun',
      '依赖 Visual C++ 运行库',
      '打包时会附带微软 VC++ Redistributable，首次运行时自动安装。',
    );
  }
  if (importMatches(imports, [/d3d12|dxgi/]) && imports.has('d3d12.dll')) {
    dependencies.directx.push('DirectX 12');
    score -= 22;
    addReason(
      reasons,
      'warn',
      'dx12',
      '依赖 DirectX 12',
      '需要 Apple Game Porting Toolkit 2 或 CrossOver 24+ 的 D3DMetal；内置 Wine 对 DX12 支持有限。',
    );
  }
  if (importMatches(imports, [/d3d11|d3d10|dxgi/])) {
    dependencies.directx.push('DirectX 10/11');
    score -= 8;
    addReason(
      reasons,
      'warn',
      'dx11',
      '依赖 DirectX 10/11',
      '建议在 Mac 端使用 CrossOver 或 GPTK 的 D3DMetal；普通 Wine 需 DXVK/MoltenVK，性能和兼容性因机器而异。',
    );
  }
  if (importMatches(imports, [/^(d3d8|d3d9|ddraw)\.dll$/])) {
    dependencies.directx.push('DirectX 8/9');
    score -= 4;
    addReason(reasons, 'info', 'dx9', '依赖 DirectX 8/9', 'Wine 内置 D3D 可处理多数老程序，建议使用 DXVK 配置。');
  }
  if (importMatches(imports, [/opengl32\.dll$/])) {
    dependencies.openGL = true;
    score -= 2;
    addReason(reasons, 'info', 'opengl', '使用 OpenGL', '通过 macOS OpenGL 兼容层运行，复杂渲染可能受限。');
  }
  if (importMatches(imports, [/vulkan-1\.dll$/])) {
    dependencies.vulkan = true;
    score -= 8;
    addReason(reasons, 'warn', 'vulkan', '使用 Vulkan', '需要 MoltenVK；在 Wine 前缀中配置较复杂。');
  }
  if (importMatches(imports, [/^(dinput8|dinput|xinput1_3|xinput1_4|xinput9_1_0)\.dll$/])) {
    dependencies.input = true;
    addReason(reasons, 'info', 'input', '使用 DirectInput/XInput', '手柄通常可用，键鼠映射与振动支持取决于引擎。');
  }
  if (importMatches(imports, [/^(xaudio2_7|dsound|winmm)\.dll$/])) {
    dependencies.audio = true;
    addReason(reasons, 'info', 'audio', '使用 DirectSound/XAudio', '通常由 Wine 内置音频层处理。');
  }
  if (importMatches(imports, [/^(ntoskrnl|hal|wdf01000|wdfldr)\./])) {
    dependencies.kernel = true;
    score = Math.min(score, 20);
    blocked = true;
    addReason(
      reasons,
      'block',
      'kernel-import',
      '导入内核驱动接口',
      'Wine 不实现 Windows 内核驱动。此类程序无法在普通 Wine 环境运行。',
    );
  }

  const externalWorkdir = app.externalWorkingDirectory || app.workingDirectory;
  if (externalWorkdir && app.installPath && !isPathInside(externalWorkdir, app.installPath)) {
    score -= 6;
    addReason(
      reasons,
      'warn',
      'external-workdir',
      '工作目录在安装目录之外',
      `原应用使用 ${externalWorkdir} 作为工作目录，但该目录不在安装路径内，默认不会进入载荷。应用可能无法找到版本文件或资源。`,
    );
  }

  const dirRisks = await scanDirectoryRisks(app.installPath, options);
  if (dirRisks.antiCheatHits.length) {
    dependencies.antiCheat = true;
    score = Math.min(score, 18);
    blocked = true;
    addReason(
      reasons,
      'block',
      'anticheat',
      '检测到反作弊组件',
      `发现：${dirRisks.antiCheatHits.slice(0, 3).join('、')}。多数反作弊会拒绝 Wine 或禁止联机，只能用虚拟机（且有封号风险）。`,
    );
  }
  if (dirRisks.kernelDrivers.length) {
    dependencies.kernel = true;
    score = Math.min(score, 15);
    blocked = true;
    addReason(
      reasons,
      'block',
      'kernel-driver',
      '包含 Windows 内核驱动 (.sys)',
      `发现：${dirRisks.kernelDrivers.slice(0, 3).join('、')}。Wine 无法加载内核驱动，程序大概率无法启动。`,
    );
  }
  if (dirRisks.drmHits.length) {
    dependencies.drm = true;
    score = Math.min(score, 28);
    blocked = true;
    addReason(
      reasons,
      'block',
      'drm',
      '检测到 DRM / 激活组件',
      `发现：${dirRisks.drmHits.slice(0, 3).join('、')}。DRM 服务通常无法在 Wine 中验证，需官方 Mac 版或虚拟机。`,
    );
  }

  if (dirRisks.usbHits.length) {
    dependencies.usb = true;
    score = Math.min(score, 30);
    blocked = true;
    addReason(
      reasons,
      'block',
      'usb-device',
      '依赖 USB / ADB 设备访问',
      `发现：${dirRisks.usbHits.slice(0, 3).join('、')}。Wine 在 macOS 上不能把 USB 设备直通给 Windows 程序，ADB 调试、手机投屏、加密狗、串口设备等通常无法工作。建议改用 UTM/Parallels 虚拟机，或寻找该软件的官方 Mac 版。`,
    );
  }

  const services = matchServices(app, options.services || app.services || []);
  if (services.length) {
    score = Math.min(score, 58);
    addReason(
      reasons,
      'warn',
      'windows-service',
      '安装为 Windows 服务',
      `检测到服务：${services.slice(0, 3).map((s) => s.Name || s.name).join('、')}。Wine 不会运行 Windows 服务；如果主界面依赖它，部分功能可能不可用，但通常可以先尝试。`,
    );
  }

  if (dirRisks.truncated) {
    addReason(
      reasons,
      'info',
      'scan-truncated',
      '依赖扫描已截断',
      `仅检查了前 ${dirRisks.files} 个文件；超大目录可能仍隐藏驱动或反作弊组件。`,
    );
  }

  const grade = blocked ? 'D' : score >= 88 ? 'A' : score >= 72 ? 'B' : score >= 48 ? 'C' : 'D';
  const gameLikely = dependencies.directx.length > 0 || dependencies.vulkan || dependencies.input;
  let recommendedEngine = 'wine';
  let engineReason = '开源 Wine（Staging/CrossOver 引擎）足以运行大多数常规 Win32 应用。';
  if (blocked) {
    recommendedEngine = 'vm';
    engineReason = 'Wine 存在硬性限制。可考虑 UTM/Parallels 运行 Windows 虚拟机，或寻找官方 Mac 版。';
  } else if (dependencies.directx.length || dependencies.vulkan) {
    recommendedEngine = 'gptk';
    engineReason = '图形负载建议在 Mac 上使用 Apple GPTK 2 或 CrossOver 24+ 的 D3DMetal 后端。';
  } else if (dependencies.dotnetFramework) {
    recommendedEngine = 'wine';
    engineReason = '使用 Wine + Wine Mono；若启动失败，可在 Mac 上用 winetricks 安装 dotnet48。';
  }

  const summaryBits = [];
  if (pe?.ok) summaryBits.push(pe.machineLabel);
  if (dependencies.dotnetFramework) summaryBits.push('.NET Framework');
  else if (dependencies.dotnetCore) summaryBits.push('.NET');
  if (dependencies.directx.length) summaryBits.push(dependencies.directx.join(' / '));
  if (!summaryBits.length) summaryBits.push('常规 Win32');

  const severityOrder = { block: 0, warn: 1, info: 2, ok: 3 };
  reasons.sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity]);

  return {
    grade,
    gradeLabel: GRADE_LABELS[grade].label,
    gradeTone: GRADE_LABELS[grade].tone,
    gradeSummary: GRADE_LABELS[grade].summary,
    score: Math.max(0, Math.min(100, score)),
    blocked,
    gameLikely,
    reasonSummary: summaryBits.join(' · '),
    reasons,
    dependencies,
    pe,
    directory: {
      scannedFiles: dirRisks.files,
      scannedBytes: dirRisks.bytes,
      truncated: dirRisks.truncated,
      antiCheatHits: dirRisks.antiCheatHits,
      kernelDrivers: dirRisks.kernelDrivers,
      drmHits: dirRisks.drmHits,
      usbHits: dirRisks.usbHits,
      warnings: dirRisks.warnings.slice(0, 20),
    },
    services: services.map((s) => ({
      name: s.Name || s.name,
      displayName: s.DisplayName || s.displayName,
      state: s.State || s.state,
    })),
    recommendedEngine,
    engineReason,
    analyzedAt: new Date().toISOString(),
    estimatedPayloadLabel: dirRisks.bytes ? formatBytes(dirRisks.bytes) : null,
  };
}

module.exports = { analyzeApp, scanDirectoryRisks, GRADE_LABELS };
