'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');

function subscribe(channel, callback) {
  const handler = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

contextBridge.exposeInMainWorld('win2mac', {
  isDesktop: true,
  info: () => ipcRenderer.invoke('app:info'),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),
  scanApps: () => ipcRenderer.invoke('apps:scan'),
  analyzeApp: (app, services, light = false) => ipcRenderer.invoke('apps:analyze', { app, services, light }),
  loadIcons: (apps) => ipcRenderer.invoke('apps:icons', apps),
  startBuild: (payload) => ipcRenderer.invoke('build:start', payload),
  pickExe: () => ipcRenderer.invoke('dialog:exe'),
  pickAppExe: (app, services) => ipcRenderer.invoke('dialog:app-exe', { app, services }),
  pickInstaller: () => ipcRenderer.invoke('dialog:installer'),
  pickArchive: () => ipcRenderer.invoke('dialog:archive'),
  inspectPath: (target) => ipcRenderer.invoke('apps:inspect-path', target),
  pathForFile: (file) => {
    try {
      return webUtils.getPathForFile(file);
    } catch {
      return '';
    }
  },
  pickOutput: (defaultPath) => ipcRenderer.invoke('dialog:output', defaultPath || ''),
  pickEngineArchive: () => ipcRenderer.invoke('dialog:engine-archive'),
  exportRecipe: (payload) => ipcRenderer.invoke('recipe:export', payload),
  importRecipe: () => ipcRenderer.invoke('recipe:import'),
  cacheStats: () => ipcRenderer.invoke('cache:stats'),
  clearCache: (keys) => ipcRenderer.invoke('cache:clear', keys),
  history: () => ipcRenderer.invoke('history:list'),
  clearHistory: () => ipcRenderer.invoke('history:clear'),
  openPath: (target) => ipcRenderer.invoke('shell:open', target),
  showInFolder: (target) => ipcRenderer.invoke('shell:show', target),
  openExternal: (url) => ipcRenderer.invoke('shell:open-external', url),
  diagnostics: () => ipcRenderer.invoke('diagnostics:run'),
  minimize: () => ipcRenderer.invoke('window:minimize'),
  toggleMaximize: () => ipcRenderer.invoke('window:toggle-maximize'),
  close: () => ipcRenderer.invoke('window:close'),
  onScanProgress: (callback) => subscribe('scan:progress', callback),
  onArchiveProgress: (callback) => subscribe('archive:progress', callback),
  onBuildProgress: (callback) => subscribe('build:progress', callback),
  onBuildComplete: (callback) => subscribe('build:complete', callback),
  onBuildError: (callback) => subscribe('build:error', callback),
  onIcons: (callback) => subscribe('apps:icons', callback),
  onWindowState: (callback) => subscribe('window:state', callback),
});
