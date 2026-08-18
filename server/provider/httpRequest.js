import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import { resolveProxyForUrl, hasExplicitProxy } from '../proxyResolver.js';
import { sleep } from '../utils.js';

function connectProxy(proxy, targetHost, targetPort, timeoutMs) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(Number(proxy.port || 80), proxy.hostname);
    const timer = setTimeout(() => socket.destroy(new Error(`Proxy CONNECT timeout: ${proxy.href}`)), timeoutMs);
    let buffer = Buffer.alloc(0);
    socket.once('error', error => { clearTimeout(timer); reject(error); });
    socket.on('connect', () => socket.write(`CONNECT ${targetHost}:${targetPort} HTTP/1.1\r\nHost: ${targetHost}:${targetPort}\r\nProxy-Connection: Keep-Alive\r\n\r\n`));
    socket.on('data', chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      const end = buffer.indexOf('\r\n\r\n');
      if (end < 0) return;
      const head = buffer.subarray(0, end).toString('latin1');
      const rest = buffer.subarray(end + 4);
      socket.removeAllListeners('data');
      clearTimeout(timer);
      if (!/^HTTP\/1\.[01] 2\d\d/i.test(head)) {
        socket.destroy();
        reject(new Error(`Proxy CONNECT failed: ${head.split('\r\n')[0]}`));
        return;
      }
      if (rest.length) socket.unshift(rest);
      resolve(socket);
    });
  });
}

function decodeChunked(buffer) {
  let offset = 0;
  const chunks = [];
  while (offset < buffer.length) {
    const lineEnd = buffer.indexOf('\r\n', offset);
    if (lineEnd < 0) break;
    const size = Number.parseInt(buffer.subarray(offset, lineEnd).toString('latin1').split(';')[0].trim(), 16);
    if (!Number.isFinite(size) || size === 0) break;
    offset = lineEnd + 2;
    chunks.push(buffer.subarray(offset, offset + size));
    offset += size + 2;
  }
  return Buffer.concat(chunks);
}

function transient(error) {
  return /ECONNRESET|ETIMEDOUT|EPIPE|timeout|TLS|socket|Proxy CONNECT|Invalid HTTP response/i.test(String(error?.message || error));
}

export async function httpRequest(url, options = {}) {
  const retries = Number(options.retries ?? 2);
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await requestOnce(url, options);
    } catch (error) {
      lastError = error;
      if (attempt >= retries || !transient(error)) throw error;
      await sleep(800 * (2 ** attempt));
    }
  }
  throw lastError;
}

function electronSafeHeaders(headers) {
  const values = { ...headers };
  for (const key of Object.keys(values)) {
    if (/^(host|content-length|connection|proxy-connection)$/i.test(key)) delete values[key];
  }
  return values;
}

async function requestWithElectronNet(url, { method, headers, bodyBuffer, hasBody, timeoutMs }) {
  const requester = globalThis.__STUDIO_ELECTRON_REQUEST__;
  const response = await requester(url, {
    method,
    headers: electronSafeHeaders(headers),
    body: hasBody ? bodyBuffer : null,
    timeoutMs
  });
  return resolveResponse(response.status, response.headers || {}, Buffer.from(response.buffer || []));
}

async function requestWithElectronFetch(url, { method, headers, bodyBuffer, hasBody, timeoutMs }) {
  const fetcher = globalThis.__STUDIO_ELECTRON_FETCH__;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`HTTP timeout: ${url}`)), timeoutMs);
  try {
    const response = await fetcher(url, {
      method,
      headers: electronSafeHeaders(headers),
      body: hasBody ? bodyBuffer : undefined,
      redirect: 'follow',
      signal: controller.signal
    });
    const buffer = Buffer.from(await response.arrayBuffer());
    return resolveResponse(response.status, Object.fromEntries(response.headers.entries()), buffer);
  } finally {
    clearTimeout(timer);
  }
}

