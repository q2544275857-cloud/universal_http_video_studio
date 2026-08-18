import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { resolveProxyForUrl } from './proxyResolver.js';
import { safeFilename } from './utils.js';

function scoreUrl(url) {
  const value = String(url || '');
  let score = 0;
  if (/mime_type=video_mp4/i.test(value)) score += 100;
  if (/\.mp4(?:\?|$)/i.test(value)) score += 80;
  if (/v16-ad-creative/i.test(value)) score += 45;
  if (/v19-ad-creative/i.test(value)) score += 40;
  if (/tos-alisg-v-/i.test(value)) score += 30;
  const bitrate = Number((value.match(/[?&]bt=(\d+)/) || [])[1] || 0);
  score += Math.min(bitrate / 100, 50);
  return score;
}

function uniqueOutputPath(directory, filename, preferredPath = '') {
  fs.mkdirSync(directory, { recursive: true });
  if (preferredPath) {
    const preferred = path.resolve(preferredPath);
    if (path.dirname(preferred).toLowerCase() === path.resolve(directory).toLowerCase()) return preferred;
  }
  const base = safeFilename(String(filename || 'video').replace(/\.mp4$/i, ''));
  let candidate = path.join(directory, `${base}.mp4`);
  let counter = 1;
  while (fs.existsSync(candidate)) {
    candidate = path.join(directory, `${base} (${counter}).mp4`);
    counter += 1;
  }
  return candidate;
}

async function runCurl(url, outputPath) {
  const target = new URL(url);
  const proxyInfo = ['127.0.0.1', 'localhost'].includes(target.hostname)
    ? { mode: 'direct', proxyUrl: '' }
    : await resolveProxyForUrl(url);
  return new Promise((resolve, reject) => {
    const args = [
      '-L', '--fail', '--retry', '2', '--retry-delay', '1', '--connect-timeout', '30', '--max-time', '900',
      '-A', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36',
      '-H', 'Referer: https://ads.tiktok.com/',
      '-H', 'Origin: https://ads.tiktok.com',
      '-H', 'Accept: video/webm,video/mp4,video/*,*/*;q=0.8'
    ];
    if (proxyInfo.proxyUrl) args.push('--proxy', proxyInfo.proxyUrl);
    args.push('-o', outputPath, url);
    const child = spawn('curl.exe', args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk.toString(); });
    child.once('error', reject);
    child.once('close', code => {
      if (code === 0 && fs.existsSync(outputPath)) resolve();
      else reject(new Error(`curl download failed (code ${code}): ${stderr.slice(-1500)}`));
    });
  });
}

function verifyVideoFile(filePath) {
  if (!fs.existsSync(filePath)) throw new Error('下载结果文件不存在。');
  const stat = fs.statSync(filePath);
  if (stat.size < 1024) throw new Error(`下载结果过小：${stat.size} bytes。`);
  const fd = fs.openSync(filePath, 'r');
  try {
    const head = Buffer.alloc(Math.min(256, stat.size));
    fs.readSync(fd, head, 0, head.length, 0);
    const text = head.toString('latin1');
    if (/^\s*[<{]/.test(text)) throw new Error('下载内容看起来是错误页面，不是视频。');
    const isMp4 = head.includes(Buffer.from('ftyp'));
    const isWebm = head.slice(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
    if (!isMp4 && !isWebm) throw new Error('下载文件未识别为 MP4 或 WebM 视频。');
  } finally {
    fs.closeSync(fd);
  }
  return stat.size;
}

function hashFile(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', chunk => hash.update(chunk));
    stream.once('error', reject);
    stream.once('end', () => resolve(hash.digest('hex')));
  });
}

export async function downloadCandidates({ urls, outputDirectory, filename, preferredPath = '' }) {
  const candidates = [...new Set((urls || []).filter(url => /^https?:\/\//i.test(String(url))))]
    .sort((a, b) => scoreUrl(b) - scoreUrl(a));
  if (!candidates.length) throw Object.assign(new Error('没有可下载的视频链接。'), { code: 'NO_VIDEO_URL' });
  const finalPath = uniqueOutputPath(outputDirectory, filename, preferredPath);
  const partialPath = `${finalPath}.part`;
  const attempts = [];
  try { if (fs.existsSync(partialPath)) fs.unlinkSync(partialPath); } catch {}

  for (const url of candidates) {
    try {
      await runCurl(url, partialPath);
      const byteSize = verifyVideoFile(partialPath);
      if (fs.existsSync(finalPath)) fs.unlinkSync(finalPath);
      fs.renameSync(partialPath, finalPath);
      const sha256 = await hashFile(finalPath);
      return { url, localPath: finalPath, byteSize, sha256, attempts };
    } catch (error) {
      attempts.push({ url, error: String(error.message).slice(0, 800) });
      try { if (fs.existsSync(partialPath)) fs.unlinkSync(partialPath); } catch {}
    }
  }
  throw Object.assign(new Error(`所有视频链接下载失败，共尝试 ${attempts.length} 个链接。`), {
    code: 'DOWNLOAD_ALL_URLS_FAILED',
    details: attempts
  });
}

export function isExistingVideo(filePath) {
  try {
    verifyVideoFile(filePath);
    return true;
  } catch {
    return false;
  }
}
