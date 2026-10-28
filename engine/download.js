'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { ensureDir, sha256File, safeRemove } = require('./util');

function curlPath() {
  if (process.env.WIN2MAC_CURL) return process.env.WIN2MAC_CURL;
  if (process.platform === 'win32' && process.env.SystemRoot) {
    return path.join(process.env.SystemRoot, 'System32', 'curl.exe');
  }
  return 'curl';
}

function curlJson(url, { proxy, timeout = 60000 } = {}) {
  return new Promise((resolve, reject) => {
    const args = ['-fsSL', '--max-time', String(Math.ceil(timeout / 1000)), '-H', 'User-Agent: Win2Mac-Studio', '-H', 'Accept: application/vnd.github+json'];
    if (proxy) args.push('-x', proxy);
    args.push(url);
    const child = spawn(curlPath(), args, { windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
      if (stdout.length > 8 * 1024 * 1024) child.kill();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error(`网络请求失败 (curl ${code})：${stderr.trim() || url}`));
      try {
        resolve(JSON.parse(stdout));
      } catch (error) {
        reject(new Error(`JSON 解析失败：${error.message}`));
      }
    });
  });
}

function fileSize(file) {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
}

function runCurlDownload(url, part, { proxy, totalBytes } = {}) {
  return new Promise((resolve) => {
    const existing = fileSize(part);
    const args = ['-fL', '--connect-timeout', '20', '--speed-time', '90', '--speed-limit', '1024', '-o', part];
    if (existing > 0) args.push('-C', '-');
    if (proxy) args.push('-x', proxy);
    args.push(url);
    const child = spawn(curlPath(), args, { windowsHide: true });
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', (error) => resolve({ code: -1, stderr: error.message }));
    child.on('close', (code) => resolve({ code, stderr, size: fileSize(part) }));
    void totalBytes;
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function downloadFile(url, dest, options = {}) {
  await ensureDir(path.dirname(dest));
  const part = `${dest}.part`;
  const proxy = options.proxy;
  const onProgress = options.onProgress || (() => {});
  const totalBytes = Number(options.totalBytes) || 0;
  const maxAttempts = options.maxAttempts || 10;
  let progressTimer = null;

  if (options.expectedSha256 && fs.existsSync(dest)) {
    const existingSha = await sha256File(dest).catch(() => '');
    if (existingSha.toLowerCase() === String(options.expectedSha256).toLowerCase()) {
      const st = await fsp.stat(dest);
      return { path: dest, size: st.size, sha256: existingSha };
    }
    await fsp.rm(dest, { force: true });
  }

  const emitProgress = () => {
    if (!totalBytes) return;
    const received = fileSize(part);
    onProgress({
      received,
      total: totalBytes,
      percent: Math.min(100, Math.round((received / totalBytes) * 100)),
    });
  };
  if (totalBytes) {
    emitProgress();
    progressTimer = setInterval(emitProgress, 500);
  }

  try {
    let lastError = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      if (totalBytes && fileSize(part) >= totalBytes) break;
      const result = await runCurlDownload(url, part, { proxy, totalBytes });
      emitProgress();
      if (result.code === 0) {
        if (totalBytes && result.size < totalBytes) {
          lastError = new Error(`下载不完整：${result.size} / ${totalBytes} 字节`);
        } else {
          break;
        }
      } else {
        lastError = new Error(`curl ${result.code}: ${result.stderr.trim().split('\n').slice(-1)[0] || '网络连接中断'}`);
        if (/HTTP (403|404|410)/i.test(result.stderr) || /returned error: (403|404|410)/i.test(result.stderr)) {
          throw lastError;
        }
      }
      if (attempt < maxAttempts) {
        onProgress({ received: fileSize(part), total: totalBytes || fileSize(part), percent: totalBytes ? Math.min(99, Math.round((fileSize(part) / totalBytes) * 100)) : 0, retrying: true });
        await sleep(Math.min(15000, 1500 * attempt));
      }
    }

    const finalSize = fileSize(part);
    if (totalBytes && finalSize < totalBytes) {
      throw lastError || new Error(`下载未完成：${finalSize} / ${totalBytes} 字节`);
    }
    if (options.expectedSha256) {
      const actual = await sha256File(part);
      if (actual.toLowerCase() !== String(options.expectedSha256).toLowerCase()) {
        await safeRemove(part);
        throw new Error(`SHA-256 校验失败：期望 ${options.expectedSha256}，实际 ${actual}`);
      }
    }
    await fsp.rename(part, dest);
    const st = await fsp.stat(dest);
    onProgress({ received: st.size, total: st.size, percent: 100 });
    return { path: dest, size: st.size, sha256: options.expectedSha256 || (await sha256File(dest)) };
  } catch (error) {
    // Keep a partial file so the next attempt can resume; only remove obviously unusable data.
    if (!fileSize(part) || /HTTP (404|410)/i.test(error.message)) await safeRemove(part);
    throw error;
  } finally {
    if (progressTimer) clearInterval(progressTimer);
  }
}

module.exports = { downloadFile, curlJson, curlPath };