async function requestOnce(url, { method = 'GET', headers = {}, body = null, timeoutMs = 60000 } = {}) {
  const target = new URL(url);
  const bodyBuffer = body == null ? Buffer.alloc(0) : Buffer.isBuffer(body) ? body : Buffer.from(String(body));
  const requestHeaders = {
    host: target.host,
    'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36',
    'accept-encoding': 'identity',
    ...headers
  };
  if (body != null && requestHeaders['content-length'] == null) requestHeaders['content-length'] = bodyBuffer.length;

  let electronNetworkError = null;
  if (!hasExplicitProxy()) {
    if (typeof globalThis.__STUDIO_ELECTRON_REQUEST__ === 'function') {
      try {
        return await requestWithElectronNet(url, { method, headers: requestHeaders, bodyBuffer, hasBody: body != null, timeoutMs });
      } catch (error) {
        electronNetworkError = error;
      }
    } else if (typeof globalThis.__STUDIO_ELECTRON_FETCH__ === 'function') {
      try {
        return await requestWithElectronFetch(url, { method, headers: requestHeaders, bodyBuffer, hasBody: body != null, timeoutMs });
      } catch (error) {
        electronNetworkError = error;
      }
    }
  }

  const proxyInfo = await resolveProxyForUrl(url);
  const proxy = proxyInfo.proxyUrl ? new URL(proxyInfo.proxyUrl) : null;
  if (!proxy) {
    if (electronNetworkError) throw electronNetworkError;
    const client = target.protocol === 'https:' ? https : http;
    return new Promise((resolve, reject) => {
      const req = client.request(target, { method, headers: requestHeaders, timeout: timeoutMs }, res => {
        const chunks = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('end', () => resolveResponse(res.statusCode || 0, res.headers, Buffer.concat(chunks)));
      });
      req.on('timeout', () => req.destroy(new Error(`HTTP timeout: ${url}`)));
      req.on('error', reject);
      if (body != null) req.write(bodyBuffer);
      req.end();
    });
  }

  if (target.protocol !== 'https:') throw new Error('Only HTTPS over HTTP proxy is supported.');
  if (!/^https?:$/i.test(proxy.protocol)) {
    if (electronNetworkError) throw electronNetworkError;
    throw new Error(`当前 HTTP 请求暂不支持 ${proxy.protocol} 代理，请使用 HTTP 系统代理。`);
  }
  let raw;
  try {
    raw = await connectProxy(proxy, target.hostname, Number(target.port || 443), timeoutMs);
  } catch (proxyError) {
    if (electronNetworkError) {
      throw new Error(`系统代理连接失败：${proxyError.message}；Electron 网络请求失败：${electronNetworkError.message}`);
    }
    throw proxyError;
  }
  const secure = tls.connect({ socket: raw, servername: target.hostname });
  await new Promise((resolve, reject) => {
    secure.once('secureConnect', resolve);
    secure.once('error', reject);
  });
  const lines = [`${method} ${target.pathname}${target.search} HTTP/1.1`];
  Object.entries(requestHeaders).forEach(([key, value]) => lines.push(`${key}: ${value}`));
  lines.push('Connection: close', '', '');
  secure.write(Buffer.concat([Buffer.from(lines.join('\r\n'), 'utf8'), bodyBuffer]));
  const rawResponse = await new Promise((resolve, reject) => {
    const chunks = [];
    const timer = setTimeout(() => secure.destroy(new Error(`HTTPS proxy request timeout: ${url}`)), timeoutMs);
    secure.on('data', chunk => chunks.push(chunk));
    secure.on('end', () => { clearTimeout(timer); resolve(Buffer.concat(chunks)); });
    secure.on('error', error => { clearTimeout(timer); reject(error); });
  });
  const headerEnd = rawResponse.indexOf('\r\n\r\n');
  if (headerEnd < 0) throw new Error(`Invalid HTTP response from ${url}`);
  const head = rawResponse.subarray(0, headerEnd).toString('latin1');
  const status = Number((head.match(/^HTTP\/1\.[01]\s+(\d+)/i) || [])[1] || 0);
  const responseHeaders = {};
  head.split('\r\n').slice(1).forEach(line => {
    const index = line.indexOf(':');
    if (index > 0) responseHeaders[line.slice(0, index).trim().toLowerCase()] = line.slice(index + 1).trim();
  });
  const payload = /chunked/i.test(responseHeaders['transfer-encoding'] || '') ? decodeChunked(rawResponse.subarray(headerEnd + 4)) : rawResponse.subarray(headerEnd + 4);
  return resolveResponse(status, responseHeaders, payload);
}

export function parseJsonText(text) {
  const source = String(text || '').replace(/^\uFEFF/, '').trim();
  if (!source) return null;
  try { return JSON.parse(source); } catch {}
  const start = source.indexOf('{');
  const end = source.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try { return JSON.parse(source.slice(start, end + 1)); } catch {}
  }
  return null;
}

function resolveResponse(status, headers, buffer) {
  const text = buffer.toString('utf8');
  return { status, headers, buffer, text, json: parseJsonText(text) };
}
