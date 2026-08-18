import { httpRequest } from '../server/provider/httpRequest.js';
import { parseChromiumProxyResult, resolveProxyForUrl } from '../server/proxyResolver.js';

const saved = {
  PROXY: process.env.PROXY,
  HTTPS_PROXY: process.env.HTTPS_PROXY,
  HTTP_PROXY: process.env.HTTP_PROXY
};
delete process.env.PROXY;
delete process.env.HTTPS_PROXY;
delete process.env.HTTP_PROXY;

let fetchCalls = 0;
globalThis.__STUDIO_ELECTRON_FETCH__ = async (url, options) => {
  fetchCalls += 1;
  return new Response(JSON.stringify({ ok: true, url, method: options.method }), {
    status: 200,
    headers: { 'content-type': 'application/json' }
  });
};
globalThis.__STUDIO_RESOLVE_SYSTEM_PROXY__ = async () => 'PROXY 127.0.0.1:7890; DIRECT';

const response = await httpRequest('https://ads.tiktok.com/test', { method: 'POST', body: '{}' });
const resolved = await resolveProxyForUrl('https://ads.tiktok.com/test');
const parsedPac = parseChromiumProxyResult('PROXY 10.10.0.2:8080; DIRECT');
const parsedSocks = parseChromiumProxyResult('SOCKS5 127.0.0.1:1080; DIRECT');

if (fetchCalls !== 1) throw new Error(`Expected Electron fetch once, got ${fetchCalls}`);
if (response.status !== 200 || response.json?.ok !== true) throw new Error('Electron fetch response was not parsed.');
if (resolved.mode !== 'system' || !resolved.proxyUrl.includes('127.0.0.1:7890')) throw new Error('System proxy was not resolved.');
if (!parsedPac.proxyUrl.includes('10.10.0.2:8080')) throw new Error('PAC HTTP proxy parsing failed.');
if (!parsedSocks.proxyUrl.startsWith('socks5h://')) throw new Error('SOCKS proxy parsing failed.');

console.log(JSON.stringify({
  ok: true,
  electronFetchCalls: fetchCalls,
  systemProxy: resolved,
  pacProxy: parsedPac,
  socksProxy: parsedSocks
}, null, 2));

for (const [key, value] of Object.entries(saved)) {
  if (value == null) delete process.env[key];
  else process.env[key] = value;
}
delete globalThis.__STUDIO_ELECTRON_FETCH__;
delete globalThis.__STUDIO_RESOLVE_SYSTEM_PROXY__;
