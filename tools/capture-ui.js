'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('force-device-scale-factor', '1');

const OUT = path.join(__dirname, '..', 'docs', 'screenshots');
const WIDTH = Number(process.env.WIN2MAC_CAPTURE_WIDTH) || 1440;
const HEIGHT = Number(process.env.WIN2MAC_CAPTURE_HEIGHT) || 900;
const PREFIX = process.env.WIN2MAC_CAPTURE_PREFIX || '';
let win;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function capture(name) {
  await sleep(450);
  const image = await win.webContents.capturePage({ x: 0, y: 0, width: WIDTH, height: HEIGHT });
  const file = path.join(OUT, `${PREFIX}${name}.png`);
  fs.writeFileSync(file, image.toPNG());
  console.log(file);
}

async function waitFor(expr, timeout = 8000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const ok = await win.webContents.executeJavaScript(`(() => { try { return Boolean(${expr}); } catch { return false; } })()`);
    if (ok) return true;
    await sleep(150);
  }
  throw new Error(`Timeout waiting for ${expr}`);
}

async function click(selector) {
  const result = await win.webContents.executeJavaScript(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false; el.click(); return true; })()`);
  if (!result) throw new Error(`Missing element ${selector}`);
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  win = new BrowserWindow({
    width: WIDTH,
    height: HEIGHT,
    useContentSize: true,
    show: false,
    frame: false,
    backgroundColor: '#f7f6f2',
    webPreferences: {
      offscreen: true,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.webContents.setFrameRate(30);
  await win.loadFile(path.join(__dirname, '..', 'app', 'index.html'));
  await win.webContents.insertCSS('*{animation-duration:0s!important;transition-duration:0s!important;}');
  await waitFor("document.querySelectorAll('[data-app-row]').length > 0", 12000);
  await capture('01-library');

  await click('[data-app-id="demo-0"]');
  await waitFor("document.querySelector('.drawer')", 5000);
  await capture('02-app-detail');

  await click('[data-action="open-build"]');
  await waitFor("document.querySelector('.engine-options')", 5000);
  await capture('03-build-options');
  await click('.advanced-box summary');
  await capture('03b-build-advanced');
  await click('.advanced-box summary');

  await click('[data-action="start-build"]');
  await sleep(2500);
  await capture('04-build-progress');
  await waitFor("document.querySelector('.done-view')", 15000);
  await capture('05-build-done');
  await click('[data-action="done-close"]');
  await sleep(300);

  await click('[data-nav="tasks"]');
  await waitFor("document.querySelector('.page-head h1')?.textContent.includes('转换任务')", 3000);
  await capture('06-tasks');

  await click('[data-nav="compat"]');
  await waitFor("document.querySelector('.grade-grid')", 3000);
  await capture('07-compatibility');

  await click('[data-nav="settings"]');
  await waitFor("document.querySelector('.settings-grid')", 3000);
  await capture('08-settings');
  await win.webContents.executeJavaScript("document.querySelector('.view').scrollTop = 9999");
  await waitFor("document.querySelectorAll('.cache-row').length >= 3", 5000);
  await capture('08b-settings-cache');

  await click('[data-nav="library"]');
  await waitFor("document.querySelector('[data-app-row]')", 3000);
  await click('[data-filter-grade="risk"]');
  await capture('09-library-risk-filter');
  await click('[data-filter-grade="all"]');
  await win.webContents.executeJavaScript("document.querySelector('.view').scrollTop = 620");
  await capture('10-library-scrolled');
  await win.webContents.executeJavaScript("window.scrollTo(0,0); document.querySelector('.view').scrollTop = 0;");
  await click('[data-action="import-recipe"]');
  await waitFor("document.querySelector('.recipe-applied')", 5000);
  await capture('16-recipe-import');
  await click('[data-action="export-recipe"]');
  await capture('16b-recipe-exported');
  await click('[data-action="close-modal"]');
  await win.webContents.executeJavaScript("document.querySelector('#toast-root').innerHTML = '';");
  await win.webContents.executeJavaScript("document.querySelector('#drop-overlay').classList.add('visible'); document.querySelector('#drop-overlay').setAttribute('aria-hidden','false');");
  await capture('17-drop-overlay');
  await win.webContents.executeJavaScript("document.querySelector('#drop-overlay').classList.remove('visible'); document.querySelector('#drop-overlay').setAttribute('aria-hidden','true');");
  await click('[data-action="pick-archive"]');
  await waitFor("document.querySelector('.drawer')", 5000);
  await win.webContents.executeJavaScript("document.querySelector('#toast-root').innerHTML = '';");
  await capture('18-zip-import');
  await click('[data-action="close-drawer"]');
  await win.webContents.executeJavaScript("document.querySelector('.list-toolbar [data-action=\"pick-installer\"]').click();");
  await waitFor("document.querySelector('.installer-settings')", 5000);
  await win.webContents.executeJavaScript("document.querySelector('#toast-root').innerHTML = '';");
  await capture('12-installer-options');
  await click('[data-action="close-modal"]');
  await click('[data-action="toggle-batch"]');
  await waitFor("document.querySelector('.batch-bar')", 3000);
  await win.webContents.executeJavaScript("document.querySelector('[data-app-row=\"demo-0\"]').click(); document.querySelector('[data-app-row=\"demo-1\"]').click();");
  await capture('13-batch-selection');
  await click('[data-action="batch-start"]');
  await sleep(2200);
  await capture('14-batch-progress');
  await waitFor("document.querySelectorAll('.batch-item.done').length >= 2 && !document.querySelector('[data-action=\"batch-stop\"]')", 30000);
  await capture('15-batch-done');
  await click('[data-action="batch-done"]');

  app.quit();
}

app.whenReady().then(main).catch((error) => {
  console.error(error);
  app.exit(1);
});
