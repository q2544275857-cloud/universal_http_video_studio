import { app, BrowserWindow, dialog, net as electronNet, session, shell } from 'electron';
import fs from 'node:fs';
import nodeNet from 'node:net';
import path from 'node:path';

const APP_NAME = 'Universal HTTP Video Studio';
const HOST = '127.0.0.1';
let mainWindow = null;
let serverModule = null;
let shutdownStarted = false;
let appUrl = '';
let startupLogPath = '';

function startupLog(stage, detail = '') {
  if (!startupLogPath) return;
  try {
    const value = detail instanceof Error ? (detail.stack || detail.message) : String(detail || '');
    fs.appendFileSync(startupLogPath, `[${new Date().toISOString()}] ${stage}${value ? ` | ${value}` : ''}\n`, 'utf8');
  } catch {}
}

app.setName(APP_NAME);
if (process.env.STUDIO_USER_DATA_DIR) {
  app.setPath('userData', path.resolve(process.env.STUDIO_USER_DATA_DIR));
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const probe = nodeNet.createServer();
    probe.unref();
    probe.once('error', reject);
    probe.listen(0, HOST, () => {
      const address = probe.address();
      const port = typeof address === 'object' && address ? address.port : 4174;
      probe.close(error => error ? reject(error) : resolve(port));
    });
  });
}

async function waitForServer(url, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${url}/api/health`, { cache: 'no-store' });
      if (response.ok) return response.json();
    } catch (error) {
      lastError = error;
    }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error(`本地服务启动超时。${lastError ? ` ${lastError.message}` : ''}`);
}

function createWindow() {
  const window = new BrowserWindow({
    title: APP_NAME,
    width: 1460,
    height: 940,
    minWidth: 1080,
    minHeight: 720,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#f3f6fb',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false
    }
  });

  window.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url) && !url.startsWith(appUrl)) shell.openExternal(url);
    return { action: 'deny' };
  });

  window.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(appUrl)) {
      event.preventDefault();
      if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    }
  });

  window.once('ready-to-show', () => window.show());
  window.on('closed', () => { if (mainWindow === window) mainWindow = null; });
  window.loadURL(appUrl);
  return window;
}

async function startApp() {
  const userData = app.getPath('userData');
  fs.mkdirSync(userData, { recursive: true });
  startupLogPath = path.join(userData, 'startup.log');
  fs.writeFileSync(startupLogPath, '', 'utf8');
  startupLog('app_start', JSON.stringify({
    appVersion: app.getVersion(),
    electron: process.versions.electron,
    node: process.versions.node,
    resourcesPath: process.resourcesPath,
    userData
  }));

  const storageDir = path.join(userData, 'runtime');
  fs.mkdirSync(storageDir, { recursive: true });
  startupLog('storage_ready', storageDir);

  const port = await getFreePort();
  process.env.HOST = HOST;
  process.env.PORT = String(port);
  process.env.STUDIO_STORAGE_DIR = storageDir;
  process.env.STUDIO_RESOURCES_PATH = process.resourcesPath;
  process.env.STUDIO_ELECTRON = '1';
  appUrl = `http://${HOST}:${port}`;

  globalThis.__STUDIO_ELECTRON_FETCH__ = async (url, options = {}) => electronNet.fetch(url, options);
  globalThis.__STUDIO_ELECTRON_REQUEST__ = async (url, options = {}) => new Promise((resolve, reject) => {
    const request = electronNet.request({
      method: options.method || 'GET',
      url,
      redirect: 'follow',
      session: session.defaultSession
    });
    const headers = options.headers || {};
    for (const [key, value] of Object.entries(headers)) {
      if (value != null) request.setHeader(key, String(value));
    }
    const chunks = [];
    const timeoutMs = Math.max(1000, Number(options.timeoutMs || 60000));
    const timer = setTimeout(() => request.abort(), timeoutMs);
    request.on('response', response => {
      response.on('data', chunk => chunks.push(Buffer.from(chunk)));
      response.on('end', () => {
        clearTimeout(timer);
        resolve({
          status: Number(response.statusCode || 0),
          headers: response.headers || {},
          buffer: Buffer.concat(chunks)
        });
      });
      response.on('error', error => {
        clearTimeout(timer);
        reject(error);
      });
    });
    request.on('error', error => {
      clearTimeout(timer);
      reject(error);
    });
    if (options.body?.length) request.write(options.body);
    request.end();
  });
  globalThis.__STUDIO_RESOLVE_SYSTEM_PROXY__ = async url => session.defaultSession.resolveProxy(url);
  try {
    const probeProxy = await session.defaultSession.resolveProxy('https://ads.tiktok.com/');
    startupLog('system_proxy_resolved', probeProxy || 'DIRECT');
  } catch (error) {
    startupLog('system_proxy_resolve_failed', error);
  }

  startupLog('server_import_begin');
  serverModule = await import('../server/index.js');
  startupLog('server_import_complete');
  const health = await waitForServer(appUrl);
  startupLog('server_health_ready', JSON.stringify(health));
  fs.writeFileSync(path.join(userData, 'app-runtime.json'), JSON.stringify({
    name: APP_NAME,
    version: health.version,
    port,
    pid: process.pid,
    storageDir,
    startedAt: new Date().toISOString()
  }, null, 2), 'utf8');

  mainWindow = createWindow();
  startupLog('window_created');
}

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });

  app.whenReady().then(startApp).catch(error => {
    startupLog('startup_failed', error);
    dialog.showErrorBox(`${APP_NAME} 启动失败`, error.stack || error.message || String(error));
    app.exit(1);
  });
}

app.on('window-all-closed', () => app.quit());

app.on('before-quit', event => {
  if (shutdownStarted || !serverModule?.closeServer) return;
  event.preventDefault();
  shutdownStarted = true;
  Promise.race([
    serverModule.closeServer(),
    new Promise(resolve => setTimeout(resolve, 3000))
  ]).finally(() => app.exit(0));
});
