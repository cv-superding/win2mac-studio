(() => {
  const listeners = { scan: [], archive: [], build: [], complete: [], error: [], icons: [], window: [] };
  const emit = (key, payload) => listeners[key].forEach((callback) => callback(payload));
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  function analysisFor({ arch = 'x64', score = 90, dotnet = false, dotnetCore = false, webview2 = false, dx = [], openGL = false, vulkan = false, antiCheat = false, kernel = false, drm = false, game = false, services = [], custom = [] }) {
    let finalScore = score;
    const reasons = [];
    const add = (severity, title, detail) => reasons.push({ severity, title, detail });
    if (arch === 'x86') {
      finalScore -= 8;
      add('warn', '32 位 x86 程序', '需要 Wine 的 WoW64 支持；建议 CrossOver 24+ 或 Wine 9+。');
    } else if (arch === 'arm64') {
      finalScore = 12;
      add('block', 'Windows ARM64 程序', 'Wine 无法可靠运行 Windows ARM64 二进制，需要虚拟机或原生移植。');
    } else {
      add('ok', '64 位 Win32 程序', '可通过 Wine 以 64 位 Windows 环境运行。');
    }
    add('info', '图形界面程序', '将作为普通 macOS 应用启动，支持 Retina 与窗口管理。');
    if (dotnet) {
      finalScore -= 22;
      add('warn', '依赖 .NET Framework', '需要 Wine Mono 或 winetricks dotnet48；复杂 WinForms/WPF 界面可能需要额外字体配置。');
    }
    if (dotnetCore) {
      finalScore -= 7;
      add('warn', '依赖 .NET / .NET Core', '自包含应用通常可运行；框架依赖型需要目标机安装对应运行时。');
    }
    if (webview2) {
      finalScore -= 18;
      add('warn', '依赖 WebView2', 'Wine 对 Edge WebView2 支持有限，内嵌浏览器区域可能空白或崩溃。');
    }
    if (dx.includes('DirectX 12')) {
      finalScore -= 22;
      add('warn', '依赖 DirectX 12', '建议在 Mac 上使用 Apple GPTK 2 或 CrossOver 24+ 的 D3DMetal。');
    } else if (dx.length) {
      finalScore -= 8;
      add('warn', `依赖 ${dx.join(' / ')}`, '建议使用 D3DMetal 或 CrossOver；普通 Wine 需要额外的图形翻译层。');
    }
    if (openGL) add('info', '使用 OpenGL', '通过 macOS OpenGL 兼容层运行，复杂渲染可能受限。');
    if (vulkan) {
      finalScore -= 8;
      add('warn', '使用 Vulkan', '需要 MoltenVK，配置与性能因机器而异。');
    }
    if (antiCheat) {
      finalScore = Math.min(finalScore, 18);
      add('block', '检测到反作弊组件', '多数反作弊会拒绝 Wine 或禁止联机，只能用虚拟机，且存在封号风险。');
    }
    if (kernel) {
      finalScore = Math.min(finalScore, 15);
      add('block', '包含 Windows 内核驱动', 'Wine 无法加载 .sys 内核驱动，程序大概率无法启动。');
    }
    if (drm) {
      finalScore = Math.min(finalScore, 28);
      add('block', '检测到 DRM / 激活组件', 'DRM 服务通常无法在 Wine 中验证，需要官方 Mac 版或虚拟机。');
    }
    for (const item of custom) {
      finalScore += item.delta || 0;
      add(item.severity || 'warn', item.title, item.detail);
    }
    add('info', '依赖 Visual C++ 运行库', '打包时会附带微软 VC++ Redistributable，首次运行时自动安装。');
    const blocked = reasons.some((reason) => reason.severity === 'block');
    finalScore = Math.max(0, Math.min(100, finalScore));
    const grade = blocked ? 'D' : finalScore >= 88 ? 'A' : finalScore >= 72 ? 'B' : finalScore >= 48 ? 'C' : 'D';
    const meta = {
      A: ['可直接运行', 'green', '常规 Win32 程序，Wine 兼容性高'],
      B: ['通常可运行', 'blue', '可能需要少量运行时或图形配置'],
      C: ['需要调校', 'amber', '依赖较多，建议 CrossOver/GPTK 并准备排障'],
      D: ['不建议直接运行', 'red', '存在内核/反作弊/DRM 等硬性障碍'],
    }[grade];
    const severityOrder = { block: 0, warn: 1, info: 2, ok: 3 };
    reasons.sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity]);
    const summary = [arch === 'x64' ? '64 位 x64' : arch === 'x86' ? '32 位 x86' : 'ARM64', dotnet ? '.NET Framework' : dotnetCore ? '.NET' : '', ...dx].filter(Boolean).join(' · ');
    return {
      grade,
      gradeLabel: meta[0],
      gradeTone: meta[1],
      gradeSummary: meta[2],
      score: finalScore,
      blocked,
      gameLikely: game,
      reasonSummary: summary || '常规 Win32',
      reasons,
      dependencies: {
        vcrun: true,
        dotnetFramework: dotnet,
        dotnetCore,
        webview2,
        directx: dx,
        openGL,
        vulkan,
        input: game,
        audio: game,
        kernel,
        antiCheat,
        drm,
      },
      pe: { arch, bits: arch === 'x86' ? 32 : 64, subsystem: 'gui', machineLabel: arch === 'x64' ? '64 位 x64' : arch === 'x86' ? '32 位 x86' : '64 位 ARM64', isDotNet: dotnet || dotnetCore },
      recommendedEngine: blocked ? 'vm' : dx.length || vulkan || game ? 'gptk' : 'wine',
      engineReason: blocked
        ? 'Wine 存在硬性限制。可考虑 UTM/Parallels 运行 Windows 虚拟机，或寻找官方 Mac 版。'
        : dx.length || vulkan || game
          ? '图形负载建议在 Mac 上使用 Apple GPTK 2 或 CrossOver 24+ 的 D3DMetal 后端。'
          : dotnet
            ? '使用 Wine + Wine Mono；若启动失败，可在 Mac 上用 winetricks 安装 dotnet48。'
            : '开源 Wine（Staging/CrossOver 引擎）足以运行大多数常规 Win32 应用。',
      directory: { scannedFiles: 120 + Math.round(finalScore * 2), scannedBytes: 0, truncated: false, antiCheatHits: [], kernelDrivers: [], drmHits: [], warnings: [] },
      services,
      analyzedAt: new Date().toISOString(),
    };
  }

  const raw = [
    { name: 'Notepad++', publisher: 'Don Ho', version: '8.7.8', path: 'C:\\Program Files\\Notepad++', exe: 'notepad++.exe', size: 5_500_000, score: 97, arch: 'x64' },
    { name: '7-Zip', publisher: 'Igor Pavlov', version: '24.09', path: 'C:\\Program Files\\7-Zip', exe: '7zFM.exe', size: 6_100_000, score: 96, arch: 'x64' },
    { name: 'Audacity', publisher: 'Audacity Team', version: '3.7.1', path: 'C:\\Program Files\\Audacity', exe: 'Audacity.exe', size: 92_000_000, score: 93, arch: 'x64', openGL: true },
    { name: '微信', publisher: '腾讯', version: '4.0.1', path: 'C:\\Program Files\\Tencent\\WeChat', exe: 'WeChat.exe', size: 620_000_000, score: 89, arch: 'x64' },
    { name: '钉钉', publisher: '阿里巴巴', version: '7.6.20', path: 'C:\\Program Files\\DingTalk', exe: 'DingTalk.exe', size: 780_000_000, score: 87, arch: 'x64', dotnetCore: true },
    { name: 'OBS Studio', publisher: 'OBS Project', version: '31.0.2', path: 'C:\\Program Files\\obs-studio', exe: 'bin\\64bit\\obs64.exe', size: 310_000_000, score: 82, arch: 'x64', dx: ['DirectX 11'], openGL: true },
    { name: 'GIMP', publisher: 'The GIMP Team', version: '3.0.0', path: 'C:\\Program Files\\GIMP 3', exe: 'bin\\gimp-3.0.exe', size: 330_000_000, score: 79, arch: 'x64', openGL: true },
    { name: 'Git for Windows', publisher: 'Git Development Community', version: '2.48.1', path: 'C:\\Program Files\\Git', exe: 'git-bash.exe', size: 360_000_000, score: 84, arch: 'x64' },
    { name: 'Steam', publisher: 'Valve Corporation', version: '2.10.91', path: 'C:\\Program Files (x86)\\Steam', exe: 'steam.exe', size: 510_000_000, score: 83, arch: 'x86', dx: ['DirectX 9'], game: true },
    { name: 'Paint.NET', publisher: 'dotPDN LLC', version: '5.1.2', path: 'C:\\Program Files\\paint.net', exe: 'paintdotnet.exe', size: 65_000_000, score: 88, arch: 'x64', dotnet: true },
    { name: 'Microsoft Office 2019', publisher: 'Microsoft Corporation', version: '16.0.10417', path: 'C:\\Program Files\\Microsoft Office', exe: 'root\\Office16\\WINWORD.EXE', size: 2_100_000_000, score: 80, arch: 'x64', dotnet: true, custom: [{ severity: 'warn', title: '依赖 COM / Office 服务', detail: '部分组件、激活与 Outlook 后台服务在 Wine 中不可用。' }] },
    { name: 'Adobe Photoshop 2024', publisher: 'Adobe Inc.', version: '25.9.0', path: 'C:\\Program Files\\Adobe\\Adobe Photoshop 2024', exe: 'Photoshop.exe', size: 3_400_000_000, score: 63, arch: 'x64', dx: ['DirectX 11'], custom: [{ severity: 'warn', title: 'Creative Cloud 授权', detail: '依赖 Adobe 后台服务与 GPU 特性，Wine 下激活和部分滤镜不可用。' }] },
    { name: 'Epic Games Launcher', publisher: 'Epic Games, Inc.', version: '18.1.1', path: 'C:\\Program Files (x86)\\Epic Games\\Launcher', exe: 'Portal\\Binaries\\Win64\\EpicGamesLauncher.exe', size: 1_200_000_000, score: 76, arch: 'x64', dotnet: true, custom: [{ severity: 'warn', title: '启动器可用，游戏另算', detail: '商店与库界面可能可用，但带反作弊的具体游戏仍需逐个评估。' }] },
    { name: 'Figma', publisher: 'Figma, Inc.', version: '124.6.0', path: 'C:\\Users\\Public\\Figma', exe: 'Figma.exe', size: 310_000_000, score: 69, arch: 'x64', webview2: true },
    { name: 'AutoCAD 2024', publisher: 'Autodesk, Inc.', version: '24.3.1', path: 'C:\\Program Files\\Autodesk\\AutoCAD 2024', exe: 'acad.exe', size: 6_000_000_000, score: 43, arch: 'x64', dotnet: true, drm: true, services: [{ name: 'AdskLicensingService', state: 'Running' }], custom: [{ severity: 'block', title: '需要 Autodesk 授权服务', detail: '许可校验依赖 Windows 服务与驱动，Wine 中通常无法完成。' }] },
    { name: 'Apex Legends', publisher: 'Electronic Arts', version: '1.0.0', path: 'D:\\Games\\Apex Legends', exe: 'r5apex.exe', size: 70_000_000_000, score: 12, arch: 'x64', scoreOverride: 12, dx: ['DirectX 12'], antiCheat: true, game: true },
    { name: 'VALORANT', publisher: 'Riot Games', version: '10.04', path: 'D:\\Games\\VALORANT', exe: 'ShooterGame\\Binaries\\Win64\\VALORANT-Win64-Shipping.exe', size: 40_000_000_000, score: 4, arch: 'x64', dx: ['DirectX 11'], antiCheat: true, kernel: true, game: true },
  ];

  const apps = raw.map((item, index) => {
    const flags = { score: item.score, arch: item.arch, dotnet: item.dotnet, dotnetCore: item.dotnetCore, webview2: item.webview2, dx: item.dx || [], openGL: item.openGL, vulkan: item.vulkan, antiCheat: item.antiCheat, kernel: item.kernel, drm: item.drm, game: item.game, services: item.services, custom: item.custom };
    const analysis = analysisFor(flags);
    if (item.scoreOverride) analysis.score = item.scoreOverride;
    return {
      id: `demo-${index}`,
      name: item.name,
      publisher: item.publisher,
      version: item.version,
      installPath: item.path,
      exePath: `${item.path}\\${item.exe}`,
      displayIcon: `${item.path}\\${item.exe}`,
      estimatedSizeBytes: item.size,
      registryKeys: [`HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${item.name}`],
      source: 'registry',
      arch: item.arch,
      archLabel: analysis.pe.machineLabel,
      bits: analysis.pe.bits,
      isDotNet: analysis.pe.isDotNet,
      analysis,
      grade: analysis.grade,
    };
  });

  const initialHistory = [
    { createdAt: new Date(Date.now() - 1000 * 60 * 94).toISOString(), appName: '7-Zip', publisher: 'Igor Pavlov', grade: 'A', zipPath: 'C:\\Users\\你\\Documents\\Win2Mac\\7-Zip-macOS.zip', folderPath: 'C:\\Users\\你\\Documents\\Win2Mac\\7-Zip-macOS', zipSize: 4_800_000, engineMode: 'auto', engineVersion: 'Wine Staging 11.18', fileCount: 42, zipSha256: '4d9c1a7e8b2f0a6c9d3e5f7a1b8c2d4e6f8a0b1c3d5e7f9a2b4c6d8e0f1a3b5c' },
    { createdAt: new Date(Date.now() - 1000 * 60 * 60 * 6).toISOString(), appName: '微信', publisher: '腾讯', grade: 'B', zipPath: 'C:\\Users\\你\\Documents\\Win2Mac\\微信-macOS.zip', folderPath: 'C:\\Users\\你\\Documents\\Win2Mac\\微信-macOS', zipSize: 438_000_000, engineMode: 'bundled', engineVersion: 'Wine Staging 11.18', fileCount: 1864, zipSha256: '9a1c3e5b7d9f2a4c6e8b0d1f3a5c7e9b2d4f6a8c0e1b3d5f7a9c2e4b6d8f0a1c' },
  ];
  const history = [...initialHistory];

  let settings = {
    outputDir: 'C:\\Users\\你\\Documents\\Win2Mac',
    proxy: 'http://127.0.0.1:7897',
    engineMode: 'auto',
    includeRuntimes: true,
    includeUserData: false,
    includeWineMono: true,
  };

  const demoCacheGroups = [
    { key: 'engines', label: 'Wine 引擎缓存', hint: '下载或手动选择的 tar.xz；重新构建内置引擎时复用。', path: 'C:\\Users\\你\\AppData\\Local\\Win2Mac\\engines', kind: 'directory', exists: true, files: 1, bytes: 193_105_336, truncated: false },
    { key: 'runtimes', label: '运行库缓存', hint: 'VC++ 与 Wine Mono 安装包；下次打包无需重新下载。', path: 'C:\\Users\\你\\AppData\\Local\\Win2Mac\\runtimes', kind: 'directory', exists: true, files: 2, bytes: 111_306_752, truncated: false },
    { key: 'staging', label: '临时构建目录', hint: '异常中断遗留的半成品；正常完成后会自动清理。', path: 'C:\\Users\\你\\AppData\\Local\\Temp', kind: 'staging', exists: true, files: 18, bytes: 26_738_688, truncated: false, entries: [] },
  ];

  function demoCacheStats() {
    const groups = demoCacheGroups.map((group) => ({ ...group }));
    return {
      groups,
      totalBytes: groups.reduce((sum, group) => sum + group.bytes, 0),
      totalFiles: groups.reduce((sum, group) => sum + group.files, 0),
      measuredAt: new Date().toISOString(),
    };
  }

  function simulateBuild(payload) {
    const app = payload.app;
    const stages = [
      ['analyze', '正在分析兼容性与运行时依赖…', 3, 700],
      ['payload', '正在原样复制应用文件…', 34, 1200],
      ['registry', '正在导出注册表快照…', 8, 500],
      ['runtime', '正在准备 VC++ 运行库…', 12, 700],
      ['engine', '正在准备 Wine 引擎配置…', 15, 900],
      ['icon', '正在生成 macOS 应用图标…', 10, 600],
      ['zip', '正在压缩 .app 安装包…', 16, 1100],
      ['done', '打包完成', 2, 350],
    ];
    let overall = 0;
    return new Promise((resolve) => {
      (async () => {
        for (const [stage, message, weight, duration] of stages) {
          const start = overall;
          const steps = 8;
          for (let i = 1; i <= steps; i += 1) {
            await wait(duration / steps);
            emit('build', { stage, message, percent: Math.min(100, Math.round(start + (weight * i) / steps)) });
          }
          overall += weight;
          if (stage === 'done') break;
        }
        const base = app.name.replace(/[<>:"/\\|?*]/g, '');
        const zipSize = Math.max(1_800_000, Math.round((app.estimatedSizeBytes || 50_000_000) * 0.64));
        const result = {
          ok: true,
          demo: true,
          baseName: `${base}-macOS`,
          outputDir: payload.outputDir || settings.outputDir,
          folderPath: `${payload.outputDir || settings.outputDir}\\${base}-macOS`,
          appPath: `${payload.outputDir || settings.outputDir}\\${base}-macOS\\${base}.app`,
          zipPath: `${payload.outputDir || settings.outputDir}\\${base}-macOS.zip`,
          zipSize,
          zipSha256: 'b7d4f2a9c1e8b3d5f7a2c4e6b8d0f1a3c5e7b9d2f4a6c8e0b1d3f5a7c9e2b4d6',
          bundleId: `com.win2mac.${base.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.demo`,
          buildId: 'demo-' + Math.random().toString(16).slice(2, 10),
          fileCount: app.analysis?.directory?.scannedFiles || 120,
          payloadBytes: app.estimatedSizeBytes || 50_000_000,
          grade: app.analysis?.grade || 'A',
          engine: { mode: payload.engineMode || 'auto', policy: payload.engineMode === 'bundled' ? 'bundled' : 'auto', version: 'Wine Staging 11.18' },
          runtimes: [{ label: 'Visual C++ 2015–2022 (x64)' }],
          registryCount: 1,
          warnings: [],
          createdAt: new Date().toISOString(),
          prefixPath: `~/Library/Application Support/Win2Mac/prefixes/demo-${base}`,
        };
        history.unshift({ ...result, appName: app.name, publisher: app.publisher, engineMode: payload.engineMode || 'auto', engineVersion: 'Wine Staging 11.18' });
        emit('complete', result);
        resolve(result);
      })();
    });
  }

  const api = {
    isDesktop: false,
    isDemo: true,
    info: async () => ({
      name: 'Win2Mac Studio',
      version: '0.5.3',
      electron: '—',
      node: '—',
      platform: 'win32',
      arch: 'x64',
      isDemo: true,
      maximized: false,
      userData: 'C:\\Users\\你\\AppData\\Roaming\\Win2Mac',
      settings,
      enginePinned: { version: '11.18', name: 'wine-staging-11.18-osx64.tar.xz', size: '184.2 MB' },
    }),
    getSettings: async () => settings,
    setSettings: async (patch) => {
      const next = { ...settings, ...patch };
      if (patch.ai !== undefined) {
        const ai = { ...(settings.ai || {}), ...patch.ai };
        if (patch.ai.clearKey) ai.apiKey = '';
        if (patch.ai.apiKey) ai.apiKey = String(patch.ai.apiKey);
        ai.hasKey = Boolean(ai.apiKey);
        ai.keyHint = ai.hasKey ? `${ai.apiKey.slice(0, 3)}…${ai.apiKey.slice(-4)}` : '';
        delete ai.apiKey;
        next.ai = ai;
      }
      settings = next;
      return settings;
    },
    scanApps: async () => {
      const stages = [
        ['powershell', '正在读取注册表、开始菜单与服务…'],
        ['merge', '正在匹配主程序与快捷方式…'],
        ['done', '已完成演示扫描'],
      ];
      for (const [stage, message] of stages) {
        emit('scan', { stage, message });
        await wait(300);
      }
      setTimeout(() => emit('icons', {}), 50);
      return {
        apps,
        services: [],
        scannedAt: new Date().toISOString(),
        os: { caption: 'Windows 11 家庭版', version: '10.0.26300' },
        computerName: '演示电脑',
        shortcutCount: 48,
        warnings: [],
      };
    },
    analyzeApp: async (app) => {
      await wait(260);
      return app.analysis;
    },
    loadIcons: async () => ({}),
    startBuild: (payload) => simulateBuild(payload),
    pickExe: async () => {
      await wait(300);
      return { app: apps[1], services: [] };
    },
    pickArchive: async () => {
      await wait(500);
      const chosen = apps[1];
      const app = { ...chosen, id: 'demo-archive', name: '压缩包演示应用', source: 'archive', archiveName: 'demo-app.zip' };
      return { app, analysis: chosen.analysis, kind: 'app', archive: { path: 'C:\\Users\\你\\Downloads\\demo-app.zip', name: 'demo-app.zip', extractedPath: 'C:\\Users\\你\\AppData\\Local\\Win2Mac\\imports\\zip-demo', files: 109, bytes: 474339500 } };
    },
    pickInstaller: async () => {
      await wait(300);
      const name = 'Demo Installer App';
      const analysis = analysisFor({ arch: 'x64', score: 92, custom: [{ severity: 'warn', title: '实验性安装器模式', detail: '首次启动会在 Wine 中运行安装程序。' }] });
      analysis.grade = 'C';
      analysis.gradeLabel = '需要调校';
      analysis.gradeTone = 'amber';
      analysis.gradeSummary = '实验性安装器模式：目标程序尚未安装，兼容性未知。';
      analysis.score = 55;
      analysis.blocked = false;
      const app = {
        id: 'demo-installer', name, publisher: '', version: '', installPath: 'C:/Users/你/Downloads',
        exePath: '', displayIcon: '', estimatedSizeBytes: 120_000_000, source: 'installer',
        analysis, fullAnalysis: true, warnings: [],
      };
      return { app, analysis, installer: { path: 'C:/Users/你/Downloads/DemoSetup.exe', name: 'DemoSetup.exe', type: 'exe', args: '', expectedExe: '', size: 120_000_000 }, services: [] };
    },
    pickAppExe: async (app) => {
      await wait(300);
      const chosen = apps[1];
      const exePath = chosen.exePath;
      return {
        app: { ...app, exePath, displayIcon: exePath, workingDirectory: chosen.installPath },
        analysis: app.analysis,
      };
    },
    pickOutput: async () => settings.outputDir,
    pickEngineArchive: async () => null,
    inspectPath: async (target) => {
      await wait(260);
      const lower = String(target || '').toLowerCase();
      if (lower.endsWith('.zip')) return api.pickArchive();
      if (lower.endsWith('.msi') || /(setup|installer|install)/.test(lower)) return api.pickInstaller();
      const chosen = apps.find((item) => lower.includes(item.name.toLowerCase())) || apps[1];
      return {
        app: { ...chosen },
        analysis: chosen.analysis,
        kind: 'app',
        drop: { kind: lower.endsWith('.exe') ? 'file' : 'folder', chosenExe: chosen.exePath },
      };
    },
    exportRecipe: async (payload) => {
      await wait(220);
      const recipe = {
        format: 'win2mac-recipe/v1',
        createdAt: new Date().toISOString(),
        generator: { name: 'Win2Mac Studio', version: '0.5.3' },
        app: { name: payload.app?.name || 'Demo App', publisher: payload.app?.publisher || '', version: payload.app?.version || '', exeName: 'app.exe', source: 'registry' },
        match: { name: payload.app?.name || 'Demo App', publisher: payload.app?.publisher || '', exeName: 'app.exe', bits: 64, size: payload.app?.estimatedSizeBytes || 0 },
        compatibility: { grade: payload.analysis?.grade || 'A', label: payload.analysis?.gradeLabel || '', summary: payload.analysis?.gradeSummary || '', recommendedEngine: 'wine' },
        installer: null,
        options: { ...payload.options },
      };
      return { path: `C:\\Users\\你\\Documents\\${payload.app?.name || 'Demo'}.win2mac.json`, recipe };
    },
    importRecipe: async () => {
      await wait(240);
      const target = apps[1];
      return {
        path: `C:\\Users\\你\\Downloads\\${target.name}.win2mac.json`,
        recipe: {
          format: 'win2mac-recipe/v1',
          createdAt: new Date().toISOString(),
          generator: { name: 'Win2Mac Studio', version: '0.5.3' },
          app: { name: target.name, publisher: target.publisher, version: target.version, exeName: '7zFM.exe', source: 'registry' },
          match: { name: target.name, publisher: target.publisher, exeName: '7zFM.exe', bits: 64, size: target.estimatedSizeBytes },
          compatibility: { grade: 'A', label: '可直接运行', summary: '社区验证配方', recommendedEngine: 'wine' },
          installer: null,
          options: {
            engineMode: 'bundled',
            includeRuntimes: true,
            includeWineMono: true,
            includeUserData: false,
            advanced: { metalHud: false, dxvkHud: false, verifyIntegrity: true, preventSleep: false, wineDebug: 'off', launchArgs: '', envText: 'DXVK_ASYNC=1' },
          },
          notes: '社区移植配方：内置引擎，离线可用。',
        },
      };
    },
    cacheStats: async () => {
      await wait(300);
      return demoCacheStats();
    },
    clearCache: async (keys) => {
      await wait(320);
      let clearedBytes = 0;
      let clearedFiles = 0;
      for (const group of demoCacheGroups) {
        if (keys.includes(group.key)) {
          clearedBytes += group.bytes;
          clearedFiles += group.files;
          group.bytes = 0;
          group.files = 0;
          group.entries = [];
        }
      }
      return { clearedBytes, clearedFiles, stats: demoCacheStats() };
    },
    history: async () => [...history],
    clearHistory: async () => {
      history.length = 0;
      return [];
    },
    openPath: async () => '浏览器演示模式不会创建真实文件。',
    showInFolder: async () => true,
    openExternal: async (url) => {
      window.open(url, '_blank', 'noopener');
      return true;
    },
    diagnostics: async () => ({
      checks: [
        { name: 'Windows PowerShell 5.1', status: 'ok', detail: '演示环境可用' },
        { name: 'curl', status: 'ok', detail: '用于下载引擎与运行时' },
        { name: 'Wine 引擎清单', status: 'ok', detail: 'wine-staging-11.18-osx64.tar.xz（184.2 MB）' },
        { name: '磁盘可用空间', status: 'ok', detail: '数据目录剩余 86.4 GB' },
      ],
      os: 'Windows 11 10.0.26300',
      arch: 'x64',
    }),
    minimize: async () => {},
    toggleMaximize: async () => false,
    close: async () => {},
    onScanProgress: (cb) => {
      listeners.scan.push(cb);
      return () => {
        const i = listeners.scan.indexOf(cb);
        if (i >= 0) listeners.scan.splice(i, 1);
      };
    },
    onArchiveProgress: (cb) => {
      listeners.archive.push(cb);
      return () => {
        const i = listeners.archive.indexOf(cb);
        if (i >= 0) listeners.archive.splice(i, 1);
      };
    },
    onBuildProgress: (cb) => {
      listeners.build.push(cb);
      return () => {
        const i = listeners.build.indexOf(cb);
        if (i >= 0) listeners.build.splice(i, 1);
      };
    },
    onBuildComplete: (cb) => {
      listeners.complete.push(cb);
      return () => {
        const i = listeners.complete.indexOf(cb);
        if (i >= 0) listeners.complete.splice(i, 1);
      };
    },
    onBuildError: (cb) => {
      listeners.error.push(cb);
      return () => {
        const i = listeners.error.indexOf(cb);
        if (i >= 0) listeners.error.splice(i, 1);
      };
    },
    onIcons: (cb) => {
      listeners.icons.push(cb);
      return () => {
        const i = listeners.icons.indexOf(cb);
        if (i >= 0) listeners.icons.splice(i, 1);
      };
    },
    onWindowState: (cb) => {
      listeners.window.push(cb);
      return () => {
        const i = listeners.window.indexOf(cb);
        if (i >= 0) listeners.window.splice(i, 1);
      };
    },
  };

  window.createDemoApi = () => api;
  window.__win2macDemoApps = apps;
})();
