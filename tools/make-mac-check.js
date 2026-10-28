'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { pipeline } = require('node:stream/promises');
const yazl = require('yazl');

const ROOT = path.join(__dirname, '..');
const TEMPLATES = path.join(ROOT, 'resources', 'templates');
const PKG = require(path.join(ROOT, 'package.json'));

async function main() {
  const releaseDir = path.join(ROOT, 'release');
  await fsp.mkdir(releaseDir, { recursive: true });
  const folder = `Win2Mac-MacCheck-${PKG.version}`;
  const zipPath = path.join(releaseDir, `${folder}.zip`);
  const partPath = `${zipPath}.part`;
  const mtime = new Date();

  const howto = [
    'Win2Mac Mac 验证工具',
    '',
    '1. 用 Finder 解压 Win2Mac 转换产物（不要用 Windows 资源管理器解压）。',
    '2. 把本工具与 .app 放在同一文件夹，或把 .app 拖到 Start-Mac-Validation.command 上。',
    '3. 双击 Start-Mac-Validation.command。若 Gatekeeper 拦截，右键 → 打开，或运行：',
    '   bash Start-Mac-Validation.command',
    '4. 结束后把桌面上的 Win2Mac-诊断-*.zip 发回给打包者。',
    '',
    '日志全文：~/Desktop/Win2Mac-验证日志-*.log',
    '诊断包：~/Desktop/Win2Mac-诊断-*.zip',
    '',
    '首次启动可能下载 Wine 引擎（约 184 MB）。如果 30 秒内未启动完成，',
    '等应用窗口出现后再双击一次本工具，以收集后续日志。',
    '',
    '隐私提示：日志可能包含用户名、安装路径和应用输出；只发送给可信的人。',
    '',
    `版本：${PKG.version}`,
    '',
  ].join('\n');

  const zip = new yazl.ZipFile();
  zip.addFile(
    path.join(TEMPLATES, 'mac-check.command'),
    `${folder}/Start-Mac-Validation.command`,
    { mode: 0o100755, mtime },
  );
  zip.addFile(
    path.join(TEMPLATES, 'mac-check-readme.html'),
    `${folder}/README-使用说明.html`,
    { mode: 0o100644, mtime },
  );
  zip.addBuffer(Buffer.from(howto, 'utf8'), `${folder}/HOW-TO.txt`, { mode: 0o100644, mtime });
  zip.addBuffer(Buffer.from(`${PKG.version}\n`, 'utf8'), `${folder}/VERSION.txt`, { mode: 0o100644, mtime });
  zip.end();

  await pipeline(zip.outputStream, fs.createWriteStream(partPath));
  await fsp.rename(partPath, zipPath);
  const sha256 = crypto.createHash('sha256').update(await fsp.readFile(zipPath)).digest('hex');
  const stat = await fsp.stat(zipPath);
  await fsp.writeFile(`${zipPath}.sha256`, `${sha256}  ${path.basename(zipPath)}\n`, 'utf8');
  console.log(JSON.stringify({ path: zipPath, size: stat.size, sha256 }, null, 2));
}

main().catch((error) => {
  console.error(error.stack || error);
  process.exit(1);
});
