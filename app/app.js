'use strict';

(() => {
  const api = window.win2mac || (window.createDemoApi ? window.createDemoApi() : null);
  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const view = $('#view');
  const drawerRoot = $('#drawer-root');
  const modalRoot = $('#modal-root');
  const toastRoot = $('#toast-root');

  if (!api) {
    view.innerHTML = '<div class="page"><div class="empty-state"><h3>无法启动界面</h3><p>预加载桥接失败，请重新启动 Win2Mac Studio。</p></div></div>';
    return;
  }

  const PAGE_META = {
    library: { title: '应用库', subtitle: '检测、评估并打包 Windows 应用' },
    tasks: { title: '转换任务', subtitle: '本机生成的 .app 与完整性记录' },
    compat: { title: '兼容性', subtitle: 'Wine 能力边界与分级说明' },
    settings: { title: '设置', subtitle: '默认引擎、运行时与输出位置' },
  };
  const GRADE_TONE = { A: 'green', B: 'blue', C: 'amber', D: 'red' };
  const GRADE_LABEL = { A: '可直接运行', B: '通常可运行', C: '需要调校', D: '不建议运行' };
  const TONE_COLOR = { green: '#1f7a4d', blue: '#2860c9', amber: '#9a6206', red: '#b42318' };
  const ENGINE_LABEL = { wine: 'Wine', gptk: 'Apple GPTK / CrossOver', vm: 'Windows 虚拟机', none: '原生 Mac 版本' };
  const STAGE_DEFS = [
    ['analyze', '分析应用与依赖'],
    ['payload', '原样复制应用文件'],
    ['registry', '导出注册表快照'],
    ['userdata', '复制用户数据（可选）'],
    ['runtime', '准备运行时组件'],
    ['engine', '准备 Wine 引擎'],
    ['icon', '生成 macOS 图标'],
    ['zip', '压缩 .app 安装包'],
  ];
  const STAGE_RANGE = {
    start: [0, 0],
    analyze: [0, 2],
    analyzed: [2, 3],
    enumerate: [3, 5],
    payload: [5, 55],
    registry: [55, 61],
    userdata: [61, 64],
    runtime: [64, 78],
    assemble: [64, 92],
    engine: [78, 89],
    icon: [89, 92],
    zip: [92, 99],
    done: [100, 100],
  };
  const STAGE_ALIAS = {
    start: 'analyze',
    analyze: 'analyze',
    analyzed: 'analyze',
    enumerate: 'payload',
    payload: 'payload',
    registry: 'registry',
    userdata: 'userdata',
    runtime: 'runtime',
    assemble: 'payload',
    engine: 'engine',
    icon: 'icon',
    zip: 'zip',
    done: 'zip',
  };

  const state = {
    page: 'library',
    info: null,
    settings: null,
    history: [],
    apps: [],
    services: [],
    icons: {},
    scannedAt: null,
    scanning: false,
    scanProgress: null,
    scanError: null,
    analysisProgress: null,
    analysisGeneration: 0,
    filters: { query: '', grade: 'all', sort: 'name' },
    selectedId: null,
    analysisRefreshing: false,
    build: null,
    batchMode: false,
    batchSelected: new Set(),
    batch: null,
    pendingRecipe: null,
    archiveProgress: null,
    cacheStats: null,
    cacheLoading: false,
    cacheError: null,
    demo: Boolean(api.isDemo),
  };

  let toastCounter = 0;
  let proxySaveTimer = null;

  function esc(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function fmtBytes(bytes) {
    const n = Number(bytes) || 0;
    if (n <= 0) return '—';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.min(Math.floor(Math.log(n) / Math.log(1024)), units.length - 1);
    const value = n / 1024 ** i;
    return `${value >= 10 || i === 0 ? Math.round(value) : value.toFixed(1)} ${units[i]}`;
  }

  function timeAgo(iso) {
    if (!iso) return '尚未扫描';
    const diff = Date.now() - new Date(iso).getTime();
    if (!Number.isFinite(diff)) return '刚刚';
    const minute = 60 * 1000;
    if (diff < minute) return '刚刚';
    if (diff < 60 * minute) return `${Math.floor(diff / minute)} 分钟前`;
    if (diff < 24 * 60 * minute) return `${Math.floor(diff / (60 * minute))} 小时前`;
    return new Date(iso).toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' });
  }

  function fmtDate(iso) {
    if (!iso) return '—';
    return new Date(iso).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
  }

  function initials(name) {
    const text = String(name || '?').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
    const first = text.split(/\s+/)[0] || '?';
    const chars = [...first];
    if (/^[\u4e00-\u9fff]/.test(first)) return chars.slice(0, 2).join('');
    return chars.slice(0, 2).join('').toUpperCase();
  }

  function gradientIndex(id) {
    let hash = 0;
    for (const char of String(id)) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
    return hash % 6;
  }

  function iconHtml(app, extraClass = '') {
    const icon = state.icons[app.id]?.dataUrl;
    if (icon) {
      return `<span class="app-icon has-image ${extraClass}" data-icon-id="${esc(app.id)}"><img src="${esc(icon)}" alt=""></span>`;
    }
    return `<span class="app-icon grad-${gradientIndex(app.id)} ${extraClass}" data-icon-id="${esc(app.id)}">${esc(initials(app.name))}</span>`;
  }

  function gradeOf(app) {
    return app.analysis?.grade || null;
  }

  function gradeBadge(app, compact = false) {
    const grade = gradeOf(app);
    if (!grade) {
      if (app.analysisError) {
        return `<span class="grade error" title="${esc(app.analysisError)}"><i></i>分析失败</span>`;
      }
      return `<span class="grade neutral"><i></i>评估中</span>`;
    }
    const tone = GRADE_TONE[grade] || 'neutral';
    const title = app.analysis ? `${app.analysis.gradeSummary || ''}${app.fullAnalysis ? '' : '（快速评估，打开详情做深度检查）'}` : '';
    return `<span class="grade ${tone}" title="${esc(title)}"><i></i>${grade}${compact ? '' : ` · ${GRADE_LABEL[grade]}`}</span>`;
  }

  function stats() {
    const analyzed = state.apps.filter((item) => item.analysis);
    const count = (grades) => analyzed.filter((item) => grades.includes(item.analysis.grade)).length;
    return {
      total: state.apps.length,
      analyzed: analyzed.length,
      pending: Math.max(0, state.apps.length - analyzed.length),
      good: count(['A', 'B']),
      tune: count(['C']),
      risk: count(['D']),
    };
  }

  function filteredApps() {
    const query = state.filters.query.trim().toLowerCase();
    let list = state.apps.filter((app) => {
      if (query) {
        const haystack = `${app.name} ${app.publisher} ${app.installPath} ${app.exePath}`.toLowerCase();
        if (!haystack.includes(query)) return false;
      }
      const grade = gradeOf(app);
      if (state.filters.grade === 'good') return grade === 'A' || grade === 'B';
      if (state.filters.grade === 'tune') return grade === 'C';
      if (state.filters.grade === 'risk') return grade === 'D';
      return true;
    });
    const rank = { A: 0, B: 1, C: 2, D: 3 };
    if (state.filters.sort === 'grade') {
      list = [...list].sort((a, b) => (rank[gradeOf(a)] ?? 9) - (rank[gradeOf(b)] ?? 9) || a.name.localeCompare(b.name, 'zh-CN'));
    } else if (state.filters.sort === 'size') {
      list = [...list].sort((a, b) => (b.estimatedSizeBytes || 0) - (a.estimatedSizeBytes || 0));
    } else {
      list = [...list].sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
    }
    return list;
  }

  function appRowHtml(app) {
    const metadata = [app.publisher, app.version ? `v${app.version}` : ''].filter(Boolean).join(' · ') || '未提供发布信息';
    const path = app.installPath || app.exePath || '';
    const size = app.estimatedSizeBytes || app.analysis?.directory?.scannedBytes || 0;
    const selected = state.batchMode && state.batchSelected.has(app.id);
    const canConvert = Boolean(app.exePath && app.analysis);
    return `
      <div class="app-row ${selected ? 'selected' : ''}" role="button" tabindex="0" data-app-id="${esc(app.id)}" data-app-row="${esc(app.id)}" aria-label="${state.batchMode ? '选择' : '查看'} ${esc(app.name)}">
        <div class="app-main">
          ${state.batchMode ? `<span class="row-check ${selected ? 'on' : ''}">${selected ? '<svg class="icon"><use href="#i-check"></use></svg>' : ''}</span>` : ''}
          ${iconHtml(app)}
          <div class="app-text">
            <div class="app-name">${esc(app.name)}</div>
            <div class="app-meta">${esc(metadata)}</div>
          </div>
        </div>
        <div class="app-source">
          <span class="path" title="${esc(path)}">${esc(path)}</span>
          <span>${app.source === 'shortcut' ? '开始菜单快捷方式' : app.source === 'manual' ? '手动选择' : app.source === 'archive' ? '压缩包导入' : '已安装应用'}${app.bits ? ` · ${app.bits} 位` : ''}</span>
        </div>
        <span class="arch-chip">${esc(app.arch === 'x64' ? 'x64' : app.arch === 'x86' ? 'x86' : app.arch === 'arm64' ? 'ARM64' : '—')}</span>
        <span class="size-cell">${fmtBytes(size)}</span>
        ${gradeBadge(app)}
        <span class="row-actions">
          ${state.batchMode
            ? '<span class="row-chevron"><svg class="icon"><use href="#i-chevron"></use></svg></span>'
            : `<button class="row-convert" data-action="convert-app" data-convert-id="${esc(app.id)}" aria-label="转换 ${esc(app.name)}" title="${canConvert ? '一键转换为 .app' : '等待兼容性分析完成'}" ${canConvert ? '' : 'disabled'}><svg class="icon"><use href="#i-play"></use></svg><span>转换</span></button>`}
        </span>
      </div>`;
  }

  function listHtml() {
    const list = filteredApps();
    if (!state.apps.length) {
      if (state.scanning) {
        return `<div class="list-loading">${Array.from({ length: 6 }, () => `
          <div class="skeleton-row"><span class="skeleton icon-s"></span><div><span class="skeleton line w1"></span><span class="skeleton line w2"></span></div><span class="skeleton line w3"></span></div>`).join('')}</div>`;
      }
      if (state.scanError) return scanErrorHtml();
      return emptyStateHtml();
    }
    if (!list.length) {
      return `<div class="list-empty">没有匹配的应用。<button class="link-btn" data-action="reset-filters">清除筛选</button></div>`;
    }
    return `<div class="list-head"><span>应用</span><span>安装位置</span><span>架构</span><span>体积</span><span>兼容性</span><span>${state.batchMode ? '选择' : '操作'}</span></div>${list.map((app) => appRowHtml(app)).join('')}`;
  }

  function emptyStateHtml() {
    return `
      <div class="empty-state" style="border:0; box-shadow:none; padding:48px 20px;">
        <div class="empty-art"><span class="win-sq"><b></b><b></b><b></b><b></b></span><span class="connect"></span><span class="mac-sq"><span>W</span></span></div>
        <h3>先扫描这台电脑上的 Windows 应用</h3>
        <p>Win2Mac 会读取已安装应用、开始菜单快捷方式与注册表信息，在本机完成兼容性评估。不上传你的应用或数据。</p>
        <div class="empty-actions">
          <button class="btn btn-accent" data-action="scan"><svg class="icon"><use href="#i-search"></use></svg>扫描已安装应用</button>
          <button class="btn btn-ghost" data-action="pick-exe"><svg class="icon"><use href="#i-file"></use></svg>选择 .exe</button>
          <button class="btn btn-ghost" data-action="pick-installer"><svg class="icon"><use href="#i-package"></use></svg>从安装包</button>
          <button class="btn btn-ghost" data-action="pick-archive"><svg class="icon"><use href="#i-download"></use></svg>导入 ZIP</button>
          <button class="btn btn-ghost" data-action="pick-mac-app"><svg class="icon"><use href="#i-package"></use></svg>导入 Mac 应用</button>
        </div>
        <span class="empty-note"><svg class="icon"><use href="#i-lock"></use></svg>本地处理 · 原文件只读 · 不改动 Windows 安装</span>
      </div>`;
  }

  function statsHtml() {
    const s = stats();
    const pendingHint = s.pending ? (state.analysisProgress?.active ? `${s.pending} 个评估中` : `${s.pending} 个待评估`) : '';
    return `
      <div class="stat-card">
        <span class="stat-icon"><svg class="icon"><use href="#i-grid"></use></svg></span>
        <div><div class="stat-value">${state.apps.length ? s.total : '—'}</div><div class="stat-label">已发现应用</div></div>
        <span class="stat-hint">${state.scannedAt ? timeAgo(state.scannedAt) : ''}</span>
      </div>
      <div class="stat-card">
        <span class="stat-icon green"><svg class="icon"><use href="#i-shield"></use></svg></span>
        <div><div class="stat-value">${s.analyzed ? s.good : '—'}</div><div class="stat-label">兼容良好 · A/B</div></div>
        <span class="stat-hint">${pendingHint}</span>
      </div>
      <div class="stat-card">
        <span class="stat-icon amber"><svg class="icon"><use href="#i-alert"></use></svg></span>
        <div><div class="stat-value">${s.analyzed ? s.tune : '—'}</div><div class="stat-label">需要调校 · C</div></div>
        <span class="stat-hint">${s.analyzed ? '建议 GPTK' : ''}</span>
      </div>
      <div class="stat-card">
        <span class="stat-icon blue"><svg class="icon"><use href="#i-cpu"></use></svg></span>
        <div><div class="stat-value">${s.analyzed ? s.risk : '—'}</div><div class="stat-label">高风险 · D</div></div>
        <span class="stat-hint">${s.analyzed ? 'Wine 受限' : ''}</span>
      </div>`;
  }

  function scanErrorHtml() {
    return `<div class="empty-state error-state" style="border:0;box-shadow:none;padding:48px 20px;">
      <div class="error-art"><svg class="icon"><use href="#i-alert"></use></svg></div>
      <h3>扫描没有完成</h3>
      <p>${esc(state.scanError)}</p>
      <div class="empty-actions">
        <button class="btn btn-primary" data-action="scan"><svg class="icon"><use href="#i-refresh"></use></svg>重试扫描</button>
        <button class="btn btn-ghost" data-action="pick-exe"><svg class="icon"><use href="#i-file"></use></svg>手动选择 .exe</button>
      </div>
    </div>`;
  }

  function scanBannerHtml() {
    if (state.archiveProgress) {
      const progress = state.archiveProgress;
      const files = Number(progress.files) || 0;
      return `<div class="scan-banner"><span class="spinner"></span><div><strong>正在导入压缩包</strong><br><span>${esc(progress.message || '正在解压…')}${files ? ` · 已解压 ${files.toLocaleString('zh-CN')} 个文件` : ''}</span></div></div>`;
    }
    if (state.scanning) {
      const message = state.scanProgress?.message || '正在读取注册表与开始菜单…';
      return `<div class="scan-banner"><span class="spinner"></span><div><strong>正在扫描本机应用</strong><br><span>${esc(message)}</span></div><span class="bar"><i></i></span></div>`;
    }
    if (state.scanError && state.apps.length) {
      return `<div class="scan-banner error-banner"><span class="banner-icon"><svg class="icon"><use href="#i-alert"></use></svg></span><div><strong>最近一次扫描失败</strong><br><span>${esc(state.scanError)}</span></div><button class="btn btn-soft btn-sm" data-action="scan">重试</button></div>`;
    }
    if (state.analysisProgress?.active) {
      const { done, total } = state.analysisProgress;
      return `<div class="scan-banner"><span class="spinner"></span><div><strong>正在后台评估兼容性</strong><br><span>已分析 ${done} / ${total} 个应用，列表会实时更新。</span></div></div>`;
    }
    return '';
  }

  function renderLibrary() {
    const active = state.filters.grade;
    const sort = state.filters.sort;
    view.innerHTML = `
      <div class="page">
        <section class="library-hero">
          <div class="hero-copy">
            <div class="eyebrow">Windows → macOS</div>
            <h1>把 Windows 应用，<br>装进一个 <span class="accent">.app</span>。</h1>
            <p>原文件逐字节保留，自动生成 macOS 应用包与 Wine 运行环境。先看清兼容性，再一次完成转换。</p>
            <div class="hero-actions">
              <button class="btn btn-accent btn-lg" data-action="scan" ${state.scanning ? 'disabled' : ''}>
                <svg class="icon"><use href="#i-${state.scanning ? 'refresh' : 'search'}"></use></svg>${state.scanning ? '扫描中…' : state.apps.length ? '重新扫描应用' : '扫描已安装应用'}
              </button>
              <button class="btn btn-ghost btn-lg" data-action="pick-exe"><svg class="icon"><use href="#i-file"></use></svg>选择 .exe 文件</button>
              <button class="btn btn-ghost btn-lg" data-action="pick-installer"><svg class="icon"><use href="#i-package"></use></svg>从安装包创建</button>
            </div>
            <div class="hero-note"><svg class="icon"><use href="#i-lock"></use></svg>不上传应用 · 不修改原安装 · 产物在本机生成</div>
          </div>
          <div class="hero-stage" aria-hidden="true">
            <div class="stage-win">
              <div class="stage-bar"><i></i><i></i><i></i><span>WIN32 · X64</span></div>
              <div class="stage-tiles"><b></b><b></b><b></b><b></b></div>
              <div class="stage-caption"><span>MyApp.exe</span><span>NATIVE PAYLOAD</span></div>
            </div>
            <span class="stage-transfer"><svg class="icon"><use href="#i-arrow-right"></use></svg>WINDOWS → MAC</span>
            <div class="stage-mac">
              <div class="stage-bar"><i></i><i></i><i></i><span>.APP BUNDLE</span></div>
              <div class="mac-app-row">
                <span class="mac-icon">W</span>
                <div><div class="mac-name">MyApp</div><div class="mac-sub">macOS Application</div></div>
                <span class="mac-tag">WINE</span>
              </div>
            </div>
            <span class="stage-chip one">SHA-256 VERIFIED</span>
            <span class="stage-chip two">Wine 11.18</span>
          </div>
        </section>

        <section class="stats" id="stats-region">${statsHtml()}</section>

        <div class="list-toolbar">
          <div class="segmented" role="tablist" aria-label="兼容性筛选">
            <button data-filter-grade="all" class="${active === 'all' ? 'active' : ''}">全部</button>
            <button data-filter-grade="good" class="${active === 'good' ? 'active' : ''}">兼容良好</button>
            <button data-filter-grade="tune" class="${active === 'tune' ? 'active' : ''}">需调校</button>
            <button data-filter-grade="risk" class="${active === 'risk' ? 'active' : ''}">高风险</button>
          </div>
          <div class="spacer"></div>
          <span class="result-count" id="result-count">${filteredApps().length} 个结果</span>
          <span class="select-wrap">
            <select id="sort-select" aria-label="排序方式">
              <option value="name" ${sort === 'name' ? 'selected' : ''}>按名称</option>
              <option value="grade" ${sort === 'grade' ? 'selected' : ''}>按兼容性</option>
              <option value="size" ${sort === 'size' ? 'selected' : ''}>按体积</option>
            </select>
            <svg class="icon"><use href="#i-chevron-down"></use></svg>
          </span>
          <button class="btn btn-ghost btn-sm" data-action="pick-installer"><svg class="icon"><use href="#i-package"></use></svg>安装包</button>
          <button class="btn btn-ghost btn-sm" data-action="pick-archive"><svg class="icon"><use href="#i-download"></use></svg>导入 ZIP</button>
          <button class="btn btn-ghost btn-sm" data-action="pick-mac-app"><svg class="icon"><use href="#i-package"></use></svg>导入 Mac 应用</button>
          <button class="btn btn-ghost btn-sm" data-action="import-recipe"><svg class="icon"><use href="#i-download"></use></svg>导入配方</button>
          <button class="btn btn-ghost btn-sm ${state.batchMode ? 'is-active' : ''}" data-action="toggle-batch"><svg class="icon"><use href="#i-layers"></use></svg>批量</button>
        </div>
        ${state.pendingRecipe ? `<div class="recipe-banner">
          <span class="recipe-banner-icon"><svg class="icon"><use href="#i-file"></use></svg></span>
          <div><b>已导入配方「${esc(state.pendingRecipe.app?.name || state.pendingRecipe.match?.name || '未命名')}」</b><span>选择应用并打开打包窗口，引擎、运行库与高级选项会自动带入。</span></div>
          <button class="btn btn-ghost btn-sm" data-action="clear-pending-recipe">取消</button>
        </div>` : ''}
        ${state.batchMode ? `<div class="batch-bar" id="batch-bar">
          <div class="batch-bar-info"><span class="batch-check-icon"><svg class="icon"><use href="#i-check"></use></svg></span><b id="batch-count">${state.batchSelected.size}</b> 个已选 <span>使用设置页的引擎与运行库默认值</span></div>
          <div class="batch-bar-actions">
            <button class="btn btn-ghost btn-sm" data-action="batch-select-all">全选当前</button>
            <button class="btn btn-ghost btn-sm" data-action="batch-exit">退出批量</button>
            <button class="btn btn-accent btn-sm" data-action="batch-start" ${state.batchSelected.size ? '' : 'disabled'}>开始批量转换</button>
          </div>
        </div>` : ''}
        <div id="scan-banner-region">${scanBannerHtml()}</div>
        <div class="app-list" id="app-list">${listHtml()}</div>
      </div>`;
  }

  function updateList() {
    const list = $('#app-list');
    if (!list) return;
    list.innerHTML = listHtml();
    const count = $('#result-count');
    if (count) count.textContent = `${filteredApps().length} 个结果`;
    const statsRegion = $('#stats-region');
    if (statsRegion) statsRegion.innerHTML = statsHtml();
  }

  function updateStats() {
    const region = $('#stats-region');
    if (region) region.innerHTML = statsHtml();
  }

  function updateScanBanner() {
    const region = $('#scan-banner-region');
    if (region) region.innerHTML = scanBannerHtml();
  }

  function updateAppRow(app) {
    const row = document.querySelector(`[data-app-row="${CSS.escape(app.id)}"]`);
    if (row) {
      row.outerHTML = appRowHtml(app);
    } else if (state.page === 'library') {
      updateList();
    }
  }

  function selectApp(id) {
    const app = state.apps.find((item) => item.id === id);
    if (!app) return;
    state.selectedId = id;
    state.analysisRefreshing = false;
    renderDrawer();
    loadFullAnalysis(app);
  }

  function syncOverlayLock() {
    const open = Boolean(state.selectedId || state.build?.open || state.batch);
    document.body.classList.toggle('overlay-open', open);
    const frame = $('.frame');
    if (frame) frame.inert = open;
    if (drawerRoot) drawerRoot.inert = Boolean(state.build?.open);
  }

  function closeDrawer() {
    const lastId = state.selectedId;
    state.selectedId = null;
    state.analysisRefreshing = false;
    drawerRoot.innerHTML = '';
    syncOverlayLock();
    if (lastId) {
      requestAnimationFrame(() => {
        document.querySelector(`[data-app-row="${CSS.escape(lastId)}"]`)?.focus();
      });
    }
  }

  async function loadFullAnalysis(app, force = false) {
    if (state.demo) {
      app.fullAnalysis = true;
      delete app.analysisError;
      return;
    }
    if (app.fullAnalysis && !force) return;
    const current = app;
    const targetExe = current.exePath;
    state.analysisRefreshing = true;
    delete current.analysisError;
    renderDrawer();
    try {
      const analysis = await api.analyzeApp(current, state.services, false);
      if (state.selectedId !== current.id || current.exePath !== targetExe) return;
      current.analysis = analysis;
      current.grade = analysis.grade;
      current.fullAnalysis = true;
      delete current.analysisError;
      state.analysisRefreshing = false;
      updateStats();
      if (state.filters.sort === 'grade' || state.filters.grade !== 'all') updateList();
      else updateAppRow(current);
      renderDrawer();
    } catch (error) {
      if (state.selectedId !== current.id || current.exePath !== targetExe) return;
      state.analysisRefreshing = false;
      current.analysisError = error.message;
      renderDrawer();
      updateAppRow(current);
      toast(`深度分析失败：${error.message}`, 'warn');
    }
  }

  async function reselectExe() {
    const app = state.apps.find((item) => item.id === state.selectedId);
    if (!app) return;
    if (!api.pickAppExe) {
      toast('当前环境不支持重新指定主程序', 'warn');
      return;
    }
    try {
      toast('请选择应用目录内的主程序…', 'info');
      const result = await api.pickAppExe(app, state.services);
      if (!result?.app) return;
      Object.assign(app, result.app, { id: app.id });
      delete state.icons[app.id];
      app.analysisError = null;
      app.fullAnalysis = true;
      state.selectedId = app.id;
      state.analysisRefreshing = false;
      updateStats();
      if (state.page === 'library') {
        if (state.filters.sort === 'grade' || state.filters.grade !== 'all') updateList();
        else updateAppRow(app);
      }
      renderDrawer();
      try {
        const icons = await api.loadIcons([app]);
        if (icons?.[app.id]) {
          state.icons[app.id] = icons[app.id];
          renderDrawer();
        }
      } catch {
        /* icon refresh is best-effort */
      }
      toast('主程序已更新并重新分析');
    } catch (error) {
      toast(error.message, 'error');
    }
  }

  function renderDrawer() {
    const app = state.apps.find((item) => item.id === state.selectedId);
    if (!app) {
      drawerRoot.innerHTML = '';
      syncOverlayLock();
      return;
    }
    const analysis = app.analysis;
    const grade = analysis?.grade;
    const tone = analysis ? GRADE_TONE[grade] : 'green';
    const score = analysis?.score ?? 0;
    const loading = !analysis;
    const reasons = analysis?.reasons || [];
    const deps = analysis?.dependencies || {};
    const depItems = [];
    if (deps.vcrun) depItems.push(['VC++ 运行库', '首次安装']);
    if (deps.dotnetFramework) depItems.push(['.NET Framework', '需 Mono']);
    if (deps.dotnetCore) depItems.push(['.NET / Core', '自包含优先']);
    if (deps.webview2) depItems.push(['WebView2', '受限']);
    if (deps.directx?.length) depItems.push([deps.directx.join(' / '), '图形']);
    if (deps.openGL) depItems.push(['OpenGL', '兼容层']);
    if (deps.vulkan) depItems.push(['Vulkan', '需 MoltenVK']);
    if (deps.antiCheat) depItems.push(['反作弊', '阻断']);
    if (deps.kernel) depItems.push(['内核驱动', '阻断']);
    if (deps.drm) depItems.push(['DRM / 激活', '阻断']);
    if (!depItems.length) depItems.push(['特殊依赖', '未检测到']);
    const engine = analysis?.recommendedEngine || 'wine';
    const blocked = analysis?.blocked || grade === 'D';
    const sourceNote = app.source === 'shortcut' ? '开始菜单快捷方式' : app.source === 'manual' ? '手动选择' : app.source === 'archive' ? '压缩包导入' : '注册表';
    drawerRoot.innerHTML = `
      <div class="scrim" data-action="close-drawer"></div>
      <aside class="drawer" role="dialog" aria-modal="true" aria-labelledby="drawer-title" tabindex="-1">
        <div class="drawer-head">
          ${iconHtml(app)}
          <div class="drawer-title">
            <h3 id="drawer-title">${esc(app.name)}</h3>
            <p>${esc([app.publisher, app.version ? `v${app.version}` : '', sourceNote].filter(Boolean).join(' · '))}</p>
          </div>
          <button class="drawer-close" data-action="close-drawer" aria-label="关闭详情"><svg class="icon"><use href="#i-close"></use></svg></button>
        </div>
        <div class="drawer-body">
          ${loading ? `
            <div class="drawer-loading">
              <div class="skeleton" style="height:90px;border-radius:14px;"></div>
              <div class="skeleton line"></div><div class="skeleton line short"></div>
              <div class="skeleton" style="height:120px;border-radius:12px;margin-top:10px;"></div>
            </div>${app.analysisError ? `<div class="warning-inline error-inline"><svg class="icon"><use href="#i-alert"></use></svg><span>分析失败：${esc(app.analysisError)} <button class="link-btn" data-action="retry-analysis">重试</button></span></div>` : ''}` : `
            <div class="grade-panel">
              <div class="score-ring" style="--score:${score};--tone:${TONE_COLOR[tone] || '#1f7a4d'}"><b>${score}</b></div>
              <div>
                <div class="score-label">${esc(GRADE_LABEL[grade] || GRADE_LABEL.A)} · ${esc(analysis.reasonSummary || '')}</div>
                <div class="score-sub">${esc(analysis.gradeSummary || '')}</div>
              </div>
              <span class="score-pill">${gradeBadge(app, true)}</span>
            </div>
            ${state.analysisRefreshing ? '<div class="warning-inline"><svg class="icon"><use href="#i-refresh"></use></svg><span>正在执行深度目录检查，评估结果会实时更新。</span></div>' : ''}
            ${app.analysisError ? `<div class="warning-inline error-inline"><svg class="icon"><use href="#i-alert"></use></svg><span>深度分析失败：${esc(app.analysisError)} <button class="link-btn" data-action="retry-analysis">重试</button></span></div>` : ''}
            ${blocked ? '<div class="warning-inline"><svg class="icon"><use href="#i-alert"></use></svg><span>Wine 存在硬性阻断。仍可生成 .app，但建议优先寻找官方 Mac 版或使用 Windows 虚拟机。</span></div>' : ''}
            <div class="section-title">兼容性明细</div>
            <div class="reason-list">
              ${reasons.map((reason) => `
                <div class="reason ${reason.severity === 'block' ? 'block' : reason.severity === 'warn' ? 'warn' : reason.severity === 'ok' ? 'ok' : ''}">
                  <span class="reason-dot"></span>
                  <div class="reason-content"><b>${esc(reason.title)}</b><p>${esc(reason.detail)}</p></div>
                </div>`).join('')}
            </div>
            <div class="section-title">依赖与环境</div>
            <div class="dep-grid">
              ${depItems.map(([name, value]) => `<div class="dep-item"><b>${esc(name)}</b><span>${esc(value)}</span></div>`).join('')}
            </div>
            <div class="section-title">运行引擎</div>
            <div class="engine-box">
              <span class="tag"><svg class="icon" style="width:12px;height:12px"><use href="#i-${engine === 'gptk' ? 'spark' : engine === 'vm' ? 'windows' : 'package'}"></use></svg>${esc(ENGINE_LABEL[engine] || 'Wine')}</span>
              <p>${esc(analysis.engineReason || '使用开源 Wine 运行时。')}</p>
            </div>
            <div class="section-title">源文件</div>
            <div class="kv-list">
              <div class="kv"><span>安装目录</span><div class="copy-line"><code title="${esc(app.installPath)}">${esc(app.installPath)}</code><button data-copy="${esc(app.installPath)}" aria-label="复制安装目录"><svg class="icon" style="width:12px;height:12px"><use href="#i-copy"></use></svg></button></div></div>
              <div class="kv"><span>主程序</span><div class="copy-line"><code title="${esc(app.exePath)}">${esc(app.exePath || '未找到')}</code><button data-copy="${esc(app.exePath)}" aria-label="复制主程序路径"><svg class="icon" style="width:12px;height:12px"><use href="#i-copy"></use></svg></button><button class="edit-exe" data-action="pick-app-exe">更改</button></div></div>
              <div class="kv"><span>架构 / 体积</span><b>${esc(app.archLabel || app.arch || '未知')} · ${fmtBytes(app.estimatedSizeBytes || analysis.directory?.scannedBytes || 0)}</b></div>
              <div class="kv"><span>注册表快照</span><b>${app.registryKeys?.length || 0} 项</b></div>
              <div class="kv"><span>扫描信息</span><b>${analysis.directory?.scannedFiles ? `检查 ${analysis.directory.scannedFiles.toLocaleString('zh-CN')} 个文件` : '快速评估'}</b></div>
              ${analysis.services?.length ? `<div class="kv"><span>Windows 服务</span><b>${esc(analysis.services.map((item) => item.name).join('、'))}</b></div>` : ''}
            </div>
            <div class="warning-inline" style="background:#f5f3ed;color:var(--muted);"><svg class="icon"><use href="#i-info"></use></svg><span>这是兼容性评估，不是运行承诺。Wine 不加载内核驱动，也无法绕过反作弊或 DRM。</span></div>
            `}
        </div>
        <div class="drawer-foot">
          <button class="btn btn-ghost" data-action="show-install" ${app.installPath ? '' : 'disabled'}><svg class="icon"><use href="#i-folder"></use></svg>打开位置</button>
          <button class="btn ${blocked ? 'btn-primary' : 'btn-accent'}" data-action="open-build" ${app.exePath && app.analysis ? '' : 'disabled'}>
            <svg class="icon"><use href="#i-play"></use></svg>${blocked ? '仍然尝试打包' : '一键转换为 .app'}
          </button>
        </div>
      </aside>`;
    syncOverlayLock();
    requestAnimationFrame(() => drawerRoot.querySelector('.drawer')?.focus());
  }

  function defaultBuildOptions() {
    return {
      engineMode: state.settings?.engineMode || 'auto',
      includeRuntimes: state.settings?.includeRuntimes !== false,
      includeWineMono: state.settings?.includeWineMono !== false,
      includeUserData: Boolean(state.settings?.includeUserData),
      outputDir: state.settings?.outputDir || '',
      manualEngineArchive: '',
      installerArgs: '',
      installerArgsPreset: 'interactive',
      expectedExe: '',
      advanced: {
        metalHud: false,
        dxvkHud: false,
        verifyIntegrity: false,
        preventSleep: false,
        wineDebug: 'off',
        launchArgs: '',
        envText: '',
      },
    };
  }

  function createBuildState(app, installer = null) {
    return {
      open: true,
      step: 'setup',
      app,
      installer,
      options: defaultBuildOptions(),
      progress: 0,
      stage: '',
      message: '',
      log: [],
      result: null,
      error: null,
      recipe: null,
    };
  }

  function openBuildModal() {
    const app = state.apps.find((item) => item.id === state.selectedId);
    if (!app) return;
    openBuildForApp(app);
  }

  function openBuildForApp(app) {
    if (!app) return;
    if (!app.analysis) {
      toast('请等待兼容性分析完成', 'warn');
      return;
    }
    state.build = createBuildState(app);
    if (state.pendingRecipe) {
      const recipe = state.pendingRecipe;
      state.pendingRecipe = null;
      applyRecipeOptions(state.build, recipe);
      toastRecipeApplied(recipe, app);
    }
    renderModal();
  }

  function closeBuildModal() {
    if (!state.build) return;
    if (state.build.step === 'progress') return;
    const lastAppId = state.build.app?.id;
    state.build = null;
    modalRoot.innerHTML = '';
    syncOverlayLock();
    requestAnimationFrame(() => {
      const target = drawerRoot.querySelector('[data-action="open-build"]')
        || (lastAppId ? document.querySelector(`[data-action="convert-app"][data-convert-id="${CSS.escape(lastAppId)}"]`) : null);
      target?.focus();
    });
  }

  function baseName(filePath) {
    return String(filePath || '').split(/[\\/]/).filter(Boolean).pop() || '';
  }

  function presetForArgs(args, type = 'exe') {
    const value = String(args || '').trim();
    if (!value) return 'interactive';
    if (value === '/S') return 'nsis';
    if (value === '/VERYSILENT /SUPPRESSMSGBOXES /NORESTART') return 'inno';
    if (value === '/qn /norestart') return 'msi';
    return 'custom';
  }

  function applyRecipeOptions(build, recipe) {
    const options = recipe?.options || {};
    const advanced = options.advanced || {};
    build.options.engineMode = options.engineMode || 'auto';
    build.options.includeRuntimes = options.includeRuntimes !== false;
    build.options.includeWineMono = options.includeWineMono !== false;
    build.options.includeUserData = build.installer ? false : Boolean(options.includeUserData);
    build.options.manualEngineArchive = '';
    build.options.advanced = {
      metalHud: Boolean(advanced.metalHud),
      dxvkHud: Boolean(advanced.dxvkHud),
      verifyIntegrity: Boolean(advanced.verifyIntegrity),
      preventSleep: Boolean(advanced.preventSleep),
      wineDebug: ['off', 'warn', 'all'].includes(advanced.wineDebug) ? advanced.wineDebug : 'off',
      launchArgs: advanced.launchArgs || '',
      envText: advanced.envText || '',
    };
    if (build.installer && recipe?.installer) {
      build.options.installerArgs = recipe.installer.args || '';
      build.options.installerArgsPreset = presetForArgs(recipe.installer.args, recipe.installer.type);
      build.options.expectedExe = recipe.installer.expectedExe || '';
    }
    build.recipe = {
      name: recipe?.app?.name || recipe?.match?.name || '',
      grade: recipe?.compatibility?.grade || '',
      notes: recipe?.notes || '',
      imported: true,
    };
  }

  function sameAppName(a, b) {
    const norm = (value) => String(value || '').toLowerCase().replace(/\s+/g, ' ').trim();
    return Boolean(norm(a)) && norm(a) === norm(b);
  }

  function toastRecipeApplied(recipe, app) {
    const name = recipe?.app?.name || recipe?.match?.name || '未命名配方';
    if (sameAppName(name, app.name)) toast(`已应用配方「${name}」`, 'success');
    else toast(`配方来自「${name}」，已应用到「${app.name}」`, 'warn');
  }

  function findRecipeApp(recipe) {
    const name = String(recipe?.match?.name || recipe?.app?.name || '').toLowerCase().trim();
    const exe = baseName(recipe?.match?.exeName || recipe?.app?.exeName || '').toLowerCase();
    const publisher = String(recipe?.match?.publisher || recipe?.app?.publisher || '').toLowerCase().trim();
    const candidates = state.apps.filter((app) => app.exePath);
    const exact = candidates.find((app) => name && app.name.toLowerCase().trim() === name);
    if (exact) return exact;
    const byExe = candidates.find((app) => exe && baseName(app.exePath).toLowerCase() === exe);
    if (byExe) return byExe;
    return candidates.find((app) => {
      if (!publisher || name) return false;
      return String(app.publisher || '').toLowerCase().trim() === publisher;
    }) || null;
  }

  async function openRecipeBuild(app, recipe) {
    if (!app.analysis) {
      toast('正在分析目标应用…', 'info');
      try {
        const analysis = await api.analyzeApp(app, state.services, false);
        app.analysis = analysis;
        app.grade = analysis.grade;
        app.fullAnalysis = true;
      } catch (error) {
        toast(`无法分析目标应用：${error.message}`, 'error');
        return;
      }
    }
    closeDrawer();
    state.build = createBuildState(app);
    applyRecipeOptions(state.build, recipe);
    renderModal();
  }

  async function exportRecipe() {
    const build = state.build;
    if (!build?.app) return;
    if (!api.exportRecipe) {
      toast('当前环境不支持导出配方', 'warn');
      return;
    }
    try {
      const result = await api.exportRecipe({
        app: build.app,
        analysis: build.app.analysis,
        options: build.options,
        installer: build.installer || null,
      });
      if (!result) return;
      build.recipe = {
        ...(build.recipe || {}),
        name: result.recipe?.app?.name || build.app.name,
        exportedPath: result.path,
      };
      renderModal();
      toast(`配方已导出：${baseName(result.path)}`, 'success');
    } catch (error) {
      toast(`导出配方失败：${error.message}`, 'error');
    }
  }

  async function importRecipe() {
    if (!api.importRecipe) {
      toast('当前环境不支持导入配方', 'warn');
      return;
    }
    try {
      const result = await api.importRecipe();
      if (!result) return;
      const recipe = result.recipe;
      if (recipe.app?.source === 'installer') {
        toast('该配方用于安装器模式，请选择对应的安装包', 'info');
        const picked = await api.pickInstaller();
        if (!picked?.app) return;
        closeDrawer();
        state.build = createBuildState(picked.app, picked.installer);
        applyRecipeOptions(state.build, recipe);
        renderModal();
        return;
      }
      if (state.build?.open) {
        applyRecipeOptions(state.build, recipe);
        renderModal();
        toastRecipeApplied(recipe, state.build.app);
        return;
      }
      const app = findRecipeApp(recipe) || (state.selectedId && state.apps.find((item) => item.id === state.selectedId));
      if (app) {
        await openRecipeBuild(app, recipe);
        toastRecipeApplied(recipe, app);
        return;
      }
      state.pendingRecipe = recipe;
      if (state.page !== 'library') {
        state.page = 'library';
        renderPage();
      } else {
        renderLibrary();
      }
      updateChrome();
      toast('配方已导入，请选择要应用的应用', 'info');
    } catch (error) {
      toast(`导入配方失败：${error.message}`, 'error');
    }
  }

  function clearPendingRecipe() {
    state.pendingRecipe = null;
    if (state.page === 'library') renderLibrary();
    updateChrome();
  }

  function renderModal() {
    const build = state.build;
    if (!build) {
      modalRoot.innerHTML = '';
      syncOverlayLock();
      return;
    }
    const app = build.app;
    const analysis = app.analysis;
    if (build.step === 'setup') {
      const estimate = estimateBundle(analysis, build.options);
      const dotnet = analysis?.dependencies?.dotnetFramework;
      const blocked = analysis?.blocked || analysis?.grade === 'D';
      modalRoot.innerHTML = `
        <div class="modal-scrim" data-action="modal-backdrop">
          <div class="modal" role="dialog" aria-modal="true" aria-labelledby="build-title" tabindex="-1">
            <div class="modal-head">
              ${iconHtml(app)}
              <div class="modal-title"><h3 id="build-title">${build.installer ? '打包安装器' : '转换'} ${esc(app.name)}</h3><p>${build.installer ? '实验性安装器模式 · 首次启动在 Wine 中安装目标程序' : `${esc(analysis?.reasonSummary || '')} · 兼容性 ${analysis?.grade || '—'} · ${esc(GRADE_LABEL[analysis?.grade] || '')}`}</p></div>
              <button class="drawer-close" data-action="close-modal" aria-label="关闭"><svg class="icon"><use href="#i-close"></use></svg></button>
            </div>
            <div class="modal-body">
              ${build.installer ? `<div class="warning-inline" style="margin:0 0 16px;"><svg class="icon"><use href="#i-alert"></use></svg><span>实验性安装器模式：首次启动会先运行安装程序，完成后再自动查找主程序。自动发现是启发式的，强烈建议填写“预期主程序名”。</span></div>
              <div class="mini-label">安装器设置</div>
              <div class="installer-settings">
                <div class="installer-file">
                  <span class="installer-file-icon"><svg class="icon"><use href="#i-package"></use></svg></span>
                  <div><b>${esc(build.installer.name || build.installer.path?.split(/[\/]/).pop() || '安装包')}</b><span>${esc(build.installer.type.toUpperCase())} · ${fmtBytes(app.estimatedSizeBytes)}</span></div>
                </div>
                <div class="adv-grid">
                  <label class="adv-field">参数预设
                    <select id="installer-preset">
                      <option value="interactive" ${build.options.installerArgsPreset === 'interactive' ? 'selected' : ''}>交互式（首次推荐）</option>
                      <option value="nsis" ${build.options.installerArgsPreset === 'nsis' ? 'selected' : ''}>NSIS 静默 (/S)</option>
                      <option value="inno" ${build.options.installerArgsPreset === 'inno' ? 'selected' : ''}>Inno 静默 (/VERYSILENT)</option>
                      <option value="msi" ${build.options.installerArgsPreset === 'msi' ? 'selected' : ''}>MSI 静默 (/qn)</option>
                      <option value="custom" ${build.options.installerArgsPreset === 'custom' ? 'selected' : ''}>自定义</option>
                    </select>
                  </label>
                  <label class="adv-field">安装参数
                    <input id="installer-args" type="text" value="${esc(build.options.installerArgs)}" placeholder="例如 /S 或 /VERYSILENT">
                  </label>
                </div>
                <label class="adv-field">预期主程序名（推荐）
                  <input id="expected-exe" type="text" value="${esc(build.options.expectedExe)}" placeholder="例如 App.exe；留空则自动发现">
                </label>
                <p class="adv-note">安装参数会传给安装器；静默参数仅在确认安装器类型后使用。首次安装建议保持交互式。</p>
              </div>` : ''}
              ${blocked ? '<div class="warning-inline error-inline" style="margin:0 0 16px;"><svg class="icon"><use href="#i-alert"></use></svg><span>该应用属于高风险 / 阻断项。仍可生成 .app，但预计无法完整运行；建议优先寻找官方 Mac 版或使用 Windows 虚拟机。</span></div>' : ''}
              ${analysis?.gameLikely ? '<div class="warning-inline" style="margin:0 0 16px;background:var(--blue-soft);color:var(--blue);"><svg class="icon"><use href="#i-spark"></use></svg><span>检测到游戏/图形依赖。Mac 端优先使用 Apple GPTK 或 CrossOver 的 D3DMetal；自动模式会按此顺序选择。</span></div>' : ''}
              ${build.recipe ? `<div class="recipe-applied"><span class="recipe-applied-icon"><svg class="icon"><use href="#i-file"></use></svg></span><div><b>${build.recipe.imported ? '已应用移植配方' : '移植配方已导出'}</b><span>${esc(build.recipe.name || app.name)}${build.recipe.notes ? ` · ${esc(build.recipe.notes.length > 110 ? `${build.recipe.notes.slice(0, 107)}…` : build.recipe.notes)}` : ''}${build.recipe.exportedPath ? ` · ${esc(baseName(build.recipe.exportedPath))}` : ''}</span></div></div>` : ''}
              <div class="mini-label">运行引擎 <span class="opt">决定安装包体积与目标 Mac 的依赖</span></div>
              <div class="engine-options">
                ${engineOptionHtml('auto', '自动选择', '优先复用 Mac 已装 CrossOver / GPTK / Whisky；缺失时自动下载开源 Wine。', '推荐', 'spark')}
                ${engineOptionHtml('bundled', '内置 Wine', '把 Wine 11.18（约 184 MB）装进 ZIP，目标 Mac 离线可用。', '', 'package')}
                ${engineOptionHtml('reuse', '仅复用引擎', '不下载也不内置；目标 Mac 必须已有 CrossOver / GPTK / Whisky / Homebrew Wine。', '', 'link')}
              </div>
              ${build.installer ? '' : `<div class="mini-label">打包选项</div>
              <div class="option-row">
                <span class="option-icon"><svg class="icon"><use href="#i-cpu"></use></svg></span>
                <div class="option-text"><b>附带 VC++ 运行库</b><small>检测到依赖时下载微软官方 redist，首次启动自动安装。</small></div>
                <button class="switch ${build.options.includeRuntimes ? 'on' : ''}" data-toggle-option="includeRuntimes" aria-label="附带 VC++ 运行库" aria-pressed="${build.options.includeRuntimes}"></button>
              </div>`}
              ${build.installer ? '' : dotnet ? `<div class="option-row">
                <span class="option-icon"><svg class="icon"><use href="#i-package"></use></svg></span>
                <div class="option-text"><b>附带 Wine Mono</b><small>用于 .NET Framework 应用，约 83 MB。内置 Gcenx Wine 已自带 Mono；手动引擎或复用 GPTK 时建议保留。</small></div>
                <button class="switch ${build.options.includeWineMono ? 'on' : ''}" data-toggle-option="includeWineMono" aria-label="附带 Wine Mono" aria-pressed="${build.options.includeWineMono}"></button>
              </div>` : ''}
              ${build.installer ? '' : `<div class="option-row">
                <span class="option-icon"><svg class="icon"><use href="#i-folder"></use></svg></span>
                <div class="option-text"><b>包含用户数据</b><small>复制 AppData 中与这个应用同名的设置目录，可能包含个人数据。</small></div>
                <button class="switch ${build.options.includeUserData ? 'on' : ''}" data-toggle-option="includeUserData" aria-label="包含用户数据" aria-pressed="${build.options.includeUserData}"></button>
              </div>`}
              <div class="mini-label">输出位置</div>
              <div class="output-row">
                <svg class="icon"><use href="#i-folder"></use></svg>
                <input type="text" id="output-path" value="${esc(build.options.outputDir)}" readonly aria-label="输出目录">
                <button class="btn btn-soft btn-sm" data-action="pick-output">更改</button>
              </div>
              <div class="manual-engine">
                <button class="link-btn" data-action="pick-engine-archive">已有 Wine 引擎 tar.xz？手动选择</button>
                ${build.options.manualEngineArchive ? `<code title="${esc(build.options.manualEngineArchive)}">${esc(build.options.manualEngineArchive.split(/[\\/]/).pop())}</code>` : ''}
              </div>
              <details class="advanced-box">
                <summary>
                  <span class="adv-summary-title"><svg class="icon"><use href="#i-settings"></use></svg>高级运行设置</span>
                  <span class="adv-summary-hint">Metal HUD · 环境变量 · 启动参数</span>
                </summary>
                <div class="advanced-inner">
                  <div class="adv-grid">
                    ${advSwitch('metalHud', 'Metal HUD', '显示 Metal 性能叠层（GPTK / D3DMetal 生效）', build.options.advanced.metalHud)}
                    ${advSwitch('dxvkHud', 'DXVK HUD', '显示 DXVK 帧率叠层（使用 DXVK 时生效）', build.options.advanced.dxvkHud)}
                    ${advSwitch('verifyIntegrity', '启动前校验', '每次启动校验全部文件，超大应用会明显变慢', build.options.advanced.verifyIntegrity)}
                    ${advSwitch('preventSleep', '阻止睡眠', '应用运行期间保持系统唤醒', build.options.advanced.preventSleep)}
                  </div>
                  <label class="adv-field">启动参数覆盖
                    <input id="adv-launch-args" type="text" value="${esc(build.options.advanced.launchArgs)}" placeholder="留空则使用原快捷方式参数">
                  </label>
                  <label class="adv-field">自定义环境变量
                    <textarea id="adv-env" rows="3" placeholder="每行一个 KEY=VALUE，例如：DXVK_ASYNC=1">${esc(build.options.advanced.envText)}</textarea>
                  </label>
                  <label class="adv-field">Wine 日志
                    <select id="adv-winedebug">
                      <option value="off" ${build.options.advanced.wineDebug === 'off' ? 'selected' : ''}>关闭（推荐）</option>
                      <option value="warn" ${build.options.advanced.wineDebug === 'warn' ? 'selected' : ''}>警告</option>
                      <option value="all" ${build.options.advanced.wineDebug === 'all' ? 'selected' : ''}>详细（排障，日志很大）</option>
                    </select>
                  </label>
                  <p class="adv-note">这些选项会写入 macOS 启动器；Metal HUD 与 DXVK HUD 需要对应引擎支持。自定义环境变量优先于默认值。</p>
                </div>
              </details>
            </div>
            <div class="modal-foot">
              <div class="foot-note">${build.installer ? '原始安装包不做修改。' : '原始 Windows 文件不做修改。'}${estimate ? `预计 ZIP 约 ${fmtBytes(estimate)}（含运行时估算）。` : 'ZIP 大小取决于应用体积。'}<br>${build.installer ? '首次在 Mac 启动会先运行安装程序。' : '首次在 Mac 启动需初始化 Wine 环境。'}</div>
              <div class="modal-foot-actions">
                <button class="btn btn-ghost btn-sm" data-action="export-recipe" title="把当前引擎、运行库与高级选项保存为可分享的 JSON"><svg class="icon"><use href="#i-file"></use></svg>导出配方</button>
                <button class="btn btn-ghost" data-action="close-modal">取消</button>
                <button class="btn btn-accent" data-action="start-build"><svg class="icon"><use href="#i-play"></use></svg>开始打包</button>
              </div>
            </div>
          </div>
        </div>`;
      syncOverlayLock();
      requestAnimationFrame(() => modalRoot.querySelector('.modal')?.focus());
      return;
    }
    if (build.step === 'progress') {
      const stageIndex = STAGE_DEFS.findIndex(([stage]) => stage === STAGE_ALIAS[build.stage]);
      modalRoot.innerHTML = `
        <div class="modal-scrim">
          <div class="modal" role="dialog" aria-modal="true" aria-label="正在打包" tabindex="-1">
            <div class="modal-head">
              ${iconHtml(app)}
              <div class="modal-title"><h3>正在生成 macOS 安装包</h3><p>${esc(app.name)} · 原文件只读复制中</p></div>
            </div>
            <div class="modal-body">
              <div class="progress-hero">
                <div class="progress-top">
                  <div><div class="progress-percent" id="b-progress-percent">${build.progress}<span>%</span></div><div class="progress-stage-label" id="b-progress-stage">${esc(build.stageLabel || '准备中')}</div></div>
                  <div style="text-align:right"><div class="progress-stage-message" id="b-progress-message">${esc(build.message || '正在准备…')}</div><div class="progress-note"><svg class="icon"><use href="#i-lock"></use></svg>本地构建 · 不上传</div></div>
                </div>
                <div class="progress-bar"><i id="b-progress-bar" style="width:${build.progress}%"></i></div>
              </div>
              <div class="stage-list" id="b-stage-list">
                ${STAGE_DEFS.map(([stage, label], index) => `
                  <div class="stage-item ${index < stageIndex ? 'done' : index === stageIndex ? 'active' : ''}" data-stage="${stage}">
                    <span class="stage-dot">${index < stageIndex ? '✓' : ''}</span>${label}
                  </div>`).join('')}
              </div>
              <div class="log-box" id="b-log">${build.log.slice(-10).map((line) => `<span class="log-stage">[${esc(line.stage)}]</span> <span class="log-msg">${esc(line.message)}</span>`).join('\n')}</div>
              <div class="progress-note"><svg class="icon"><use href="#i-info"></use></svg>大应用复制与压缩可能需要数分钟，请保持窗口打开。</div>
            </div>
          </div>
        </div>`;
      syncOverlayLock();
      requestAnimationFrame(() => modalRoot.querySelector('.modal')?.focus());
      return;
    }
    if (build.step === 'done') {
      const result = build.result || {};
      const isWindows = result.platform === 'windows';
      modalRoot.innerHTML = `
        <div class="modal-scrim">
          <div class="modal" role="dialog" aria-modal="true" aria-label="转换完成" tabindex="-1">
            <div class="modal-body">
              <div class="done-view">
                <div class="done-icon"><svg class="icon"><use href="#i-check"></use></svg></div>
                <h3>${isWindows ? 'Windows 版已生成' : '转换完成'}</h3>
                <p>${isWindows
                  ? `${esc(app.name)} 已由 macOS Electron 载荷重组为 Windows 免安装版。`
                  : result.mode === 'installer' ? '安装器已打包；首次在 Mac 启动会先运行安装程序。' : `${esc(app.name)} 已打包为可拷贝到 Mac 的 .app 与 ZIP。`}</p>
                <div class="done-stats">
                  <div class="done-stat"><b>${result.fileCount ? result.fileCount.toLocaleString('zh-CN') : '—'}</b><span>原样文件</span></div>
                  <div class="done-stat"><b>${fmtBytes(result.zipSize)}</b><span>ZIP 大小</span></div>
                  <div class="done-stat"><b>${esc(result.engine?.version || (isWindows ? 'Electron' : 'Wine'))}</b><span>运行引擎</span></div>
                </div>
                <div class="done-path"><svg class="icon"><use href="#i-folder"></use></svg><code title="${esc(result.folderPath)}">${esc(result.folderPath)}</code></div>
                ${result.warnings?.length ? `<div class="warning-inline" style="text-align:left;max-width:540px;margin:0 auto 14px;"><svg class="icon"><use href="#i-alert"></use></svg><span>打包过程中有 ${result.warnings.length} 条警告，已写入使用说明。大体积或系统级应用请先在 Mac 上验证。</span></div>` : ''}
                <div class="done-actions">
                  <button class="btn btn-ghost" data-action="show-zip">在文件夹中显示</button>
                  <button class="btn btn-primary" data-action="open-output"><svg class="icon"><use href="#i-folder"></use></svg>打开输出目录</button>
                  <button class="btn btn-ghost" data-action="ai-fix" data-build-id="${esc(result.buildId || '')}"><svg class="icon"><use href="#i-spark"></use></svg>AI 修复</button>
                  <button class="btn btn-accent" data-action="done-close">完成</button>
                </div>
                <div class="progress-note" style="justify-content:center;">${isWindows ? '直接双击 EXE 运行 · 首次可能被 SmartScreen 拦截' : 'SHA-256 ' + esc((result.zipSha256 || '').slice(0, 16)) + '… · 首次启动运行 Open-Win2Mac-App.command · Mac 诊断双击 Start-Mac-Validation.command'}</div>
              </div>
            </div>
          </div>
        </div>`;
      syncOverlayLock();
      requestAnimationFrame(() => modalRoot.querySelector('.modal')?.focus());
      return;
    }
    if (build.step === 'error') {
      modalRoot.innerHTML = `
        <div class="modal-scrim">
          <div class="modal" role="dialog" aria-modal="true" aria-label="打包失败" tabindex="-1">
            <div class="modal-body">
              <div class="error-box">
                <div class="error-icon"><svg class="icon"><use href="#i-alert"></use></svg></div>
                <h3>打包未完成</h3>
                <p>构建过程中遇到问题。请检查输出目录权限、网络连接或引擎压缩包，然后重试。</p>
                <div class="error-detail">${esc(build.error || '未知错误')}</div>
                <div class="done-actions">
                  <button class="btn btn-ghost" data-action="close-modal">关闭</button>
                  <button class="btn btn-primary" data-action="retry-build">返回设置</button>
                </div>
              </div>
            </div>
          </div>
        </div>`;
      syncOverlayLock();
      requestAnimationFrame(() => modalRoot.querySelector('.modal')?.focus());
    }
  }

  function advSwitch(key, title, description, value) {
    return `<div class="adv-toggle"><div><b>${esc(title)}</b><small>${esc(description)}</small></div><button class="switch ${value ? 'on' : ''}" data-adv-toggle="${key}" aria-label="${esc(title)}" aria-pressed="${value}"></button></div>`;
  }

  function engineOptionHtml(mode, title, description, tag, icon) {
    const selected = state.build?.options.engineMode === mode;
    return `<button class="engine-option ${selected ? 'selected' : ''}" data-engine-mode="${mode}">
      ${tag ? `<span class="recommend">${tag}</span>` : ''}
      <span class="engine-icon"><svg class="icon" style="width:15px;height:15px"><use href="#i-${icon === 'link' ? 'globe' : icon}"></use></svg></span>
      <b>${esc(title)}</b><small>${esc(description)}</small>
    </button>`;
  }

  function estimateBundle(analysis, options) {
    const app = state.build?.app;
    const base = app?.estimatedSizeBytes || analysis?.directory?.scannedBytes || 0;
    if (!base) return 0;
    let extra = 0;
    if (options.includeRuntimes) extra += 28 * 1024 * 1024;
    if (options.includeWineMono && analysis?.dependencies?.dotnetFramework) extra += 83 * 1024 * 1024;
    if (options.engineMode === 'bundled') extra += 193_105_336;
    return Math.round(base * 0.64 + extra);
  }

  function renderTasks() {
    const history = state.history;
    view.innerHTML = `
      <div class="page">
        <div class="page-head">
          <div class="page-head-copy"><div class="eyebrow">Build history</div><h1>转换任务</h1><p>最近生成的 .app、ZIP 与完整性记录。</p></div>
          <button class="btn btn-ghost" data-action="clear-history" ${history.length ? '' : 'disabled'}><svg class="icon"><use href="#i-trash"></use></svg>清空记录</button>
          <button class="btn btn-accent" data-action="scan"><svg class="icon"><use href="#i-refresh"></use></svg>扫描应用</button>
        </div>
        ${history.length ? `<div class="task-list">${history.map((item) => taskCardHtml(item)).join('')}</div>` : `
          <div class="empty-tasks">
            <svg class="icon"><use href="#i-layers"></use></svg>
            <h3>还没有转换记录</h3>
            <p>从应用库选择一个应用，生成你的第一个 macOS .app。</p>
            <button class="btn btn-primary" data-nav="library">去应用库</button>
          </div>`}
      </div>`;
  }

  function taskCardHtml(item) {
    const grade = item.grade || '—';
    const tone = GRADE_TONE[grade] || 'neutral';
    return `
      <div class="task-card">
        <div class="task-icon"><svg class="icon"><use href="#i-package"></use></svg></div>
        <div class="task-main">
          <b>${esc(item.appName)} <span class="grade ${tone}" style="margin-left:6px"><i></i>${esc(grade)}</span></b>
          <p title="${esc(item.zipPath)}">${esc(item.zipPath)}</p>
        </div>
        <div class="task-meta">
          <span>${esc(item.engineVersion || item.engine?.version || 'Wine')}</span>
          <span>${fmtBytes(item.zipSize)}</span>
          <span>${fmtDate(item.createdAt)}</span>
        </div>
        <div class="task-actions">
          <button class="icon-btn" data-action="open-folder" data-path="${esc(item.folderPath)}" aria-label="打开目录"><svg class="icon"><use href="#i-folder"></use></svg></button>
          <button class="icon-btn" data-action="show-zip" data-path="${esc(item.zipPath)}" aria-label="显示 ZIP"><svg class="icon"><use href="#i-file"></use></svg></button>
        </div>
      </div>`;
  }

  function renderCompat() {
    view.innerHTML = `
      <div class="page">
        <div class="compat-hero">
          <div>
            <div class="eyebrow">Know before you build</div>
            <h1>先知道能不能跑，<br>再开始打包。</h1>
            <p>“无损”指原 Windows 文件逐字节保留、注册表快照完整导出；不是把程序重新编译成原生 Mac 代码。能否运行，取决于 Wine 对它的兼容程度。</p>
          </div>
          <div class="compat-note-card">
            <b><svg class="icon"><use href="#i-alert"></use></svg>一条硬边界</b>
            <p>带内核驱动、反作弊或 DRM 的程序，Wine 无法绕过。这不是配置问题，换引擎也不会消失。</p>
          </div>
        </div>
        <div class="grade-grid">
          ${gradeCard('A', 'green', '可直接运行', '常规 64 位 Win32 应用，无特殊图形或系统依赖。Wine 兼容性高。')}
          ${gradeCard('B', 'blue', '通常可运行', '依赖 VC++、.NET 或一般图形接口，可能需要运行时与少量显示配置。')}
          ${gradeCard('C', 'amber', '需要调校', '.NET Framework、WebView2、DX11 或复杂授权组件。建议 CrossOver / GPTK 并准备排障。')}
          ${gradeCard('D', 'red', '不建议直接运行', '内核驱动、反作弊、DRM、ARM64 二进制，属于 Wine 硬限制。依赖 Windows 服务通常降为 C。')}
        </div>
        <div class="section-card">
          <div class="section-card-head"><svg class="icon"><use href="#i-package"></use></svg><div><h2>引擎怎么选</h2><p>工具只负责检测与调用；Apple GPTK 与 CrossOver 的二进制不会被重新分发。</p></div></div>
          <table class="engine-table">
            <thead><tr><th>运行时</th><th>常规应用</th><th>游戏 / DX</th><th>反作弊</th><th>分发与许可</th></tr></thead>
            <tbody>
              <tr><td>内置 Wine 11.18</td><td class="ok">好</td><td class="mid">需 DXVK / 有限</td><td class="no">不可</td><td>Gcenx 构建，LGPL；约 184 MB</td></tr>
              <tr><td>CrossOver 24+</td><td class="ok">好</td><td class="ok">D3DMetal</td><td class="no">不可</td><td>商业许可，需用户自装</td></tr>
              <tr><td>Apple GPTK 2/3</td><td class="mid">部分</td><td class="ok">最佳</td><td class="no">不可</td><td>Apple 专有，不可再分发</td></tr>
              <tr><td>Whisky（活跃 fork）</td><td class="ok">好</td><td class="mid">取决于引擎</td><td class="no">不可</td><td>GPL-3.0，需用户自装</td></tr>
              <tr><td>Windows 虚拟机</td><td class="ok">完整</td><td class="mid">ARM 性能有限</td><td class="mid">可能，但有风险</td><td>UTM / Parallels，资源开销大</td></tr>
            </tbody>
          </table>
        </div>
        <div class="section-card">
          <div class="section-card-head"><svg class="icon"><use href="#i-shield"></use></svg><div><h2>“无损”到底指什么</h2><p>我们保留所有可保留的东西，也不把兼容性说成 100%。</p></div></div>
          <div class="boundary-grid">
            <div class="boundary-item good"><b><svg class="icon"><use href="#i-check"></use></svg>原样保留</b><p>安装目录逐文件复制，SHA-256 清单可验证；注册表键、快捷方式参数、工作目录、用户数据（可选）一并打包。</p></div>
            <div class="boundary-item good"><b><svg class="icon"><use href="#i-check"></use></svg>独立环境</b><p>每个应用拥有独立 Wine 前缀与日志。重建应用不会修改原 Windows 安装，也不会污染其他 .app。</p></div>
            <div class="boundary-item warn"><b><svg class="icon"><use href="#i-alert"></use></svg>兼容性边界</b><p>内核驱动、反作弊、DRM、Windows 服务、UWP/MSIX 与部分 WebView2 功能无法由 Wine 提供。</p></div>
            <div class="boundary-item bad"><b><svg class="icon"><use href="#i-close"></use></svg>不是原生移植</b><p>没有重编译、性能改造或原生 UI。游戏性能与 GPU 特性取决于 Metal/D3DMetal 路径。</p></div>
          </div>
        </div>
        <div class="section-card">
          <div class="section-card-head"><svg class="icon"><use href="#i-lock"></use></svg><div><h2>macOS 首次打开</h2><p>从 Windows 生成的 .app 未签名、未公证；macOS 15+ 对未签名应用更严格。</p></div></div>
          <ol style="margin:0;padding-left:20px;color:var(--muted);font-size:11px;line-height:1.9;">
            <li>用 macOS 访达解压 ZIP，避免 Windows 解压工具丢失执行权限。</li>
            <li>双击 <code style="font:10px var(--mono)">Open-Win2Mac-App.command</code>，它会清除隔离标记并打开应用。</li>
            <li>若脚本也被拦截：打开“系统设置 → 隐私与安全性”，点“仍要打开”；或在终端运行 <code style="font:10px var(--mono)">xattr -dr com.apple.quarantine /路径/App.app</code>。</li>
            <li>Apple Silicon 运行 x86_64 Wine 需要 Rosetta 2；首次启动会给出安装提示。</li>
          </ol>
        </div>
        <div class="settings-foot" style="margin-top:8px;">
          <span>调研依据：Gcenx macOS_Wine_builds、Whisky、Sikarugir/Wineskin、Apple GPTK、CrossOver 文档（2026-10）。</span>
          <span><button class="link-btn" data-external="https://github.com/Gcenx/macOS_Wine_builds">Wine 构建</button> · <button class="link-btn" data-external="https://github.com/frankea/Whisky">Whisky fork</button></span>
        </div>
      </div>`;
  }

  function gradeCard(letter, tone, title, description) {
    return `<div class="grade-card ${tone}"><div class="big-grade">${letter}</div><div class="grade-title">${title}</div><p>${description}</p><div class="grade-bar"><i></i></div></div>`;
  }

  function renderSettings() {
    const s = state.settings || {};
    const mode = s.engineMode || 'auto';
    view.innerHTML = `
      <div class="page">
        <div class="page-head">
          <div class="page-head-copy"><div class="eyebrow">Preferences</div><h1>设置</h1><p>这些默认值会带入每一次新的转换任务。</p></div>
        </div>
        <div class="settings-grid">
          <section class="settings-card">
            <h2>输出位置</h2>
            <p>每个任务会生成同名文件夹（含 .app、说明与脚本）以及 ZIP。</p>
            <div class="settings-field">
              <label>默认输出目录</label>
              <div class="output-row">
                <svg class="icon"><use href="#i-folder"></use></svg>
                <input type="text" value="${esc(s.outputDir || '')}" readonly aria-label="默认输出目录">
                <button class="btn btn-soft btn-sm" data-action="pick-output">选择</button>
              </div>
            </div>
            <div class="warning-inline" style="background:#f5f3ed;color:var(--muted);"><svg class="icon"><use href="#i-info"></use></svg><span>生成 .app 不需要 Mac。输出目录建议放在本地磁盘，而不是同步盘。</span></div>
          </section>

          <section class="settings-card">
            <h2>默认运行引擎</h2>
            <p>决定目标 Mac 首次运行时的引擎来源。自动模式适合大多数用户。</p>
            <div class="engine-options vertical">
              ${settingsEngineOption('auto', '自动选择', '优先复用 Mac 已装引擎；缺失时下载 Wine 11.18。', 'spark', mode === 'auto')}
              ${settingsEngineOption('bundled', '内置 Wine 引擎', '把约 184 MB 的 Wine 打包进 ZIP，离线可用。', 'package', mode === 'bundled')}
              ${settingsEngineOption('reuse', '仅复用现有引擎', '安装包最小，但目标 Mac 必须已有 CrossOver / GPTK / Whisky。', 'globe', mode === 'reuse')}
            </div>
          </section>

          <section class="settings-card">
            <h2>运行时与内容</h2>
            <p>打包时自动准备目标 Mac 需要的兼容组件。</p>
            <div class="settings-toggle">
              <div class="option-text"><b>附带 VC++ 运行库</b><small>检测到依赖时下载微软官方 redist；构建时联网。</small></div>
              <button class="switch ${s.includeRuntimes !== false ? 'on' : ''}" data-setting-toggle="includeRuntimes" aria-label="附带 VC++ 运行库"></button>
            </div>
            <div class="settings-toggle">
              <div class="option-text"><b>附带 Wine Mono</b><small>为 .NET Framework 应用准备 Mono，约 83 MB。</small></div>
              <button class="switch ${s.includeWineMono !== false ? 'on' : ''}" data-setting-toggle="includeWineMono" aria-label="附带 Wine Mono"></button>
            </div>
            <div class="settings-toggle">
              <div class="option-text"><b>默认包含用户数据</b><small>复制 AppData 中的同名配置目录；可能包含隐私信息。</small></div>
              <button class="switch ${s.includeUserData ? 'on' : ''}" data-setting-toggle="includeUserData" aria-label="默认包含用户数据"></button>
            </div>
          </section>

          <section class="settings-card">
            <h2>网络与下载</h2>
            <p>仅用于下载 Wine 引擎、VC++ / Wine Mono 运行时。不使用代理时留空。</p>
            <div class="settings-field">
              <label>HTTP 代理（可选）</label>
              <input type="text" id="proxy-input" value="${esc(s.proxy || '')}" placeholder="http://127.0.0.1:7897">
            </div>
            <div class="settings-field">
              <label>固定 Wine 引擎</label>
              <div class="kv-list">
                <div class="kv"><span>版本</span><b>${esc(state.info?.enginePinned?.version || '11.18')}</b></div>
                <div class="kv"><span>架构</span><b>x86_64 · Apple Silicon 需 Rosetta</b></div>
                <div class="kv"><span>资产</span><b>${esc(state.info?.enginePinned?.size || '184.2 MB')}</b></div>
              </div>
            </div>
          </section>

          <section class="settings-card">
            <h2>AI 修复（OpenAI 兼容）</h2>
            <p>接口需兼容 /chat/completions，可填 OpenAI、DeepSeek、通义、本地 LM Studio 等。构建完成后点「AI 修复」，它会读取 Mac 诊断包、改配置并按需重建。</p>
            <div class="settings-field">
              <label>Base URL</label>
              <input type="text" id="ai-base-url" value="${esc(s.ai?.baseUrl || 'https://api.openai.com/v1')}" placeholder="https://api.openai.com/v1">
            </div>
            <div class="settings-field">
              <label>模型</label>
              <input type="text" id="ai-model" value="${esc(s.ai?.model || 'gpt-4o-mini')}" placeholder="gpt-4o-mini">
            </div>
            <div class="settings-field">
              <label>API Key${s.ai?.hasKey ? `（已保存 ${esc(s.ai.keyHint)}）` : ''}</label>
              <input type="password" id="ai-key" value="" placeholder="${s.ai?.hasKey ? '留空表示不修改' : 'sk-...'}" autocomplete="off">
            </div>
            <label class="settings-toggle"><input type="checkbox" id="ai-clear-key"><span>清除已保存的 Key</span></label>
            <div class="settings-foot" style="margin-top:8px;display:flex;gap:8px;">
              <button class="btn btn-primary btn-sm" data-action="save-ai">保存</button>
              <button class="btn btn-ghost btn-sm" data-action="test-ai">测试连接</button>
            </div>
          </section>

          <section class="settings-card">
            <h2>环境诊断</h2>
            <p>检查 PowerShell、curl、引擎清单与磁盘空间。</p>
            <button class="btn btn-ghost btn-sm" data-action="run-diagnostics"><svg class="icon"><use href="#i-terminal"></use></svg>运行检查</button>
            <div class="diagnostic-list" id="diagnostic-list"></div>
          </section>

          <section class="settings-card cache-card">
            <div class="settings-card-head">
              <div><h2>缓存与空间</h2><p>引擎、运行库与中断的临时构建。清理不会影响已生成的 .app 或任务记录。</p></div>
              <button class="btn btn-ghost btn-sm" data-action="refresh-cache" ${state.cacheLoading ? 'disabled' : ''}><svg class="icon"><use href="#i-refresh"></use></svg>刷新</button>
            </div>
            <div id="cache-region">${cacheRegionHtml()}</div>
          </section>

          <section class="settings-card">
            <h2>关于</h2>
            <p>Win2Mac Studio 在 Windows 上生成标准 macOS .app 目录结构与 ZIP，不需要 Mac 参与构建。</p>
            <div class="about-row"><span>版本</span><b>Win2Mac Studio ${esc(state.info?.version || '0.1.0')}</b></div>
            <div class="about-row"><span>运行环境</span><b>${esc(state.info?.platform || 'win32')} · ${esc(state.info?.arch || 'x64')}${state.info?.electron ? ` · Electron ${esc(state.info.electron)}` : ''}</b></div>
            <div class="about-row"><span>数据目录</span><b title="${esc(state.info?.userData || '')}">${esc(state.info?.userData || '')}</b></div>
            <div class="about-row"><span>模式</span><b>${state.demo ? '浏览器演示数据（不会写入文件）' : '本机桌面模式'}</b></div>
            <div class="warning-inline" style="background:var(--green-soft);color:var(--green);"><svg class="icon"><use href="#i-shield"></use></svg><span>Windows 应用与商标归各自权利人所有。请确认你拥有打包与分发的权利。</span></div>
          </section>
        </div>
      </div>`;
    if (!state.cacheStats && !state.cacheLoading) loadCacheStats();
  }

  function cacheRegionHtml() {
    if (state.cacheError) {
      return `<div class="cache-empty"><svg class="icon"><use href="#i-alert"></use></svg><span>${esc(state.cacheError)}</span><button class="link-btn" data-action="refresh-cache">重试</button></div>`;
    }
    if (state.cacheLoading && !state.cacheStats) {
      return '<div class="cache-loading"><span class="dot"></span>正在统计缓存…</div>';
    }
    if (!state.cacheStats) {
      return '<div class="cache-loading"><span class="dot"></span>正在统计缓存…</div>';
    }
    const stats = state.cacheStats;
    const rows = stats.groups.map((group) => {
      const busy = state.cacheLoading ? 'disabled' : '';
      const disabled = !group.bytes ? 'disabled' : '';
      return `
        <div class="cache-row">
          <div class="cache-info">
            <b>${esc(group.label)}</b>
            <span>${esc(group.hint)}</span>
            <code title="${esc(group.path)}">${esc(group.path)}</code>
          </div>
          <div class="cache-metrics"><b>${fmtBytes(group.bytes)}</b><span>${group.files.toLocaleString('zh-CN')} 个文件${group.truncated ? ' · 部分统计' : ''}</span></div>
          <div class="cache-row-actions">
            <button class="icon-btn" data-action="open-folder" data-path="${esc(group.path)}" title="打开目录" aria-label="打开 ${esc(group.label)} 目录" ${busy}><svg class="icon"><use href="#i-folder"></use></svg></button>
            <button class="btn btn-ghost btn-xs" data-action="clear-cache" data-cache-keys="${esc(group.key)}" ${disabled} ${busy}>清理</button>
          </div>
        </div>`;
    }).join('');
    return `
      <div class="cache-total"><span>合计占用</span><b>${fmtBytes(stats.totalBytes)}</b><span class="cache-total-files">${stats.totalFiles.toLocaleString('zh-CN')} 个文件</span></div>
      <div class="cache-list">${rows}</div>
      <div class="cache-foot">
        <button class="btn btn-ghost btn-sm" data-action="clear-cache" data-cache-keys="engines,runtimes,staging" ${stats.totalBytes ? '' : 'disabled'} ${state.cacheLoading ? 'disabled' : ''}><svg class="icon"><use href="#i-trash"></use></svg>清理全部缓存</button>
        <span>清理后会重新下载所需组件</span>
      </div>`;
  }

  function renderCacheRegion() {
    const region = $('#cache-region');
    if (region) region.innerHTML = cacheRegionHtml();
    const refresh = document.querySelector('[data-action="refresh-cache"]');
    if (refresh) refresh.disabled = state.cacheLoading;
  }

  async function loadCacheStats() {
    if (state.cacheLoading || !api.cacheStats) return;
    state.cacheLoading = true;
    state.cacheError = null;
    renderCacheRegion();
    try {
      state.cacheStats = await api.cacheStats();
    } catch (error) {
      state.cacheError = `缓存统计失败：${error.message}`;
    } finally {
      state.cacheLoading = false;
      if (state.page === 'settings') renderCacheRegion();
    }
  }

  async function clearCache(keys) {
    const selected = (keys || []).filter(Boolean);
    if (!selected.length || !api.clearCache) return;
    try {
      const result = await api.clearCache(selected);
      if (!result) return;
      state.cacheStats = result.stats || state.cacheStats;
      renderCacheRegion();
      if (result.clearedBytes) toast(`已清理 ${fmtBytes(result.clearedBytes)} 缓存`, 'success');
      else toast('选中的缓存已经是空的', 'info');
    } catch (error) {
      toast(`清理缓存失败：${error.message}`, 'error');
    }
  }

  function settingsEngineOption(mode, title, desc, icon, selected) {
    return `<button class="engine-option ${selected ? 'selected' : ''}" data-setting-engine="${mode}">
      ${mode === 'auto' ? '<span class="recommend">推荐</span>' : ''}
      <span class="engine-icon"><svg class="icon" style="width:15px;height:15px"><use href="#i-${icon}"></use></svg></span>
      <div><b>${esc(title)}</b><small>${esc(desc)}</small></div>
    </button>`;
  }

  function updateChrome() {
    const meta = PAGE_META[state.page] || PAGE_META.library;
    $('#page-title').textContent = meta.title;
    $('#page-subtitle').textContent = state.page === 'library' && state.scannedAt ? `上次扫描 ${timeAgo(state.scannedAt)}` : meta.subtitle;
    $$('.nav-item').forEach((item) => {
      const active = item.dataset.nav === state.page;
      item.classList.toggle('active', active);
      if (active) item.setAttribute('aria-current', 'page');
      else item.removeAttribute('aria-current');
    });
    const taskCount = $('#task-count');
    if (taskCount) taskCount.textContent = state.history.length ? String(state.history.length) : '';
    const search = $('#topbar-search');
    if (search) search.classList.toggle('hidden', state.page !== 'library');
    const actions = $('#topbar-actions');
    if (actions) {
      if (state.page === 'library') {
        actions.innerHTML = `
          <button class="btn btn-ghost btn-sm" data-action="pick-exe"><svg class="icon"><use href="#i-plus"></use></svg>选择 .exe</button>
          <button class="btn btn-primary btn-sm" data-action="scan" ${state.scanning ? 'disabled' : ''}><svg class="icon"><use href="#i-refresh"></use></svg>${state.scanning ? '扫描中…' : '扫描'}</button>`;
      } else if (state.page === 'tasks') {
        actions.innerHTML = `<span class="save-indicator"><span class="dot"></span>${state.history.length} 次转换</span>`;
      } else if (state.page === 'compat') {
        actions.innerHTML = `<span class="mode-chip" style="height:32px;"><span class="status-dot"></span>Wine 11.18 · 2026-10</span>`;
      } else {
        actions.innerHTML = `<span class="save-indicator"><span class="dot"></span>自动保存</span>`;
      }
    }
    const runtimeVersion = $('#runtime-version');
    if (runtimeVersion) runtimeVersion.textContent = state.info?.enginePinned?.version || '11.18';
    const caption = $('#runtime-caption');
    if (caption) caption.textContent = state.demo ? '演示引擎清单 · 不会下载' : '开源引擎已锁定 · x86_64';
    const chip = $('#mode-chip');
    if (chip) chip.classList.toggle('demo', state.demo);
    const modeLabel = $('#mode-label');
    if (modeLabel) modeLabel.textContent = state.demo ? '演示数据' : '本机模式';
  }

  function renderPage() {
    updateChrome();
    if (state.page === 'library') renderLibrary();
    else if (state.page === 'tasks') renderTasks();
    else if (state.page === 'compat') renderCompat();
    else if (state.page === 'settings') renderSettings();
    view.scrollTop = 0;
  }

  function navigate(page) {
    if (!PAGE_META[page]) return;
    if (state.page === page) return;
    if (state.batch?.active) return;
    if (state.batchMode) {
      state.batchMode = false;
      state.batchSelected.clear();
    }
    if (state.page === 'library') state.filters.query = $('#search-input')?.value || '';
    state.page = page;
    toastRoot.innerHTML = '';
    closeDrawer();
    if (state.page !== 'library') {
      navClearSearch();
    } else {
      const input = $('#search-input');
      if (input) input.value = state.filters.query;
    }
    renderPage();
  }

  function navClearSearch() {
    const search = $('#topbar-search');
    if (search) search.classList.add('hidden');
  }

  function setSearchVisible() {
    const search = $('#topbar-search');
    if (search) search.classList.toggle('hidden', state.page !== 'library');
  }

  async function scan() {
    if (state.scanning) return;
    if (state.page !== 'library') {
      state.page = 'library';
    }
    state.scanning = true;
    state.scanError = null;
    state.batchMode = false;
    state.batchSelected.clear();
    state.scanProgress = { stage: 'start', message: '正在扫描已安装应用…' };
    state.analysisGeneration += 1;
    state.analysisProgress = null;
    renderPage();
    view.scrollTop = 0;
    updateChrome();
    try {
      const result = await api.scanApps();
      const manualApps = state.apps.filter((item) => item.source === 'manual' || item.source === 'archive');
      const scannedApps = (result.apps || []).map((app) => ({ ...app }));
      const scannedIds = new Set(scannedApps.map((app) => app.id));
      state.apps = [...manualApps.filter((app) => !scannedIds.has(app.id)), ...scannedApps];
      state.services = result.services || [];
      state.scannedAt = result.scannedAt || new Date().toISOString();
      state.scanning = false;
      state.scanProgress = null;
      state.scanError = null;
      if (state.page === 'library') renderPage();
      updateChrome();
      startBackgroundAnalysis();
    } catch (error) {
      state.scanning = false;
      state.scanProgress = null;
      state.scanError = error.message;
      if (state.page === 'library') renderPage();
      updateChrome();
      toast(`扫描失败：${error.message}`, 'error');
    }
  }

  async function startBackgroundAnalysis() {
    const generation = ++state.analysisGeneration;
    const queue = state.apps.filter((item) => !item.analysis);
    if (!queue.length) {
      state.analysisProgress = null;
      return;
    }
    state.analysisProgress = { active: true, total: queue.length, done: 0 };
    updateScanBanner();
    let cursor = 0;
    let completed = 0;
    const worker = async () => {
      while (cursor < queue.length) {
        if (generation !== state.analysisGeneration) return;
        const app = queue[cursor];
        cursor += 1;
        try {
          const analysis = await api.analyzeApp(app, state.services, true);
          if (generation !== state.analysisGeneration) return;
          if (!app.fullAnalysis) {
            app.analysis = analysis;
            app.grade = analysis.grade;
            delete app.analysisError;
          }
        } catch (error) {
          if (generation !== state.analysisGeneration) return;
          app.analysisError = error.message;
        }
        if (generation !== state.analysisGeneration || !state.analysisProgress) return;
        completed += 1;
        state.analysisProgress.done = completed;
        if (state.page === 'library') {
          updateScanBanner();
          updateStats();
          if (state.filters.grade !== 'all' || state.filters.sort === 'grade') updateList();
          else updateAppRow(app);
        }
        if (state.selectedId === app.id && !state.analysisRefreshing) renderDrawer();
      }
    };
    await Promise.all(Array.from({ length: Math.min(3, queue.length) }, () => worker()));
    if (generation === state.analysisGeneration) {
      state.analysisProgress.active = false;
      updateScanBanner();
      updateStats();
      if (state.page === 'library') updateList();
    }
  }

  function pickExe() {
    if (!api.pickExe) return;
    api.pickExe().then((result) => {
      if (!result?.app) return;
      const app = result.app;
      app.analysis = app.analysis || result.analysis;
      app.fullAnalysis = true;
      state.apps = [app, ...state.apps.filter((item) => item.id !== app.id)];
      state.scanError = null;
      if (state.page !== 'library') {
        state.page = 'library';
      }
      renderPage();
      selectApp(app.id);
      toast(`已选择 ${app.name}`, 'success');
    }).catch((error) => toast(error.message, 'error'));
  }

  function addImportedApp(app) {
    state.apps = [app, ...state.apps.filter((item) => item.id !== app.id)];
    state.scanError = null;
    state.archiveProgress = null;
    renderPage();
    selectApp(app.id);
  }

  async function saveAiSettings() {
    const baseUrl = $('#ai-base-url')?.value.trim() || '';
    const model = $('#ai-model')?.value.trim() || '';
    const keyInput = $('#ai-key');
    const patch = { ai: { baseUrl, model } };
    if (keyInput?.value.trim()) patch.ai.apiKey = keyInput.value.trim();
    if ($('#ai-clear-key')?.checked) patch.ai.clearKey = true;
    try {
      state.settings = await api.setSettings(patch);
      if (keyInput) keyInput.value = '';
      renderSettings();
      toast('AI 接口设置已保存', 'success');
    } catch (error) {
      toast(error.message, 'error');
    }
  }

  async function testAiSettings() {
    try {
      const result = await api.aiTest();
      toast(`连接成功：${result.latencyMs} ms${result.reply ? ` · ${result.reply}` : ''}`, 'success');
    } catch (error) {
      toast(`连接失败：${error.message}`, 'error');
    }
  }

  async function pickMacApp() {
    if (!api.pickMacApp) {
      toast('当前环境不支持导入 macOS 应用', 'warn');
      return;
    }
    if (state.build || state.batch) {
      toast('请先完成当前任务', 'warn');
      return;
    }
    try {
      const picked = await api.pickMacApp();
      if (!picked) return;
      if (state.page !== 'library') state.page = 'library';
      addImportedApp(picked.app);
      toast(`已导入 macOS 应用：${picked.app.name}`, 'success');
      openBuildForApp(picked.app);
    } catch (error) {
      toast(error.message, 'error');
    }
  }

  let aiPanel = null;

  function aiStatusLine(text) {
    const line = document.createElement('div');
    line.className = 'ai-line';
    line.textContent = text;
    if (aiPanel) {
      aiPanel.log.appendChild(line);
      aiPanel.log.scrollTop = aiPanel.log.scrollHeight;
    }
  }

  async function openAiFixPanel(buildId) {
    if (!buildId) {
      toast('缺少构建记录，无法修复', 'warn');
      return;
    }
    if (aiPanel) aiPanel.overlay.remove();
    const overlay = document.createElement('div');
    overlay.className = 'ai-overlay';
    overlay.innerHTML = `
      <div class="ai-panel" role="dialog" aria-label="AI 修复">
        <header><b>AI 修复</b><span class="ai-sub">读取诊断 → 修改配置 → 重新构建</span><button class="icon-btn" data-ai-close aria-label="关闭">✕</button></header>
        <div class="ai-toolbar">
          <button class="btn btn-ghost btn-sm" data-ai-diagnostics>导入 Mac 诊断 ZIP</button>
          <label class="ai-check"><input type="checkbox" data-ai-rebuild checked> 允许 AI 重新构建（最多 2 次）</label>
          <button class="btn btn-primary btn-sm" data-ai-run>开始诊断</button>
        </div>
        <div class="ai-log"></div>
        <footer class="ai-foot"></footer>
      </div>`;
    document.body.appendChild(overlay);
    aiPanel = { overlay, log: overlay.querySelector('.ai-log'), foot: overlay.querySelector('.ai-foot'), diagnosticsPath: '' };
    overlay.querySelector('[data-ai-close]').onclick = () => { overlay.remove(); aiPanel = null; };
    const diagBtn = overlay.querySelector('[data-ai-diagnostics]');
    diagBtn.onclick = async () => {
      try {
        const picked = await api.aiPickDiagnostics();
        if (!picked) return;
        aiPanel.diagnosticsPath = picked.dir;
        aiStatusLine(`已载入诊断包：${picked.dir}`);
        diagBtn.textContent = '已载入诊断包';
      } catch (error) {
        aiStatusLine(`诊断包读取失败：${error.message}`);
      }
    };
    overlay.querySelector('[data-ai-run]').onclick = async (event) => {
      const button = event.currentTarget;
      const allowRebuild = overlay.querySelector('[data-ai-rebuild]').checked;
      button.disabled = true;
      aiStatusLine('正在请求模型…');
      const unsubscribe = api.onAiEvent ? api.onAiEvent((data) => {
        if (!aiPanel) return;
        if (data.type === 'tool') aiStatusLine(`→ ${data.name} ${JSON.stringify(data.arguments || {}).slice(0, 200)}`);
        else if (data.type === 'toolResult') aiStatusLine(`  ${String(data.result || '').split('\n').slice(0, 3).join(' / ').slice(0, 300)}`);
        else if (data.type === 'assistant') aiStatusLine(`模型：${String(data.content || '').slice(0, 400)}`);
        else if (data.type === 'progress') aiStatusLine(`  [${data.stage}] ${data.message || ''}`);
        else if (data.type === 'step') aiStatusLine(`—— 第 ${data.step}/${data.maxSteps} 步 ——`);
      }) : () => {};
      try {
        const result = await api.aiFix({
          buildId,
          diagnosticsPath: aiPanel.diagnosticsPath || undefined,
          maxSteps: allowRebuild ? 8 : 5,
        });
        aiStatusLine('完成');
        aiPanel.foot.innerHTML = `<div class="ai-summary">${esc(result.summary || '模型未给出总结')}</div>`;
      } catch (error) {
        aiStatusLine(`失败：${error.message}`);
      } finally {
        unsubscribe();
        button.disabled = false;
      }
    };
  }

  async function pickArchive() {
    if (!api.pickArchive) {
      toast('当前环境不支持导入压缩包', 'warn');
      return;
    }
    if (state.build || state.batch) {
      toast('请先完成当前任务', 'warn');
      return;
    }
    if (state.page !== 'library') state.page = 'library';
    state.archiveProgress = { message: '请选择应用目录 ZIP…', files: 0 };
    renderPage();
    try {
      const result = await api.pickArchive();
      if (!result?.app) return;
      const app = result.app;
      app.analysis = result.analysis || app.analysis;
      app.fullAnalysis = true;
      state.apps = [app, ...state.apps.filter((item) => item.id !== app.id)];
      state.scanError = null;
      state.archiveProgress = null;
      renderPage();
      selectApp(app.id);
      if (api.loadIcons) {
        api.loadIcons([app]).then((icons) => {
          if (icons?.[app.id]) {
            state.icons[app.id] = icons[app.id];
            updateAppRow(app);
            if (state.selectedId === app.id) renderDrawer();
          }
        }).catch(() => {});
      }
      toast(`已导入压缩包：${app.name}`, 'success');
    } catch (error) {
      toast(error.message, 'error');
    } finally {
      if (state.archiveProgress) {
        state.archiveProgress = null;
        if (state.page === 'library') renderPage();
      }
    }
  }

  async function pickInstaller() {
    if (!api.pickInstaller) {
      toast('当前环境不支持安装包模式', 'warn');
      return;
    }
    try {
      const result = await api.pickInstaller();
      if (!result?.app) return;
      closeDrawer();
      state.build = createBuildState(result.app, result.installer);
      if (state.pendingRecipe) {
        const recipe = state.pendingRecipe;
        state.pendingRecipe = null;
        applyRecipeOptions(state.build, recipe);
        toastRecipeApplied(recipe, result.app);
      }
      renderModal();
    } catch (error) {
      toast(error.message, 'error');
    }
  }

  const dropOverlay = $('#drop-overlay');
  let dragDepth = 0;

  function canAcceptDrop() {
    return !state.build && !state.batch && !state.selectedId && state.page === 'library';
  }

  function showDropOverlay(show) {
    if (!dropOverlay) return;
    dropOverlay.classList.toggle('visible', show);
    dropOverlay.setAttribute('aria-hidden', show ? 'false' : 'true');
  }

  function resetDropOverlay() {
    dragDepth = 0;
    showDropOverlay(false);
  }

  async function inspectDropped(target) {
    if (!target) {
      toast('无法读取拖入文件的路径', 'warn');
      return;
    }
    if (state.build || state.batch) {
      toast('请先完成或关闭当前窗口，再拖入新的应用', 'info');
      return;
    }
    if (!api.inspectPath) {
      toast('当前环境不支持拖拽导入', 'warn');
      return;
    }
    toast('正在识别拖入的内容…', 'info');
    try {
      const result = await api.inspectPath(target);
      if (!result?.app) return;
      if (result.kind === 'installer') {
        closeDrawer();
        state.build = createBuildState(result.app, result.installer);
        if (state.pendingRecipe) {
          const recipe = state.pendingRecipe;
          state.pendingRecipe = null;
          applyRecipeOptions(state.build, recipe);
          toastRecipeApplied(recipe, result.app);
        }
        renderModal();
        toast('已识别为安装程序，将使用安装器模式', 'success');
        return;
      }
      const app = result.app;
      app.analysis = result.analysis || app.analysis;
      app.fullAnalysis = true;
      state.apps = [app, ...state.apps.filter((item) => item.id !== app.id)];
      state.scanError = null;
      state.archiveProgress = null;
      if (state.page !== 'library') state.page = 'library';
      renderPage();
      selectApp(app.id);
      if (result.archive) {
        toast(`已从压缩包导入 ${app.name}`, 'success');
      } else {
        const chosen = result.drop?.chosenExe ? baseName(result.drop.chosenExe) : '';
        toast(chosen ? `已添加 ${app.name} · 主程序 ${chosen}` : `已添加 ${app.name}`, 'success');
      }
    } catch (error) {
      state.archiveProgress = null;
      if (state.page === 'library') updateScanBanner();
      toast(`无法导入：${error.message}`, 'error');
    }
  }

  function bindDragAndDrop() {
    if (!dropOverlay) return;
    document.addEventListener('dragenter', (event) => {
      if (!canAcceptDrop() || !Array.from(event.dataTransfer?.types || []).includes('Files')) return;
      event.preventDefault();
      dragDepth += 1;
      showDropOverlay(true);
    });
    document.addEventListener('dragover', (event) => {
      if (!canAcceptDrop() || !Array.from(event.dataTransfer?.types || []).includes('Files')) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
    });
    document.addEventListener('dragleave', (event) => {
      if (!Array.from(event.dataTransfer?.types || []).includes('Files')) return;
      dragDepth = Math.max(0, dragDepth - 1);
      if (dragDepth === 0) showDropOverlay(false);
    });
    document.addEventListener('drop', (event) => {
      if (!Array.from(event.dataTransfer?.types || []).includes('Files')) return;
      event.preventDefault();
      resetDropOverlay();
      const file = event.dataTransfer?.files?.[0];
      if (!file) return;
      if (!canAcceptDrop()) {
        toast('请先关闭当前窗口，再拖入新的应用', 'info');
        return;
      }
      const target = api.pathForFile ? api.pathForFile(file) : file.name;
      inspectDropped(target);
    });
    document.addEventListener('dragend', resetDropOverlay);
    window.addEventListener('blur', resetDropOverlay);
  }

  function toggleBatchMode() {    state.batchMode = !state.batchMode;
    if (!state.batchMode) state.batchSelected.clear();
    renderLibrary();
    updateChrome();
  }

  function refreshBatchBar() {
    const count = document.querySelector('#batch-count');
    if (count) count.textContent = String(state.batchSelected.size);
    const start = document.querySelector('[data-action="batch-start"]');
    if (start) start.disabled = state.batchSelected.size === 0;
  }

  function toggleBatchApp(id) {
    const app = state.apps.find((item) => item.id === id);
    if (!app) return;
    if (!app.exePath) {
      toast('该应用没有可启动的 .exe，无法批量转换', 'warn');
      return;
    }
    if (state.batchSelected.has(id)) state.batchSelected.delete(id);
    else state.batchSelected.add(id);
    const row = document.querySelector(`[data-app-row="${CSS.escape(id)}"]`);
    if (row) {
      const selected = state.batchSelected.has(id);
      row.classList.toggle('selected', selected);
      const check = row.querySelector('.row-check');
      if (check) {
        check.classList.toggle('on', selected);
        check.innerHTML = selected ? '<svg class="icon"><use href="#i-check"></use></svg>' : '';
      }
    }
    refreshBatchBar();
  }

  function batchSelectAll() {
    for (const app of filteredApps()) {
      if (app.exePath) state.batchSelected.add(app.id);
    }
    updateList();
    refreshBatchBar();
  }

  function exitBatchMode() {
    state.batchMode = false;
    state.batchSelected.clear();
    renderLibrary();
    updateChrome();
  }

  function batchLocalProgress(event, current) {
    if (state.demo) return Math.max(current, Math.min(100, Number(event.percent) || 0));
    const range = STAGE_RANGE[event.stage];
    if (!range) return current;
    const percent = Number.isFinite(Number(event.percent)) ? Math.min(100, Math.max(0, Number(event.percent))) : 0;
    return Math.max(current, Math.min(100, Math.round(range[0] + ((range[1] - range[0]) * percent) / 100)));
  }

  function handleBatchProgress(event) {
    const batch = state.batch;
    if (!batch?.active) return;
    const item = batch.items[batch.index];
    if (!item || item.status !== 'active') return;
    item.progress = batchLocalProgress(event, item.progress || 0);
    batch.overall = Math.round(((batch.index + item.progress / 100) / batch.total) * 100);
    batch.lastMessage = event.message || batch.lastMessage;
    const last = batch.log[batch.log.length - 1];
    if (event.message && (!last || last.stage !== event.stage || last.message !== event.message)) {
      batch.log.push({ app: item.app.name, stage: event.stage, message: event.message });
      if (batch.log.length > 80) batch.log.shift();
    }
    const percent = document.querySelector('#batch-overall-percent');
    if (percent) percent.innerHTML = `${batch.overall}<span>%</span>`;
    const bar = document.querySelector('#batch-overall-bar');
    if (bar) bar.style.width = `${batch.overall}%`;
    const message = document.querySelector('#batch-current-message');
    if (message) message.textContent = `${item.app.name}${batch.lastMessage ? ` · ${batch.lastMessage}` : ''}`;
    const row = document.querySelector(`[data-batch-index="${batch.index}"]`);
    if (row) {
      const status = row.querySelector('.batch-item-status');
      if (status) status.textContent = `${item.progress}%`;
      const mini = row.querySelector('.batch-item-progress i');
      if (mini) mini.style.width = `${item.progress}%`;
    }
    const logEl = document.querySelector('#batch-log');
    if (logEl) {
      logEl.innerHTML = batch.log.slice(-12).map((line) => `<span class="log-stage">${esc(line.app)}</span> ${esc(line.message)}`).join('\n');
      logEl.scrollTop = logEl.scrollHeight;
    }
  }

  function renderBatchModal() {
    const batch = state.batch;
    if (!batch) {
      modalRoot.innerHTML = '';
      syncOverlayLock();
      return;
    }
    const done = !batch.active;
    const current = batch.items[batch.index];
    const completed = batch.items.filter((item) => item.status === 'done').length;
    const failed = batch.items.filter((item) => item.status === 'error').length;
    modalRoot.innerHTML = `
      <div class="modal-scrim">
        <div class="modal batch-modal" role="dialog" aria-modal="true" aria-label="批量转换" tabindex="-1">
          <div class="modal-head">
            <span class="batch-head-icon"><svg class="icon"><use href="#i-layers"></use></svg></span>
            <div class="modal-title"><h3>${done ? (batch.cancelled ? '批量转换已停止' : '批量转换完成') : '正在批量转换'}</h3><p>${batch.total} 个应用 · 顺序执行 · 输出到 ${esc(batch.outputDir)}</p></div>
          </div>
          <div class="modal-body">
            <div class="progress-hero">
              <div class="progress-top">
                <div><div class="progress-percent" id="batch-overall-percent">${batch.overall}<span>%</span></div><div class="progress-stage-label">${done ? (batch.cancelled ? '已停止' : '全部完成') : `第 ${batch.index + 1} / ${batch.total} 个`}</div></div>
                <div style="text-align:right"><div class="progress-stage-message" id="batch-current-message">${esc(current ? `${current.app.name}${batch.lastMessage ? ` · ${batch.lastMessage}` : ''}` : '')}</div><div class="progress-note"><svg class="icon"><use href="#i-lock"></use></svg>本地构建 · 不上传</div></div>
              </div>
              <div class="progress-bar"><i id="batch-overall-bar" style="width:${batch.overall}%"></i></div>
            </div>
            <div class="batch-list">
              ${batch.items.map((item, index) => `
                <div class="batch-item ${item.status}" data-batch-index="${index}">
                  ${iconHtml(item.app)}
                  <div class="batch-item-main"><b>${esc(item.app.name)}</b><span>${esc([item.app.publisher, item.app.version ? `v${item.app.version}` : ''].filter(Boolean).join(' · ') || 'Windows 应用')}</span></div>
                  <span class="batch-item-progress"><i style="width:${item.progress || 0}%"></i></span>
                  <span class="batch-item-status" title="${esc(item.error || '')}">${item.status === 'pending' ? '等待' : item.status === 'active' ? `${item.progress || 0}%` : item.status === 'done' ? '完成' : item.status === 'skipped' ? '已跳过' : '失败'}</span>
                </div>`).join('')}
            </div>
            <div class="log-box" id="batch-log">${batch.log.slice(-12).map((line) => `<span class="log-stage">${esc(line.app)}</span> ${esc(line.message)}`).join('\n')}</div>
          </div>
          <div class="modal-foot">
            ${done
              ? `<div class="foot-note">完成 ${completed} 个${failed ? ` · 失败 ${failed} 个` : ''}${batch.cancelled ? ' · 已按请求停止剩余任务' : ''}</div>
                 <button class="btn btn-ghost" data-action="open-output">打开输出目录</button>
                 <button class="btn btn-accent" data-action="batch-done">完成</button>`
              : `<div class="foot-note">当前任务完成后才会停止；构建期间请保持窗口打开。</div>
                 <button class="btn btn-ghost" data-action="batch-stop" ${batch.cancelled ? 'disabled' : ''}>${batch.cancelled ? '停止中…' : '停止剩余'}</button>`}
          </div>
        </div>
      </div>`;
    syncOverlayLock();
    requestAnimationFrame(() => modalRoot.querySelector('.modal')?.focus());
  }

  function stopBatch() {
    if (!state.batch?.active || state.batch.cancelled) return;
    state.batch.cancelled = true;
    renderBatchModal();
    toast('将在当前应用完成后停止剩余任务', 'info');
  }

  function closeBatch() {
    if (!state.batch || state.batch.active) return;
    state.batch = null;
    modalRoot.innerHTML = '';
    state.batchMode = false;
    state.batchSelected.clear();
    syncOverlayLock();
    updateChrome();
    renderPage();
  }

  async function startBatch() {
    const apps = state.apps.filter((app) => state.batchSelected.has(app.id) && app.exePath);
    if (!apps.length) {
      toast('请先选择至少一个可转换的应用', 'warn');
      return;
    }
    const outputDir = state.settings?.outputDir;
    if (!outputDir) {
      toast('请先在设置中选择输出目录', 'warn');
      return;
    }
    const items = apps.map((app) => ({ app, status: 'pending', progress: 0, result: null, error: null }));
    state.batch = {
      active: true,
      cancelled: false,
      index: 0,
      total: items.length,
      items,
      overall: 0,
      lastMessage: '',
      log: [],
      results: [],
      outputDir,
    };
    state.batchMode = false;
    state.batchSelected.clear();
    renderBatchModal();
    for (let index = 0; index < items.length; index += 1) {
      if (state.batch.cancelled) break;
      const item = items[index];
      state.batch.index = index;
      state.batch.overall = Math.round((index / items.length) * 100);
      state.batch.lastMessage = '';
      item.status = 'active';
      item.progress = 0;
      renderBatchModal();
      try {
        const result = await api.startBuild({
          app: item.app,
          services: state.services,
          outputDir,
          engineMode: state.settings.engineMode,
          includeRuntimes: state.settings.includeRuntimes,
          includeWineMono: state.settings.includeWineMono,
          includeUserData: false,
          proxy: state.settings.proxy,
          advanced: {},
        });
        item.status = 'done';
        item.progress = 100;
        item.result = result;
        state.batch.results.push(result);
      } catch (error) {
        item.status = 'error';
        item.error = error.message;
        state.batch.log.push({ app: item.app.name, stage: 'error', message: error.message });
      }
      state.batch.overall = Math.round(((index + 1) / items.length) * 100);
      renderBatchModal();
    }
    if (state.batch.cancelled) {
      for (const item of state.batch.items) {
        if (item.status === 'pending') item.status = 'skipped';
      }
    }
    state.batch.active = false;
    try {
      state.history = await api.history();
    } catch {
      /* history refresh is best-effort */
    }
    updateChrome();
    renderBatchModal();
    const failed = state.batch.items.filter((item) => item.status === 'error').length;
    const completed = state.batch.items.filter((item) => item.status === 'done').length;
    toast(`批量转换结束：完成 ${completed} 个${failed ? `，失败 ${failed} 个` : ''}`, failed ? 'warn' : 'success');
  }

  async function startBuild() {
    const build = state.build;
    if (!build) return;
    if (!build.options.outputDir) {
      toast('请选择输出目录', 'warn');
      return;
    }
    build.step = 'progress';
    build.progress = 0;
    build.stage = 'start';
    build.stageLabel = '准备开始';
    build.message = '正在准备转换…';
    build.log = [];
    renderModal();
    if (build.app?.platform === 'mac') {
      try {
        const result = await api.buildWindowsApp({
          app: build.app,
          macAnalysis: build.app.macAnalysis,
          outputDir: build.options.outputDir,
          electronVersion: build.app.macAnalysis?.electronVersion,
        });
        build.result = result;
        build.step = 'done';
        build.progress = 100;
        state.history = await api.history();
        updateChrome();
        renderModal();
        if (state.page === 'tasks') renderTasks();
        toast('已生成 Windows 免安装包', 'success');
      } catch (error) {
        build.step = 'error';
        build.error = error.message;
        renderModal();
      }
      return;
    }
    const payload = {
      app: build.app,
      services: state.services,
      outputDir: build.options.outputDir,
      engineMode: build.options.engineMode,
      includeRuntimes: build.options.includeRuntimes,
      includeWineMono: build.options.includeWineMono,
      includeUserData: build.installer ? false : build.options.includeUserData,
      manualEngineArchive: build.options.manualEngineArchive,
      installer: build.installer
        ? { ...build.installer, args: build.options.installerArgs, expectedExe: build.options.expectedExe }
        : null,
      advanced: build.options.advanced,
    };
    try {
      const patch = {
        outputDir: build.options.outputDir,
        engineMode: build.options.engineMode,
        includeRuntimes: build.options.includeRuntimes,
        includeWineMono: build.options.includeWineMono,
        includeUserData: build.options.includeUserData,
      };
      state.settings = await api.setSettings(patch);
      const result = await api.startBuild(payload);
      build.result = result;
      build.step = 'done';
      build.progress = 100;
      state.history = await api.history();
      updateChrome();
      renderModal();
      if (state.page === 'tasks') renderTasks();
      toast('打包完成，已生成 .app 与 ZIP', 'success');
    } catch (error) {
      build.step = 'error';
      build.error = error.message;
      renderModal();
    }
  }

  function buildOverall(event) {
    const build = state.build;
    if (!build) return 0;
    if (state.demo) return Math.max(build.progress, Math.min(100, Number(event.percent) || 0));
    const range = STAGE_RANGE[event.stage];
    if (!range) return build.progress;
    const stagePercent = Number.isFinite(Number(event.percent)) ? Math.min(100, Math.max(0, Number(event.percent))) : 0;
    const overall = range[0] + ((range[1] - range[0]) * stagePercent) / 100;
    return Math.max(build.progress, Math.min(100, Math.round(overall)));
  }

  function handleBuildProgress(event) {
    const build = state.build;
    if (!build || build.step !== 'progress') return;
    build.progress = buildOverall(event);
    build.stage = event.stage || build.stage;
    build.message = event.message || build.message;
    const alias = STAGE_ALIAS[event.stage];
    const stageDef = STAGE_DEFS.find(([stage]) => stage === alias);
    build.stageLabel = stageDef ? stageDef[1] : build.stageLabel;
    const last = build.log[build.log.length - 1];
    if (event.message && (!last || last.stage !== event.stage || last.message !== event.message)) {
      build.log.push({ stage: event.stage, message: event.message });
      if (build.log.length > 80) build.log.shift();
    }
    const percentEl = $('#b-progress-percent');
    if (percentEl) percentEl.innerHTML = `${build.progress}<span>%</span>`;
    const bar = $('#b-progress-bar');
    if (bar) bar.style.width = `${build.progress}%`;
    const stageEl = $('#b-progress-stage');
    if (stageEl) stageEl.textContent = build.stageLabel || '处理中';
    const messageEl = $('#b-progress-message');
    if (messageEl) messageEl.textContent = event.message || '';
    const stageIndex = STAGE_DEFS.findIndex(([stage]) => stage === alias);
    $$('#b-stage-list .stage-item').forEach((item, index) => {
      item.classList.toggle('done', index < stageIndex);
      item.classList.toggle('active', index === stageIndex);
      const dot = $('.stage-dot', item);
      if (dot) dot.textContent = index < stageIndex ? '✓' : '';
    });
    const logEl = $('#b-log');
    if (logEl) {
      logEl.innerHTML = build.log.slice(-10).map((line) => `<span class="log-stage">[${esc(line.stage)}]</span> <span class="log-msg">${esc(line.message)}</span>`).join('\n');
      logEl.scrollTop = logEl.scrollHeight;
    }
  }

  function toast(message, type = 'success') {
    const id = ++toastCounter;
    const icon = type === 'error' ? 'alert' : type === 'warn' ? 'alert' : type === 'info' ? 'info' : 'check';
    const el = document.createElement('div');
    el.className = `toast ${type}`;
    el.dataset.toastId = String(id);
    el.innerHTML = `<svg class="icon"><use href="#i-${icon}"></use></svg><span>${esc(message)}</span>`;
    toastRoot.appendChild(el);
    setTimeout(() => {
      el.style.opacity = '0';
      el.style.transform = 'translateY(4px)';
      el.style.transition = 'opacity .18s ease, transform .18s ease';
      setTimeout(() => el.remove(), 200);
    }, 3600);
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      toast('已复制路径');
    } catch {
      toast('复制失败，请手动选择路径', 'warn');
    }
  }

  async function pickOutput() {
    try {
      const selected = await api.pickOutput(state.build?.options.outputDir || state.settings?.outputDir || '');
      if (!selected) return;
      if (state.build) {
        state.build.options.outputDir = selected;
        state.settings = { ...state.settings, outputDir: selected };
        renderModal();
      } else {
        state.settings = await api.setSettings({ outputDir: selected });
        if (state.page === 'settings') renderSettings();
      }
      toast('输出目录已更新');
    } catch (error) {
      toast(error.message, 'error');
    }
  }

  async function pickEngineArchive() {
    if (!api.pickEngineArchive) return;
    try {
      const file = await api.pickEngineArchive();
      if (!file) return;
      if (state.build) {
        state.build.options.manualEngineArchive = file;
        state.build.options.engineMode = 'bundled';
        renderModal();
        toast('已选择本地引擎包，将随安装包写入');
      }
    } catch (error) {
      toast(error.message, 'error');
    }
  }

  async function openPath(path) {
    if (!path) return;
    if (!api.isDesktop) {
      toast('浏览器演示模式不会创建真实文件。', 'warn');
      return;
    }
    const error = await api.openPath(path);
    if (typeof error === 'string' && error) toast(error, 'error');
  }

  async function showInFolder(path) {
    if (!api.isDesktop) {
      toast('浏览器演示模式不会创建真实文件。', 'warn');
      return;
    }
    if (path) await api.showInFolder(path);
  }

  async function clearHistory() {
    if (!state.history.length) return;
    try {
      state.history = await api.clearHistory();
      updateChrome();
      if (state.page === 'tasks') renderTasks();
      toast('转换记录已清空');
    } catch (error) {
      toast(error.message, 'error');
    }
  }

  async function saveSetting(patch, rerender = false) {
    try {
      state.settings = await api.setSettings(patch);
      if (rerender) {
        if (state.page === 'settings') renderSettings();
      }
      toast('设置已保存');
    } catch (error) {
      toast(error.message, 'error');
    }
  }

  async function saveSettingQuiet(patch) {
    try {
      state.settings = await api.setSettings(patch);
    } catch {
      /* 输入过程中的静默保存失败不打断输入 */
    }
  }

  async function runDiagnostics() {
    const list = $('#diagnostic-list');
    if (list) list.innerHTML = '<div class="diagnostic"><span class="dot"></span>正在检查…</div>';
    try {
      const result = await api.diagnostics();
      if (!list) return;
      list.innerHTML = result.checks.map((item) => `<div class="diagnostic ${item.status === 'ok' ? '' : 'warn'}"><span class="dot"></span><span>${esc(item.name)}</span><span class="diag-detail">${esc(item.detail)}</span></div>`).join('');
    } catch (error) {
      if (list) list.innerHTML = `<div class="diagnostic warn"><span class="dot"></span>检查失败：${esc(error.message)}</div>`;
    }
  }

  function handleAction(action, element) {
    switch (action) {
      case 'scan':
        scan();
        break;
      case 'pick-exe':
        pickExe();
        break;
      case 'pick-installer':
        pickInstaller();
        break;
      case 'pick-archive':
        pickArchive();
        break;
      case 'pick-mac-app':
        pickMacApp();
        break;
      case 'ai-fix':
        openAiFixPanel(element?.dataset?.buildId || state.build?.result?.buildId || '');
        break;
      case 'save-ai':
        saveAiSettings();
        break;
      case 'test-ai':
        testAiSettings();
        break;
      case 'import-recipe':
        importRecipe();
        break;
      case 'export-recipe':
        exportRecipe();
        break;
      case 'clear-pending-recipe':
        clearPendingRecipe();
        break;
      case 'refresh-cache':
        loadCacheStats();
        break;
      case 'clear-cache':
        clearCache(String(element?.dataset?.cacheKeys || '').split(',').map((key) => key.trim()).filter(Boolean));
        break;
      case 'toggle-batch':
        toggleBatchMode();
        break;
      case 'batch-select-all':
        batchSelectAll();
        break;
      case 'batch-exit':
        exitBatchMode();
        break;
      case 'batch-start':
        startBatch();
        break;
      case 'batch-stop':
        stopBatch();
        break;
      case 'batch-done':
        closeBatch();
        break;
      case 'pick-app-exe':
        reselectExe();
        break;
      case 'retry-analysis': {
        const app = state.apps.find((item) => item.id === state.selectedId);
        if (app) {
          app.fullAnalysis = false;
          app.analysisError = null;
          loadFullAnalysis(app, true);
        }
        break;
      }
      case 'reset-filters':
        state.filters.query = '';
        state.filters.grade = 'all';
        if (searchInput) searchInput.value = '';
        $$('[data-filter-grade]').forEach((item) => item.classList.toggle('active', item.dataset.filterGrade === 'all'));
        updateList();
        break;
      case 'minimize':
        if (api.isDesktop) api.minimize(); else toast('请在桌面应用中使用窗口控制', 'info');
        break;
      case 'maximize':
        if (api.isDesktop) api.toggleMaximize(); else toast('请在桌面应用中使用窗口控制', 'info');
        break;
      case 'close':
        if (api.isDesktop) api.close(); else toast('浏览器演示不会关闭窗口', 'info');
        break;
      case 'close-drawer':
        closeDrawer();
        break;
      case 'show-install': {
        const app = state.apps.find((item) => item.id === state.selectedId);
        if (app) showInFolder(app.installPath);
        break;
      }
      case 'open-build':
        openBuildModal();
        break;
      case 'convert-app': {
        const app = state.apps.find((item) => item.id === element?.dataset?.convertId);
        if (app) openBuildForApp(app);
        break;
      }
      case 'pick-output':
        pickOutput();
        break;
      case 'pick-engine-archive':
        pickEngineArchive();
        break;
      case 'start-build':
        startBuild();
        break;
      case 'close-modal':
        closeBuildModal();
        break;
      case 'done-close':
        state.build = null;
        modalRoot.innerHTML = '';
        closeDrawer();
        break;
      case 'retry-build':
        if (state.build) {
          state.build.step = 'setup';
          state.build.error = null;
          state.build.progress = 0;
          renderModal();
        }
        break;
      case 'open-output':
        openPath(state.build?.result?.folderPath || state.batch?.results?.[0]?.folderPath || state.batch?.outputDir || state.build?.options?.outputDir);
        break;
      case 'show-zip':
        showInFolder(element?.dataset?.path || state.build?.result?.zipPath || state.build?.result?.folderPath);
        break;
      case 'open-folder':
        openPath(element?.dataset?.path);
        break;
      case 'clear-history':
        clearHistory();
        break;
      case 'run-diagnostics':
        runDiagnostics();
        break;
      case 'modal-backdrop':
        if (state.build?.step !== 'progress') closeBuildModal();
        break;
      default:
        break;
    }
  }

  document.addEventListener('click', (event) => {
    const nav = event.target.closest('[data-nav]');
    if (nav) {
      navigate(nav.dataset.nav);
      return;
    }
    const copy = event.target.closest('[data-copy]');
    if (copy) {
      copyText(copy.dataset.copy);
      return;
    }
    const external = event.target.closest('[data-external]');
    if (external) {
      api.openExternal?.(external.dataset.external);
      return;
    }
    const row = event.target.closest('[data-app-id]');
    if (row && !event.target.closest('button')) {
      if (state.batchMode) toggleBatchApp(row.dataset.appId);
      else selectApp(row.dataset.appId);
      return;
    }
    const filter = event.target.closest('[data-filter-grade]');
    if (filter) {
      state.filters.grade = filter.dataset.filterGrade;
      $$('[data-filter-grade]').forEach((item) => item.classList.toggle('active', item.dataset.filterGrade === state.filters.grade));
      updateList();
      return;
    }
    const advToggle = event.target.closest('[data-adv-toggle]');
    if (advToggle && state.build?.options?.advanced) {
      const key = advToggle.dataset.advToggle;
      state.build.options.advanced[key] = !state.build.options.advanced[key];
      advToggle.classList.toggle('on', state.build.options.advanced[key]);
      advToggle.setAttribute('aria-pressed', String(state.build.options.advanced[key]));
      return;
    }
    const engineMode = event.target.closest('[data-engine-mode]');
    if (engineMode && state.build) {
      state.build.options.engineMode = engineMode.dataset.engineMode;
      if (state.build.options.engineMode !== 'bundled') state.build.options.manualEngineArchive = '';
      renderModal();
      return;
    }
    const toggle = event.target.closest('[data-toggle-option]');
    if (toggle && state.build) {
      const key = toggle.dataset.toggleOption;
      state.build.options[key] = !state.build.options[key];
      renderModal();
      return;
    }
    if (event.target.closest('[data-setting-engine]')) {
      const mode = event.target.closest('[data-setting-engine]').dataset.settingEngine;
      saveSetting({ engineMode: mode }, true);
      return;
    }
    if (event.target.closest('[data-setting-toggle]')) {
      const key = event.target.closest('[data-setting-toggle]').dataset.settingToggle;
      saveSetting({ [key]: !state.settings[key] }, true);
      return;
    }
    const actionEl = event.target.closest('[data-action]');
    if (actionEl) {
      if (actionEl.dataset.action === 'modal-backdrop' && event.target !== actionEl) return;
      handleAction(actionEl.dataset.action, actionEl);
    }
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      if (state.build?.open) {
        if (state.build.step !== 'progress') closeBuildModal();
      } else if (state.batch) {
        if (!state.batch.active) closeBatch();
      } else if (state.selectedId) {
        closeDrawer();
      }
      return;
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
      if (state.selectedId || state.build?.open) return;
      event.preventDefault();
      if (state.page !== 'library') navigate('library');
      const input = $('#search-input');
      input?.focus();
      input?.select();
      return;
    }
    if ((event.key === 'Enter' || event.key === ' ') && document.activeElement?.matches('[data-app-id]')) {
      event.preventDefault();
      if (state.batchMode) toggleBatchApp(document.activeElement.dataset.appId);
      else selectApp(document.activeElement.dataset.appId);
    }
  });

  const searchInput = $('#search-input');
  if (searchInput) {
    searchInput.addEventListener('input', () => {
      state.filters.query = searchInput.value;
      if (state.page === 'library') {
        updateList();
        const count = $('#result-count');
        if (count) count.textContent = `${filteredApps().length} 个结果`;
      }
    });
  }

  document.addEventListener('input', (event) => {
    if (!state.build?.options?.advanced) return;
    if (event.target.id === 'adv-launch-args') state.build.options.advanced.launchArgs = event.target.value;
    if (event.target.id === 'adv-env') state.build.options.advanced.envText = event.target.value;
    if (event.target.id === 'installer-args') {
      state.build.options.installerArgs = event.target.value;
      state.build.options.installerArgsPreset = 'custom';
      const preset = $('#installer-preset');
      if (preset) preset.value = 'custom';
    }
    if (event.target.id === 'expected-exe') state.build.options.expectedExe = event.target.value;
  });

  document.addEventListener('change', (event) => {
    if (event.target.id === 'sort-select') {
      state.filters.sort = event.target.value;
      updateList();
    }
    if (event.target.id === 'proxy-input') {
      clearTimeout(proxySaveTimer);
      proxySaveTimer = setTimeout(() => saveSettingQuiet({ proxy: event.target.value.trim() }), 450);
    }
    if (event.target.id === 'adv-winedebug' && state.build?.options?.advanced) {
      state.build.options.advanced.wineDebug = event.target.value;
    }
    if (event.target.id === 'installer-preset' && state.build) {
      const preset = event.target.value;
      state.build.options.installerArgsPreset = preset;
      const presets = { interactive: '', nsis: '/S', inno: '/VERYSILENT /SUPPRESSMSGBOXES /NORESTART', msi: '/qn /norestart' };
      if (preset !== 'custom' && Object.prototype.hasOwnProperty.call(presets, preset)) {
        state.build.options.installerArgs = presets[preset];
        const input = $('#installer-args');
        if (input) input.value = presets[preset];
      }
    }
  });

  if (api.onScanProgress) {
    api.onScanProgress((progress) => {
      state.scanProgress = progress;
      if (state.page === 'library') updateScanBanner();
    });
  }
  if (api.onArchiveProgress) {
    api.onArchiveProgress((progress) => {
      state.archiveProgress = progress;
      if (state.page === 'library') updateScanBanner();
    });
  }
  if (api.onBuildProgress) api.onBuildProgress((progress) => {
    handleBuildProgress(progress);
    handleBatchProgress(progress);
  });
  if (api.onWindowsProgress) api.onWindowsProgress((progress) => {
    handleBuildProgress(progress);
  });
  if (api.onIcons) {
    api.onIcons((icons) => {
      if (!icons || icons.__error) return;
      state.icons = { ...state.icons, ...icons };
      $$('[data-icon-id]').forEach((el) => {
        const app = state.apps.find((item) => item.id === el.dataset.iconId);
        if (app) {
          const parent = el.parentElement;
          el.outerHTML = iconHtml(app);
          void parent;
        }
      });
      if (state.selectedId) renderDrawer();
    });
  }
  if (api.onWindowState) api.onWindowState(() => {});

  async function init() {
    const smokeMode = new URLSearchParams(location.search).has('smoke');
    try {
      const [info, settings, history] = await Promise.all([api.info(), api.getSettings(), api.history()]);
      state.info = info;
      state.settings = settings;
      state.history = history || [];
      if (info.isDemo) state.demo = true;
      updateChrome();
      renderPage();
      bindDragAndDrop();
      if (!smokeMode) scan();
    } catch (error) {
      view.innerHTML = `<div class="page"><div class="empty-state"><h3>启动失败</h3><p>${esc(error.message)}</p></div></div>`;
    }
  }

  init();
})();
