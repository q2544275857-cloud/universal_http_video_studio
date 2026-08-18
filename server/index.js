import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { APP_VERSION, HOST, PORT, PUBLIC_DIR, ROOT } from './config.js';
import { db, getSetting, setSetting, listAssets, listResults } from './db.js';
import { activeAssetFolder, removeAssetFromLibrary, scanAssetFolder, updateAssetAlias } from './assets.js';
import {
  createReferenceClip,
  importReferenceMedia,
  listReferenceMedia,
  mediaFileForRequest,
  removeReferenceMedia,
  updateReferenceMediaAlias
} from './referenceMedia.js';
import { deleteCookie, importCookie, listCookies, validateCookie } from './cookieService.js';
import { providerStatus } from './provider/creativeStudioI2V.js';
import { httpRequest } from './provider/httpRequest.js';
import { resolveProxyForUrl } from './proxyResolver.js';
import { openInExplorer, selectFolder, selectMediaFiles } from './windowsDialog.js';
import {
  lifecycleStatus,
  recoverLifecycleTasks,
  requestPollNow,
  retryDownload,
  runLifecycleCycle,
  startLifecycleWorker,
  stopLifecycleWorker
} from './lifecycleService.js';
import {
  applyFilenamesToActiveCards,
  applyGenerationCountToActiveCards,
  cardValidationSummary,
  createCard,
  createCardsBulk,
  createSubmissionBatch,
  deleteCard,
  deleteFinishedTaskRecords,
  deleteTaskRecord,
  listCards,
  listCompletedPromptRecords,
  listFailedPromptRecords,
  listPromptHistory,
  listTasks,
  recoverInterruptedTasks,
  reusePromptHistory,
  runWorker,
  taskEvents,
  updateCard
} from './taskService.js';
import { readRequestBody } from './utils.js';

const sseClients = new Set();
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm'
};

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store'
  });
  res.end(body);
}

function sendError(res, error) {
  const status = Number(error.statusCode || 500);
  sendJson(res, status, {
    ok: false,
    code: error.code || (status >= 500 ? 'INTERNAL_ERROR' : 'REQUEST_ERROR'),
    error: error.message || String(error),
    details: error.details || null
  });
}

function routeMatch(pathname, pattern) {
  const keys = [];
  const regex = new RegExp(`^${pattern.replace(/:([A-Za-z0-9_]+)/g, (_, key) => { keys.push(key); return '([^/]+)'; })}$`);
  const match = pathname.match(regex);
  if (!match) return null;
  return Object.fromEntries(keys.map((key, index) => [key, decodeURIComponent(match[index + 1])]));
}

function appState() {
  return {
    ok: true,
    app: { name: 'Universal HTTP Video Studio', version: APP_VERSION, phase: 3, root: ROOT },
    settings: {
      outputDirectory: getSetting('outputDirectory', ''),
      activeCookieId: getSetting('activeCookieId', ''),
      submitConcurrency: Math.max(1, Math.min(99, Number(getSetting('submitConcurrency', 5)) || 5)),
      referenceVideoFolder: getSetting('referenceVideoFolder', ''),
      referenceAudioFolder: getSetting('referenceAudioFolder', '')
    },
    provider: providerStatus(),
    folder: activeAssetFolder(),
    cookies: listCookies(),
    assets: listAssets(),
    referenceMedia: listReferenceMedia(),
    cards: listCards(),
    validation: cardValidationSummary(),
    tasks: listTasks(),
    results: listResults(),
    lifecycle: lifecycleStatus()
  };
}

