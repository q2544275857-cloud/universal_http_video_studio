function explicitProxyValue() {
  return String(process.env.PROXY || process.env.HTTPS_PROXY || process.env.HTTP_PROXY || '').trim();
}

function normalizeProxyUrl(value, defaultScheme = 'http') {
  const source = String(value || '').trim();
  if (!source) return '';
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(source) ? source : `${defaultScheme}://${source}`;
  const parsed = new URL(withScheme);
  if (!parsed.hostname) throw new Error('代理地址缺少主机名。');
  return parsed.href;
}

export function parseChromiumProxyResult(result) {
  const entries = String(result || '')
    .split(';')
    .map(item => item.trim())
    .filter(Boolean);

  for (const entry of entries) {
    if (/^DIRECT$/i.test(entry)) return { mode: 'direct', proxyUrl: '', raw: String(result || '') };
    const match = entry.match(/^(PROXY|HTTP|HTTPS|SOCKS|SOCKS4|SOCKS5)\s+(.+)$/i);
    if (!match) continue;
    const kind = match[1].toUpperCase();
    const scheme = kind === 'SOCKS4' ? 'socks4' : (kind === 'SOCKS' || kind === 'SOCKS5') ? 'socks5h' : 'http';
    try {
      return { mode: 'system', proxyUrl: normalizeProxyUrl(match[2], scheme), raw: String(result || '') };
    } catch {}
  }

  return { mode: 'direct', proxyUrl: '', raw: String(result || '') };
}

export async function resolveProxyForUrl(url) {
  const explicit = explicitProxyValue();
  if (explicit) {
    try {
      return { mode: 'environment', proxyUrl: normalizeProxyUrl(explicit), raw: explicit };
    } catch {
      throw new Error('代理地址格式无效，请检查 PROXY、HTTPS_PROXY 或 HTTP_PROXY 环境变量。');
    }
  }

  const resolver = globalThis.__STUDIO_RESOLVE_SYSTEM_PROXY__;
  if (typeof resolver === 'function') {
    try {
      return parseChromiumProxyResult(await resolver(String(url)));
    } catch (error) {
      return { mode: 'direct', proxyUrl: '', raw: '', resolveError: String(error?.message || error) };
    }
  }

  if (process.env.DISABLE_DEFAULT_PROXY !== '1') {
    const fallback = String(process.env.DEFAULT_PROXY || 'http://127.0.0.1:7897').trim();
    if (fallback) {
      try {
        return { mode: 'fallback', proxyUrl: normalizeProxyUrl(fallback), raw: fallback };
      } catch {}
    }
  }

  return { mode: 'direct', proxyUrl: '', raw: '' };
}

export function hasExplicitProxy() {
  return Boolean(explicitProxyValue());
}
