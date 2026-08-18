import { db, listCookies, logEvent } from './db.js';
import { encryptSecret, decryptSecret } from './vault.js';
import { nowIso, uid } from './utils.js';
import { httpRequest } from './provider/httpRequest.js';

function normalizeCookie(cookie) {
  if (!cookie?.name) return null;
  return {
    name: String(cookie.name),
    value: String(cookie.value ?? ''),
    domain: cookie.domain || '.tiktok.com',
    path: cookie.path || '/'
  };
}

function parseNetscape(text) {
  const rows = [];
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || (line.startsWith('#') && !line.startsWith('#HttpOnly_'))) continue;
    const parts = line.replace(/^#HttpOnly_/, '').split(/\t+/);
    if (parts.length < 7) continue;
    const [domain, , cookiePath, , , name, ...valueParts] = parts;
    rows.push(normalizeCookie({ domain, path: cookiePath, name, value: valueParts.join('\t') }));
  }
  return rows.filter(Boolean);
}

export function parseCookieText(text) {
  const raw = String(text || '').trim();
  if (!raw) return [];
  try {
    const json = JSON.parse(raw);
    const source = Array.isArray(json) ? json : Array.isArray(json?.cookies) ? json.cookies : [];
    if (source.length) return source.map(normalizeCookie).filter(Boolean);
  } catch {}
  const netscape = parseNetscape(raw);
  if (netscape.length) return netscape;
  if (raw.includes('=')) {
    return raw.split(';').map(item => item.trim()).filter(Boolean).map(pair => {
      const index = pair.indexOf('=');
      return index > 0 ? normalizeCookie({ name: pair.slice(0, index).trim(), value: pair.slice(index + 1) }) : null;
    }).filter(Boolean);
  }
  return [];
}

export function cookieHeaderFromText(text) {
  const map = new Map();
  for (const cookie of parseCookieText(text)) {
    const domain = String(cookie.domain || '').replace(/^\./, '');
    if (!domain || /(^|\.)tiktok\.com$/i.test(domain)) map.set(cookie.name, cookie.value);
  }
  return [...map.entries()].map(([name, value]) => `${name}=${value}`).join('; ');
}

export function csrfFromCookieHeader(header) {
  const match = String(header || '').match(/(?:^|;\s*)csrftoken=([^;]+)/);
  return match ? decodeURIComponent(match[1]) : '';
}

export function importCookie({ name, content }) {
  const cookies = parseCookieText(content);
  if (!cookies.length) throw Object.assign(new Error('未识别到有效 Cookie。'), { statusCode: 422 });
  const id = uid('cookie');
  const at = nowIso();
  db.prepare(`INSERT INTO cookie_profiles(id,name,encrypted_secret,status,cookie_count,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?)`).run(id, String(name || 'Cookie Profile').slice(0, 100), encryptSecret(content), 'unknown', cookies.length, at, at);
  logEvent({ stage: 'cookie_imported', entityType: 'cookie', entityId: id, message: 'Cookie imported', payload: { cookieCount: cookies.length } });
  return listCookies().find(item => item.id === id);
}

export function deleteCookie(id) {
  db.prepare('DELETE FROM cookie_profiles WHERE id=?').run(id);
  logEvent({ stage: 'cookie_deleted', entityType: 'cookie', entityId: id, message: 'Cookie deleted' });
}

export function getCookieSecret(id) {
  const row = db.prepare('SELECT * FROM cookie_profiles WHERE id=?').get(id);
  if (!row) throw Object.assign(new Error('Cookie Profile 不存在。'), { statusCode: 404 });
  const content = decryptSecret(row.encrypted_secret);
  return { row, content, cookieHeader: cookieHeaderFromText(content) };
}

export async function validateCookie(id) {
  const { row, cookieHeader } = getCookieSecret(id);
  if (!cookieHeader) throw new Error('Cookie 内容无法转换为请求头。');
  const csrf = csrfFromCookieHeader(cookieHeader);
  const body = JSON.stringify({ pageOffset: 0, pageLimit: 1, edited: false, sorted: 2, mini_app_type: [2, 3, 11, 13], showPlayInfo: true, parseSettings: false });
  try {
    const response = await httpRequest('https://ads.tiktok.com/creative_bff_i18n/api/cue/history/tasks?aid=585599&app_name=creative_aio_client&device_platform=web', {
      method: 'POST',
      headers: {
        accept: 'application/json, text/plain, */*',
        'content-type': 'application/json',
        cookie: cookieHeader,
        referer: 'https://ads.tiktok.com/creative/creativestudio/image-to-video',
        'x-creative-source': 'creative_studio',
        ...(csrf ? { 'x-csrftoken': csrf } : {})
      },
      body,
      timeoutMs: 60000,
      retries: 1
    });
    const valid = Number(response.json?.code) === 0 && Array.isArray(response.json?.data?.draft_infos);
    const rawMessage = String(response.json?.message || response.text || `HTTP ${response.status}`).slice(0, 1000);
    const message = valid
      ? 'Cookie 有效。'
      : /login required/i.test(rawMessage)
        ? 'Cookie 已失效，或导出的 Cookie 不包含广告后台登录态（Login Required）。请在已登录 ads.tiktok.com 的浏览器中重新导出 Cookie。'
        : `Cookie 验证失败：${rawMessage || '广告后台未返回有效登录态。'}`;
    const at = nowIso();
    db.prepare('UPDATE cookie_profiles SET status=?,last_error=?,validated_at=?,updated_at=? WHERE id=?')
      .run(valid ? 'valid' : 'invalid', valid ? null : message.slice(0, 1000), at, at, id);
    logEvent({ level: valid ? 'info' : 'error', stage: 'cookie_validated', entityType: 'cookie', entityId: id, message: valid ? 'Cookie valid' : 'Cookie invalid', payload: { status: response.status, code: response.json?.code, rawMessage: rawMessage.slice(0, 300) } });
    return { valid, status: response.status, code: response.json?.code, message, rawMessage };
  } catch (error) {
    const at = nowIso();
    db.prepare('UPDATE cookie_profiles SET status=?,last_error=?,validated_at=?,updated_at=? WHERE id=?')
      .run('invalid', String(error.message).slice(0, 1000), at, at, id);
    throw error;
  }
}

export { listCookies };