async function apiHandler(req, res, url) {
  const { pathname } = url;

  if (req.method === 'GET' && pathname === '/api/state') return sendJson(res, 200, appState());
  if (req.method === 'GET' && pathname === '/api/health') return sendJson(res, 200, { ok: true, version: APP_VERSION, phase: 3, provider: providerStatus(), lifecycle: lifecycleStatus() });
  if (req.method === 'GET' && pathname === '/api/network/diagnostics') {
    const target = 'https://ads.tiktok.com/';
    const proxy = await resolveProxyForUrl(target);
    let proxyDisplay = 'DIRECT';
    if (proxy.proxyUrl) {
      try {
        const parsed = new URL(proxy.proxyUrl);
        parsed.username = '';
        parsed.password = '';
        proxyDisplay = parsed.href;
      } catch {
        proxyDisplay = '已配置代理';
      }
    }
    const startedAt = Date.now();
    try {
      const response = await httpRequest(target, { method: 'GET', timeoutMs: 20000, retries: 0 });
      return sendJson(res, 200, {
        ok: true,
        reachable: response.status > 0,
        target,
        proxyMode: proxy.mode,
        proxy: proxyDisplay,
        status: response.status,
        elapsedMs: Date.now() - startedAt
      });
    } catch (error) {
      return sendJson(res, 200, {
        ok: true,
        reachable: false,
        target,
        proxyMode: proxy.mode,
        proxy: proxyDisplay,
        elapsedMs: Date.now() - startedAt,
        error: String(error?.message || error).slice(0, 1000)
      });
    }
  }

  if (req.method === 'GET' && pathname === '/api/events') {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive'
    });
    res.write(`event: connected\ndata: ${JSON.stringify({ ok: true })}\n\n`);
    sseClients.add(res);
    req.on('close', () => sseClients.delete(res));
    return;
  }

  if (req.method === 'POST' && pathname === '/api/dialog/select-folder') {
    const body = await readRequestBody(req);
    const kind = body.kind === 'output' ? 'output' : 'assets';
    const initialPath = kind === 'output' ? getSetting('outputDirectory', '') : activeAssetFolder()?.folder_path || '';
    const folderPath = await selectFolder({
      description: kind === 'output' ? '选择视频保存目录' : '选择图片素材文件夹',
      initialPath
    });
    return sendJson(res, 200, { ok: true, canceled: !folderPath, folderPath });
  }

  if (req.method === 'POST' && pathname === '/api/assets/scan') {
    const body = await readRequestBody(req);
    const result = scanAssetFolder(body.folderPath, { force: Boolean(body.force) });
    return sendJson(res, 200, { ok: true, ...result });
  }

  if (req.method === 'POST' && pathname === '/api/dialog/select-media-files') {
    const body = await readRequestBody(req);
    const mediaType = ['video','audio'].includes(body.mediaType) ? body.mediaType : 'all';
    const paths = await selectMediaFiles({
      initialPath: body.initialPath || activeAssetFolder()?.folder_path || '',
      mediaType,
      title: mediaType === 'video' ? '选择视频参考文件' : mediaType === 'audio' ? '选择音频参考文件' : '选择音视频参考文件'
    });
    return sendJson(res, 200, { ok: true, canceled: !paths.length, paths });
  }

  if (req.method === 'POST' && pathname === '/api/dialog/select-media-folder') {
    const body = await readRequestBody(req);
    const mediaType = ['video','audio'].includes(body.mediaType) ? body.mediaType : 'all';
    const savedPath = mediaType === 'video' ? getSetting('referenceVideoFolder', '') : mediaType === 'audio' ? getSetting('referenceAudioFolder', '') : '';
    const folderPath = await selectFolder({
      description: mediaType === 'video' ? '选择视频素材文件夹' : mediaType === 'audio' ? '选择音频素材文件夹' : '选择音视频素材文件夹',
      initialPath: body.initialPath || savedPath || activeAssetFolder()?.folder_path || ''
    });
    if (folderPath && mediaType === 'video') setSetting('referenceVideoFolder', folderPath);
    if (folderPath && mediaType === 'audio') setSetting('referenceAudioFolder', folderPath);
    return sendJson(res, 200, { ok: true, canceled: !folderPath, folderPath });
  }

  if (req.method === 'POST' && pathname === '/api/reference-media/import') {
    const body = await readRequestBody(req, 2 * 1024 * 1024);
    const sources = body.folderPath ? [body.folderPath] : (body.paths || []);
    const mediaType = ['video','audio'].includes(body.mediaType) ? body.mediaType : 'all';
    const result = await importReferenceMedia(sources, { mediaType, maxVideoDurationSeconds: mediaType === 'video' ? 20 : 0 });
    return sendJson(res, 201, { ok: true, ...result });
  }

  let params = routeMatch(pathname, '/api/reference-media/:id');
  if (params && req.method === 'PATCH') {
    const body = await readRequestBody(req);
    return sendJson(res, 200, { ok: true, media: updateReferenceMediaAlias(params.id, body.alias) });
  }
  if (params && req.method === 'DELETE') {
    removeReferenceMedia(params.id);
    return sendJson(res, 200, { ok: true });
  }

  params = routeMatch(pathname, '/api/reference-media/:id/clip');
  if (params && req.method === 'POST') {
    const body = await readRequestBody(req);
    const clip = await createReferenceClip(params.id, { startSeconds: body.startSeconds, durationSeconds: body.durationSeconds });
    return sendJson(res, 201, { ok: true, clip });
  }

  params = routeMatch(pathname, '/api/reference-media/:id/file');
  if (params && req.method === 'GET') {
    const clipId = String(url.searchParams.get('clipId') || '');
    const file = mediaFileForRequest(params.id, clipId);
    if (!file) return sendJson(res, 404, { ok: false, error: '音视频文件不存在。' });
    const range = req.headers.range;
    if (range) {
      const match = String(range).match(/bytes=(\d*)-(\d*)/);
      const start = match?.[1] ? Number(match[1]) : 0;
      const end = match?.[2] ? Math.min(Number(match[2]), file.size - 1) : file.size - 1;
      if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= file.size) {
        res.writeHead(416, { 'content-range': `bytes */${file.size}` });
        return res.end();
      }
      res.writeHead(206, {
        'content-type': file.mime,
        'accept-ranges': 'bytes',
        'content-range': `bytes ${start}-${end}/${file.size}`,
        'content-length': end - start + 1,
        'cache-control': 'private, max-age=60'
      });
      fs.createReadStream(file.path, { start, end }).pipe(res);
      return;
    }
    res.writeHead(200, {
      'content-type': file.mime,
      'content-length': file.size,
      'accept-ranges': 'bytes',
      'cache-control': 'private, max-age=60'
    });
    fs.createReadStream(file.path).pipe(res);
    return;
  }

  params = routeMatch(pathname, '/api/assets/:id');
  if (params && req.method === 'PATCH') {
    const body = await readRequestBody(req);
    return sendJson(res, 200, { ok: true, asset: updateAssetAlias(params.id, body.alias) });
  }
  if (params && req.method === 'DELETE') {
    removeAssetFromLibrary(params.id);
    return sendJson(res, 200, { ok: true });
  }

  params = routeMatch(pathname, '/api/assets/:id/file');
  if (params && req.method === 'GET') {
    const asset = db.prepare('SELECT * FROM assets WHERE id=? AND active=1').get(params.id);
    if (!asset || !fs.existsSync(asset.absolute_path)) return sendJson(res, 404, { ok: false, error: '素材文件不存在。' });
    const stat = fs.statSync(asset.absolute_path);
    res.writeHead(200, {
      'content-type': asset.mime_type,
      'content-length': stat.size,
      'cache-control': 'private, max-age=60'
    });
    fs.createReadStream(asset.absolute_path).pipe(res);
    return;
  }

  if (req.method === 'POST' && pathname === '/api/settings/output-directory') {
    const body = await readRequestBody(req);
    const folderPath = path.resolve(String(body.folderPath || ''));
    if (!folderPath || !fs.existsSync(folderPath) || !fs.statSync(folderPath).isDirectory()) {
      throw Object.assign(new Error('保存目录不存在。'), { statusCode: 422 });
    }
    setSetting('outputDirectory', folderPath);
    return sendJson(res, 200, { ok: true, outputDirectory: folderPath });
  }

  if (req.method === 'POST' && pathname === '/api/settings/submit-concurrency') {
    const body = await readRequestBody(req);
    const value = Number(body.value);
    if (!Number.isInteger(value) || value < 1 || value > 99) {
      throw Object.assign(new Error('提交并发数必须是 1–99 整数。'), { statusCode: 422 });
    }
    setSetting('submitConcurrency', value);
    runWorker().catch(() => {});
    return sendJson(res, 200, { ok: true, submitConcurrency: value });
  }

  if (req.method === 'POST' && pathname === '/api/settings/reference-media-folder') {
    const body = await readRequestBody(req);
    const mediaType = body.mediaType === 'audio' ? 'audio' : 'video';
    const folderPath = path.resolve(String(body.folderPath || ''));
    if (!folderPath || !fs.existsSync(folderPath) || !fs.statSync(folderPath).isDirectory()) {
      throw Object.assign(new Error('参考素材文件夹不存在。'), { statusCode: 422 });
    }
    const key = mediaType === 'video' ? 'referenceVideoFolder' : 'referenceAudioFolder';
    setSetting(key, folderPath);
    return sendJson(res, 200, { ok: true, mediaType, folderPath });
  }

  if (req.method === 'POST' && pathname === '/api/cookies/import') {
    const body = await readRequestBody(req, 8 * 1024 * 1024);
    const cookie = importCookie({ name: body.name, content: body.content });
    setSetting('activeCookieId', cookie.id);
    return sendJson(res, 201, { ok: true, cookie });
  }

  params = routeMatch(pathname, '/api/cookies/:id/validate');
  if (params && req.method === 'POST') {
    const result = await validateCookie(params.id);
    if (result.valid) setSetting('activeCookieId', params.id);
    return sendJson(res, result.valid ? 200 : 422, {
      ok: result.valid,
      ...result,
      ...(result.valid ? {} : { error: result.message })
    });
  }

  params = routeMatch(pathname, '/api/cookies/:id');
  if (params && req.method === 'DELETE') {
    deleteCookie(params.id);
    if (getSetting('activeCookieId', '') === params.id) setSetting('activeCookieId', '');
    return sendJson(res, 200, { ok: true });
  }

  if (req.method === 'POST' && pathname === '/api/cards') {
    const body = await readRequestBody(req);
    return sendJson(res, 201, { ok: true, card: createCard(body.sourceId || null) });
  }

  if (req.method === 'POST' && pathname === '/api/cards/bulk') {
    const body = await readRequestBody(req, 4 * 1024 * 1024);
    return sendJson(res, 201, { ok: true, ...createCardsBulk({ text: body.text, generationCount: body.generationCount }) });
  }

  if (req.method === 'POST' && pathname === '/api/cards/apply-generation-count') {
    const body = await readRequestBody(req);
    return sendJson(res, 200, { ok: true, ...applyGenerationCountToActiveCards(body.generationCount) });
  }

  if (req.method === 'POST' && pathname === '/api/cards/apply-filenames') {
    const body = await readRequestBody(req);
    return sendJson(res, 200, { ok: true, ...applyFilenamesToActiveCards({ prefix: body.prefix, startNumber: body.startNumber, padding: body.padding }) });
  }

  if (req.method === 'POST' && pathname === '/api/tasks/export-failed-prompts') {
    const body = await readRequestBody(req);
    return sendJson(res, 200, { ok: true, ...listFailedPromptRecords({ startIso: body.startIso, endIso: body.endIso }) });
  }

  if (req.method === 'POST' && pathname === '/api/tasks/export-prompts-by-date') {
    const body = await readRequestBody(req);
    return sendJson(res, 200, { ok: true, ...listCompletedPromptRecords({ startIso: body.startIso, endIso: body.endIso }) });
  }

  if (req.method === 'GET' && pathname === '/api/prompt-history') {
    const limit = Number(url.searchParams.get('limit') || 300);
    return sendJson(res, 200, { ok: true, history: listPromptHistory(limit) });
  }

  params = routeMatch(pathname, '/api/prompt-history/:id/reuse');
  if (params && req.method === 'POST') {
    return sendJson(res, 201, { ok: true, ...reusePromptHistory(params.id) });
  }

  params = routeMatch(pathname, '/api/cards/:id');
  if (params && req.method === 'PATCH') {
    const body = await readRequestBody(req);
    return sendJson(res, 200, { ok: true, card: updateCard(params.id, body) });
  }
  if (params && req.method === 'DELETE') {
    const result = deleteCard(params.id);
    return sendJson(res, 200, { ok: true, ...result });
  }

  if (req.method === 'POST' && pathname === '/api/batches/submit') {
    const body = await readRequestBody(req);
    const result = createSubmissionBatch({
      cookieProfileId: body.cookieProfileId || getSetting('activeCookieId', ''),
      cardIds: Array.isArray(body.cardIds) ? body.cardIds : null
    });
    return sendJson(res, 202, { ok: true, ...result });
  }

  if (req.method === 'POST' && pathname === '/api/worker/run') {
    runWorker().catch(() => {});
    return sendJson(res, 202, { ok: true });
  }

  if (req.method === 'POST' && pathname === '/api/lifecycle/run') {
    runLifecycleCycle().catch(() => {});
    return sendJson(res, 202, { ok: true });
  }

  if (req.method === 'DELETE' && pathname === '/api/tasks') {
    return sendJson(res, 200, { ok: true, ...deleteFinishedTaskRecords() });
  }

  params = routeMatch(pathname, '/api/tasks/:id');
  if (params && req.method === 'DELETE') return sendJson(res, 200, { ok: true, ...deleteTaskRecord(params.id) });

  params = routeMatch(pathname, '/api/tasks/:id/poll-now');
  if (params && req.method === 'POST') return sendJson(res, 202, requestPollNow(params.id));

  params = routeMatch(pathname, '/api/tasks/:id/retry-download');
  if (params && req.method === 'POST') return sendJson(res, 202, retryDownload(params.id));

  params = routeMatch(pathname, '/api/tasks/:id/open');
  if (params && req.method === 'POST') {
    const task = db.prepare('SELECT download_path FROM generation_tasks WHERE id=?').get(params.id);
    if (!task?.download_path) throw Object.assign(new Error('该任务尚无本地视频文件。'), { statusCode: 422 });
    return sendJson(res, 200, { ok: true, path: openInExplorer(task.download_path) });
  }

  params = routeMatch(pathname, '/api/tasks/:id/video');
  if (params && req.method === 'GET') {
    const task = db.prepare('SELECT download_path FROM generation_tasks WHERE id=?').get(params.id);
    const filePath = task?.download_path;
    if (!filePath || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) return sendJson(res, 404, { ok: false, error: '本地视频不存在。' });
    const stat = fs.statSync(filePath);
    const range = req.headers.range;
    const contentType = MIME[path.extname(filePath).toLowerCase()] || 'video/mp4';
    if (range) {
      const match = String(range).match(/bytes=(\d*)-(\d*)/);
      const start = match?.[1] ? Number(match[1]) : 0;
      const end = match?.[2] ? Math.min(Number(match[2]), stat.size - 1) : stat.size - 1;
      if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= stat.size) {
        res.writeHead(416, { 'content-range': `bytes */${stat.size}` });
        return res.end();
      }
      res.writeHead(206, {
        'content-type': contentType,
        'content-length': end - start + 1,
        'content-range': `bytes ${start}-${end}/${stat.size}`,
        'accept-ranges': 'bytes',
        'cache-control': 'private, max-age=60'
      });
      fs.createReadStream(filePath, { start, end }).pipe(res);
      return;
    }
    res.writeHead(200, {
      'content-type': contentType,
      'content-length': stat.size,
      'accept-ranges': 'bytes',
      'cache-control': 'private, max-age=60'
    });
    fs.createReadStream(filePath).pipe(res);
    return;
  }

  return sendJson(res, 404, { ok: false, error: 'API route not found.' });
}

