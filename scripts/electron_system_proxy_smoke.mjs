import { app, net as electronNet, session } from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const outputPath = path.join(os.tmpdir(), 'uvs-electron-proxy-smoke.json');

app.whenReady().then(async () => {
  try {
    const target = 'https://ads.tiktok.com/';
    const proxy = await session.defaultSession.resolveProxy(target);
    globalThis.__STUDIO_ELECTRON_FETCH__ = async (url, options = {}) => electronNet.fetch(url, options);
    globalThis.__STUDIO_RESOLVE_SYSTEM_PROXY__ = async url => session.defaultSession.resolveProxy(url);
    const { httpRequest } = await import('../server/provider/httpRequest.js');
    const startedAt = Date.now();
    const response = await httpRequest(target, { method: 'GET', timeoutMs: 30000, retries: 0 });
    fs.writeFileSync(outputPath, JSON.stringify({
      ok: response.status > 0,
      proxy,
      status: response.status,
      elapsedMs: Date.now() - startedAt,
      contentType: response.headers['content-type'] || ''
    }, null, 2), 'utf8');
    app.exit(0);
  } catch (error) {
    fs.writeFileSync(outputPath, JSON.stringify({ ok: false, error: String(error?.stack || error) }, null, 2), 'utf8');
    app.exit(1);
  }
});