function serveStatic(req, res, url) {
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === '/') pathname = '/index.html';
  const candidate = path.resolve(PUBLIC_DIR, `.${pathname}`);
  const relative = path.relative(PUBLIC_DIR, candidate);
  if (relative.startsWith('..') || path.isAbsolute(relative) || !fs.existsSync(candidate) || !fs.statSync(candidate).isFile()) {
    return sendJson(res, 404, { ok: false, error: 'File not found.' });
  }
  const stat = fs.statSync(candidate);
  res.writeHead(200, {
    'content-type': MIME[path.extname(candidate).toLowerCase()] || 'application/octet-stream',
    'content-length': stat.size,
    'cache-control': pathname === '/index.html' ? 'no-store' : 'public, max-age=60'
  });
  fs.createReadStream(candidate).pipe(res);
}

recoverInterruptedTasks();
recoverLifecycleTasks();
runWorker().catch(() => {});
startLifecycleWorker();
taskEvents.on('event', event => {
  const message = `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
  for (const client of sseClients) {
    try { client.write(message); } catch { sseClients.delete(client); }
  }
});

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || `${HOST}:${PORT}`}`);
    if (url.pathname.startsWith('/api/')) await apiHandler(req, res, url);
    else serveStatic(req, res, url);
  } catch (error) {
    console.error(`[server] ${error.stack || error.message}`);
    if (!res.headersSent) sendError(res, error);
    else res.end();
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Universal HTTP Video Studio V${APP_VERSION} running at http://${HOST}:${PORT}`);
});

let closePromise = null;
export function closeServer() {
  if (closePromise) return closePromise;
  stopLifecycleWorker();
  closePromise = new Promise(resolve => {
    if (!server.listening) return resolve();
    server.close(() => resolve());
  });
  return closePromise;
}

export { server };

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    closeServer().finally(() => process.exit(0));
  });
}
