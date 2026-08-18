import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { PROVIDER_TEMPLATE_PATH } from '../config.js';
import { db, logEvent } from '../db.js';
import { getCookieSecret, csrfFromCookieHeader } from '../cookieService.js';
import { md5Hex, nowIso, sha256Hex, uid } from '../utils.js';
import { httpRequest } from './httpRequest.js';

export const PROVIDER_KEY = 'creative-studio-http-i2v';
const SERVICE_ID = 'n2703mo9gi';
const BUCKET = 'tos-alisg-i-n2703mo9gi-sg';
const UPLOAD_HOST = 'tos-my216-up.tiktokcdn.com';
const IMAGE_HOST = 'https://p19-creative-tool-sg.ibyteimg.com';
const COMMON_QUERY = 'aid=585599&app_name=creative_aio_client&device_platform=web';

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32Hex(buffer) {
  let crc = -1;
  for (let i = 0; i < buffer.length; i += 1) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ buffer[i]) & 0xff];
  return ((crc ^ -1) >>> 0).toString(16).padStart(8, '0');
}

function hmac(key, value, encoding) {
  return crypto.createHmac('sha256', key).update(value, 'utf8').digest(encoding);
}

function normalizedHeaders(headers) {
  const out = {};
  for (const [key, value] of Object.entries(headers)) out[key.toLowerCase()] = String(value).trim().replace(/\s+/g, ' ');
  return out;
}

function canonicalQuery(params) {
  return [...params.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join('&');
}

function signAws({ method, url, headers, body = '', accessKeyId, secretAccessKey, amzDate, service = 'imagex', region = 'i18n' }) {
  const target = new URL(url);
  const lower = normalizedHeaders(headers);
  const names = Object.keys(lower).sort();
  const signedHeaders = names.join(';');
  const canonicalHeaders = names.map(name => `${name}:${lower[name]}\n`).join('');
  const payloadHash = lower['x-amz-content-sha256'] || sha256Hex(body);
  const canonicalRequest = [method.toUpperCase(), target.pathname || '/', canonicalQuery(target.searchParams), canonicalHeaders, signedHeaders, payloadHash].join('\n');
  const date = amzDate.slice(0, 8);
  const scope = `${date}/${region}/${service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256Hex(canonicalRequest)].join('\n');
  const kDate = hmac(`AWS4${secretAccessKey}`, date);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  const kSigning = hmac(kService, 'aws4_request');
  const signature = hmac(kSigning, stringToSign, 'hex');
  return `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
}

function buildSessionKey({ storeUri, auth, uploadId, userId = '' }) {
  return Buffer.from(JSON.stringify({
    accountType: 'ImageX',
    appId: '',
    bizType: '',
    fileType: 'image',
    legal: '',
    storeInfos: JSON.stringify([{ StoreUri: storeUri, Auth: auth, UploadID: uploadId, UploadHeader: null }]),
    uploadHost: UPLOAD_HOST,
    uri: storeUri,
    userId
  })).toString('base64');
}

function creativeImageUrl(imageUri) {
  if (/^https?:\/\//i.test(imageUri)) return imageUri;
  return `${IMAGE_HOST}/${imageUri}~tplv-n2703mo9gi-webp:1280:1280.image`;
}

async function fetchUploadToken(cookieHeader, csrf) {
  const response = await httpRequest('https://ads.tiktok.com/creative_bff_i18n/api/cue/upload/token?aid=585599&app_name=creative_aio_client&device_platform=web', {
    method: 'POST',
    headers: {
      accept: 'application/json, text/plain, */*',
      'content-type': 'application/json',
      cookie: cookieHeader,
      referer: 'https://ads.tiktok.com/creative/creativestudio/image-to-video',
      'x-creative-source': 'CreativeStudio/MiniApp/ImageToVideo',
      ...(csrf ? { 'x-csrftoken': csrf } : {})
    },
    body: '{}',
    timeoutMs: 60000,
    retries: 1
  });
  if (response.status < 200 || response.status >= 300 || Number(response.json?.code) !== 0) {
    throw new Error(`upload/token failed: HTTP ${response.status} ${String(response.json?.message || response.text).slice(0, 500)}`);
  }
  return response.json.data;
}

async function applyUpload({ token, fileSize, cookieHeader }) {
  const url = new URL('https://ads.tiktok.com/creative/creativestudio/upload-proxy');
  url.searchParams.set('Action', 'ApplyImageUpload');
  url.searchParams.set('Version', '2018-08-01');
  url.searchParams.set('ServiceId', SERVICE_ID);
  url.searchParams.set('FileSize', String(fileSize));
  url.searchParams.set('s', Math.random().toString(36).slice(2, 13));
  url.searchParams.set('device_platform', 'web');
  const amzDate = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  const signed = { 'x-amz-date': amzDate, 'x-amz-security-token': token.SessionToken || '' };
  const authorization = signAws({ method: 'GET', url: url.toString(), headers: signed, accessKeyId: token.AccessKeyId, secretAccessKey: token.SecretAccessKey, amzDate });
  const response = await httpRequest(url.toString(), {
    headers: { ...signed, authorization, cookie: cookieHeader, referer: 'https://ads.tiktok.com/creative/creativestudio/image-to-video' },
    timeoutMs: 90000,
    retries: 2
  });
  if (response.status < 200 || response.status >= 300 || !response.json?.Result?.UploadAddress) {
    throw new Error(`ApplyImageUpload failed: HTTP ${response.status} ${String(response.text).slice(0, 500)}`);
  }
  return response.json.Result.UploadAddress;
}

async function uploadBytes({ buffer, storeUri, auth }) {
  const response = await httpRequest(`https://${UPLOAD_HOST}/upload/v1/${storeUri}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/octet-stream',
      authorization: auth,
      'content-crc32': crc32Hex(buffer),
      'content-disposition': 'attachment; filename="undefined"',
      'x-storage-u': 'ad_creative_tools_unknown_user',
      referer: 'https://ads.tiktok.com/'
    },
    body: buffer,
    timeoutMs: 120000,
    retries: 2
  });
  if (response.status < 200 || response.status >= 300 || (response.text && Number(response.json?.code) !== 2000)) {
    throw new Error(`TOS upload failed: HTTP ${response.status} ${String(response.text).slice(0, 500)}`);
  }
}

async function commitUpload({ cookieHeader, token, storeUri, auth, uploadId, sessionKey }) {
  const url = `https://ads.tiktok.com/creative/creativestudio/upload-proxy?Action=CommitImageUpload&Version=2018-08-01&ServiceId=${SERVICE_ID}`;
  const body = JSON.stringify({ SessionKey: sessionKey || buildSessionKey({ storeUri, auth, uploadId }) });
  const amzDate = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  const signed = {
    'x-amz-content-sha256': sha256Hex(body),
    'x-amz-date': amzDate,
    'x-amz-security-token': token.SessionToken || ''
  };
  const authorization = signAws({ method: 'POST', url, headers: signed, body, accessKeyId: token.AccessKeyId, secretAccessKey: token.SecretAccessKey, amzDate });
  const response = await httpRequest(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...signed, authorization, cookie: cookieHeader, referer: 'https://ads.tiktok.com/creative/creativestudio/image-to-video' },
    body,
    timeoutMs: 90000,
    retries: 2
  });
  if (response.status < 200 || response.status >= 300 || !response.json?.Result) {
    throw new Error(`CommitImageUpload failed: HTTP ${response.status} ${String(response.text).slice(0, 500)}`);
  }
  return response.json;
}

const remoteImageInflight = new Map();
const remoteReferenceInflight = new Map();

async function uploadRemoteImage(asset, cookieProfileId) {
  const { cookieHeader } = getCookieSecret(cookieProfileId);
  const csrf = csrfFromCookieHeader(cookieHeader);
  const token = await fetchUploadToken(cookieHeader, csrf);
  const buffer = fs.readFileSync(asset.absolute_path);
  const address = await applyUpload({ token, fileSize: buffer.length, cookieHeader });
  const store = address.StoreInfos?.[0];
  if (!store) throw new Error('ApplyImageUpload did not return StoreInfos.');
  await uploadBytes({ buffer, storeUri: store.StoreUri, auth: store.Auth });
  await new Promise(resolve => setTimeout(resolve, 500));
  const commit = await commitUpload({ cookieHeader, token, storeUri: store.StoreUri, auth: store.Auth, uploadId: store.UploadID, sessionKey: address.SessionKey });
  const plugin = commit?.Result?.PluginResult?.[0] || {};
  const result = commit?.Result?.Results?.[0] || {};
  const imageUri = plugin.ImageUri || result.Uri || store.StoreUri;
  const remote = {
    cdnUrl: creativeImageUrl(imageUri),
    remoteUri: imageUri,
    width: Number(plugin.ImageWidth || asset.width || 0),
    height: Number(plugin.ImageHeight || asset.height || 0),
    metadata: { md5: plugin.ImageMd5 || md5Hex(buffer), format: plugin.ImageFormat || path.extname(asset.absolute_path).slice(1), size: plugin.ImageSize || buffer.length }
  };
  const at = nowIso();
  db.prepare(`INSERT INTO media_cache(id,asset_sha256,cookie_profile_id,provider_key,cdn_url,remote_uri,width,height,metadata_json,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(asset_sha256,cookie_profile_id,provider_key) DO UPDATE SET cdn_url=excluded.cdn_url,remote_uri=excluded.remote_uri,width=excluded.width,height=excluded.height,metadata_json=excluded.metadata_json,updated_at=excluded.updated_at`)
    .run(uid('cache'), asset.sha256, cookieProfileId, PROVIDER_KEY, remote.cdnUrl, remote.remoteUri, remote.width, remote.height, JSON.stringify(remote.metadata), at, at);
  logEvent({ stage: 'image_uploaded', entityType: 'asset', entityId: asset.id, message: 'Image uploaded to provider CDN', payload: { cacheHit: false, width: remote.width, height: remote.height } });
  return { ...remote, cacheHit: false };
}

export async function resolveRemoteImage(asset, cookieProfileId) {
  const cached = db.prepare(`SELECT * FROM media_cache WHERE asset_sha256=? AND cookie_profile_id=? AND provider_key=?`)
    .get(asset.sha256, cookieProfileId, PROVIDER_KEY);
  if (cached?.cdn_url) return { cdnUrl: cached.cdn_url, width: cached.width, height: cached.height, cacheHit: true, fileType: 'image' };

  const key = `${cookieProfileId}:${asset.sha256}`;
  if (remoteImageInflight.has(key)) return remoteImageInflight.get(key);
  const promise = uploadRemoteImage(asset, cookieProfileId)
    .then(remote => ({ ...remote, fileType: 'image' }))
    .finally(() => remoteImageInflight.delete(key));
  remoteImageInflight.set(key, promise);
  return promise;
}

function providerHeaders(cookieHeader, csrf, contentType = 'application/json') {
  return {
    accept: 'application/json, text/plain, */*',
    'content-type': contentType,
    'agw-js-conv': 'str',
    'user-agent': 'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Mobile Safari/537.36',
    cookie: cookieHeader,
    referer: 'https://ads.tiktok.com/creative/creativestudio/image-to-video',
    'x-creative-source': 'CreativeStudio/MiniApp/ImageToVideo',
    ...(csrf ? { 'x-csrftoken': csrf } : {})
  };
}

async function applyReferenceUpload({ fileSize, cookieHeader, csrf, token }) {
  const url = new URL('https://ads.tiktok.com/creative/creativestudio/upload-proxy');
  url.searchParams.set('Action', 'ApplyUploadInner');
  url.searchParams.set('Version', '2020-11-19');
  url.searchParams.set('SpaceName', 'ad_site');
  url.searchParams.set('FileType', 'video');
  url.searchParams.set('IsInner', '1');
  url.searchParams.set('FileSize', String(fileSize));
  url.searchParams.set('s', crypto.randomBytes(6).toString('base64url').toLowerCase());
  url.searchParams.set('device_platform', 'web');
  const amzDate = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  const signed = { 'x-amz-date': amzDate, 'x-amz-security-token': token.SessionToken || '' };
  const authorization = signAws({
    method: 'GET',
    url: url.toString(),
    headers: signed,
    accessKeyId: token.AccessKeyId,
    secretAccessKey: token.SecretAccessKey,
    amzDate,
    service: 'vod',
    region: 'i18n'
  });
  const response = await httpRequest(url.toString(), {
    headers: { ...providerHeaders(cookieHeader, csrf), ...signed, authorization },
    timeoutMs: 120000,
    retries: 2
  });
  const node = response.json?.Result?.InnerUploadAddress?.UploadNodes?.[0];
  const store = node?.StoreInfos?.[0];
  if (response.status < 200 || response.status >= 300 || !node?.Vid || !store?.StoreUri || !store?.Auth) {
    throw new Error(`ApplyUploadInner failed: HTTP ${response.status} ${String(response.text).slice(0, 1200)}`);
  }
  return {
    vid: node.Vid,
    uploadHost: node.UploadHost || response.json?.Result?.InnerUploadAddress?.UploadHost || 'tos-my16-up.tiktokcdn.com',
    storeUri: store.StoreUri,
    auth: store.Auth,
    uploadId: store.UploadID || '',
    sessionKey: node.SessionKey || ''
  };
}

async function finalizeReferenceUpload({ url, applied, token, partNumber, partCrc, totalSize, isVideo }) {
  const body = JSON.stringify({
    parts_crc: `${partNumber}:${partCrc}`,
    post_upload_param: {
      sts2_token: token.SessionToken || '',
      sts2_secret: token.SecretAccessKey || '',
      session_key: applied.sessionKey,
      functions: isVideo ? [{ name: 'snapshot', input: { snapshot_time: 0, skip_black_detect: false } }] : []
    }
  });
  const response = await httpRequest(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-upload-with-postupload': '1',
      'x-phase': 'finish',
      'x-enable-upload-mode': 'part',
      'x-size': String(totalSize),
      'x-storage-u': 'ad_creative_tools_unknown_user',
      authorization: applied.auth,
      referer: 'https://ads.tiktok.com/'
    },
    body,
    timeoutMs: 240000,
    retries: 2
  });
  if (response.status < 200 || response.status >= 300 || Number(response.json?.code) !== 2000 || !response.json?.data?.post_upload_resp?.results?.[0]) {
    throw new Error(`Media post-upload finalize failed: HTTP ${response.status} ${String(response.text).slice(0, 1600)}`);
  }
  return response.json.data.post_upload_resp.results[0];
}

async function uploadReferenceBytes({ buffer, applied, token, isVideo }) {
  if (!applied.uploadId) throw new Error(`ApplyUploadInner did not return UploadID for ${applied.vid}`);
  const url = `https://${applied.uploadHost}/upload/v1/${applied.storeUri}?uploadid=${encodeURIComponent(applied.uploadId)}&device_platform=web`;
  const response = await httpRequest(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/octet-stream',
      authorization: applied.auth,
      'content-crc32': crc32Hex(buffer),
      'content-disposition': 'attachment; filename="undefined"',
      'x-storage-u': 'ad_creative_tools_unknown_user',
      'x-phase': 'transfer',
      'x-part-number': '1',
      'x-part-offset': '0',
      referer: 'https://ads.tiktok.com/'
    },
    body: buffer,
    timeoutMs: 240000,
    retries: 2
  });
  if (response.status < 200 || response.status >= 300 || Number(response.json?.code) !== 2000) {
    throw new Error(`Reference media upload failed: HTTP ${response.status} ${String(response.text).slice(0, 1600)}`);
  }
  const direct = response.json?.data?.post_upload_resp?.results?.[0];
  if (direct) return direct;
  return finalizeReferenceUpload({
    url,
    applied,
    token,
    partNumber: Number(response.json?.data?.part_number || 1),
    partCrc: response.json?.data?.crc32 || crc32Hex(buffer),
    totalSize: buffer.length,
    isVideo
  });
}

async function bindReferenceVideo(vid, cookieHeader, csrf) {
  const response = await httpRequest(`https://ads.tiktok.com/creative_bff_i18n/api/cue/lego/bind_videos?${COMMON_QUERY}`, {
    method: 'POST',
    headers: providerHeaders(cookieHeader, csrf),
    body: JSON.stringify({ vids: [vid] }),
    timeoutMs: 120000,
    retries: 2
  });
  if (response.status < 200 || response.status >= 300 || Number(response.json?.code) !== 0 || !response.json?.data?.[vid]) {
    throw new Error(`bind_videos failed for ${vid}: HTTP ${response.status} ${String(response.text).slice(0, 1200)}`);
  }
  return response.json.data[vid];
}

async function fetchReferenceInfo(vid, cookieHeader, csrf) {
  const url = `https://ads.tiktok.com/creative_bff_i18n/api/cue/video_info?vid=${encodeURIComponent(vid)}&${COMMON_QUERY}`;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const response = await httpRequest(url, {
      headers: providerHeaders(cookieHeader, csrf),
      timeoutMs: 120000,
      retries: 1
    });
    const info = response.json?.data?.[vid];
    const mainUrl = info?.VideoInfos?.[0]?.MainUrl || '';
    if (response.status >= 200 && response.status < 300 && Number(response.json?.code) === 0 && String(info?.Status || '') === '10' && mainUrl) {
      return {
        mediaType: info.MediaType || '',
        duration: Number(info.Duration || 0),
        previewUrl: mainUrl,
        posterUrl: info.PosterUrl || ''
      };
    }
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
  throw new Error(`video_info timeout for ${vid}`);
}

async function uploadRemoteReferenceMedia(item, cookieProfileId) {
  const media = item.media || item;
  const clip = item.clip || null;
  const sourcePath = clip?.clip_path || media.source_path;
  const sha = clip?.sha256 || media.sha256;
  const fileType = media.media_type === 'audio' ? 'audio' : 'video';
  if (!sourcePath || !fs.existsSync(sourcePath)) throw new Error(`参考${fileType === 'video' ? '视频' : '音频'}文件不存在：${sourcePath || media.file_name}`);

  const { cookieHeader } = getCookieSecret(cookieProfileId);
  const csrf = csrfFromCookieHeader(cookieHeader);
  const token = await fetchUploadToken(cookieHeader, csrf);
  const buffer = fs.readFileSync(sourcePath);
  const applied = await applyReferenceUpload({ fileSize: buffer.length, cookieHeader, csrf, token });
  await uploadReferenceBytes({ buffer, applied, token, isVideo: fileType === 'video' });
  await bindReferenceVideo(applied.vid, cookieHeader, csrf);
  const info = await fetchReferenceInfo(applied.vid, cookieHeader, csrf);
  const remote = {
    fileType,
    vid: applied.vid,
    remoteUri: applied.vid,
    cdnUrl: info.previewUrl,
    previewUrl: info.previewUrl,
    posterUrl: info.posterUrl,
    duration: info.duration,
    metadata: {
      fileType,
      mediaType: info.mediaType,
      posterUrl: info.posterUrl,
      duration: info.duration,
      size: buffer.length,
      sourcePath
    }
  };
  const at = nowIso();
  db.prepare(`INSERT INTO media_cache(id,asset_sha256,cookie_profile_id,provider_key,cdn_url,remote_uri,width,height,metadata_json,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(asset_sha256,cookie_profile_id,provider_key) DO UPDATE SET cdn_url=excluded.cdn_url,remote_uri=excluded.remote_uri,width=excluded.width,height=excluded.height,metadata_json=excluded.metadata_json,updated_at=excluded.updated_at`)
    .run(uid('cache'), sha, cookieProfileId, PROVIDER_KEY, remote.cdnUrl, remote.remoteUri, Number(media.width || 0), Number(media.height || 0), JSON.stringify(remote.metadata), at, at);
  logEvent({
    stage: 'reference_media_uploaded',
    entityType: 'reference_media',
    entityId: media.id,
    message: `${fileType} uploaded and bound to provider`,
    payload: { vid: remote.vid, duration: remote.duration, cacheHit: false, clipped: Boolean(clip) }
  });
  return { ...remote, cacheHit: false };
}

export async function resolveRemoteReferenceMedia(item, cookieProfileId) {
  const media = item.media || item;
  const clip = item.clip || null;
  const sha = clip?.sha256 || media.sha256;
  const fileType = media.media_type === 'audio' ? 'audio' : 'video';
  const cached = db.prepare(`SELECT * FROM media_cache WHERE asset_sha256=? AND cookie_profile_id=? AND provider_key=?`)
    .get(sha, cookieProfileId, PROVIDER_KEY);
  if (cached?.cdn_url && cached?.remote_uri) {
    let metadata = {};
    try { metadata = JSON.parse(cached.metadata_json || '{}'); } catch {}
    if (metadata.fileType === fileType) {
      return {
        fileType,
        vid: cached.remote_uri,
        remoteUri: cached.remote_uri,
        cdnUrl: cached.cdn_url,
        previewUrl: cached.cdn_url,
        posterUrl: metadata.posterUrl || '',
        duration: Number(metadata.duration || 0),
        cacheHit: true
      };
    }
  }

  const key = `${cookieProfileId}:${fileType}:${sha}`;
  if (remoteReferenceInflight.has(key)) return remoteReferenceInflight.get(key);
  const promise = uploadRemoteReferenceMedia(item, cookieProfileId)
    .finally(() => remoteReferenceInflight.delete(key));
  remoteReferenceInflight.set(key, promise);
  return promise;
}

function readTemplate() {
  if (!fs.existsSync(PROVIDER_TEMPLATE_PATH)) throw new Error(`Provider template missing: ${PROVIDER_TEMPLATE_PATH}`);
  return JSON.parse(fs.readFileSync(PROVIDER_TEMPLATE_PATH, 'utf8'));
}

function imageSetting(base, url, index, name) {
  return {
    ...(base || {}),
    fileType: 'image',
    id: crypto.randomUUID(),
    label: `image ${index + 1}`,
    name,
    previewUrl: url,
    imageSrcSet: { ...((base || {}).imageSrcSet || {}), origin: url },
    previewUrlSrcSet: { ...((base || {}).previewUrlSrcSet || {}), origin: url }
  };
}

function referenceSetting(item) {
  if (item.fileType === 'video') {
    return {
      id: crypto.randomUUID(),
      fileType: 'video',
      vid: item.vid,
      postUrl: item.posterUrl || '',
      previewUrl: item.previewUrl || item.cdnUrl || ''
    };
  }
  return {
    id: crypto.randomUUID(),
    fileType: 'audio',
    vid: item.vid,
    postUrl: '',
    previewUrl: item.previewUrl || item.cdnUrl || ''
  };
}

function buildBody(template, prompt, media, duration) {
  const body = structuredClone(template.body);
  const imageMedia = media.filter(item => !item.fileType || item.fileType === 'image');
  const urls = imageMedia.map(item => item.cdnUrl);
  body.image = urls[0] || '';
  body.images = urls;
  body.mentions = media.map(item => {
    if (item.fileType === 'video') return { type: 2, id: item.vid };
    if (item.fileType === 'audio') return { type: 101, id: item.vid };
    return { type: 1, id: item.cdnUrl };
  });
  body.prompt = prompt;
  body.duration = duration;
  if (typeof body.settings === 'string') {
    const settings = JSON.parse(body.settings);
    const base = Array.isArray(settings.images) ? settings.images : [];
    let imageIndex = 0;
    settings.prompt = prompt;
    settings.duration = duration;
    settings.images = media.map(item => {
      if (item.fileType === 'video' || item.fileType === 'audio') return referenceSetting(item);
      const value = imageSetting(base[imageIndex] || base[0], item.cdnUrl, imageIndex, item.name || `image_${imageIndex + 1}`);
      imageIndex += 1;
      return value;
    });
    body.settings = JSON.stringify(settings);
  }
  return body;
}

function rejectedModerationItem(value) {
  const data = value?.data;
  if (!data || typeof data !== 'object') return null;
  const groups = [
    ['text', data.text],
    ['prompt', data.prompt],
    ['image', data.image],
    ['video', data.video],
    ['audio', data.audio]
  ];
  for (const [kind, items] of groups) {
    if (!Array.isArray(items)) continue;
    const rejected = items.find(item => item?.isRejected === true);
    if (rejected) return {
      kind,
      reason: String(rejected.rejectReason || rejected.commonReason || rejected.reasonStarlingKey || '').trim(),
      code: String(rejected.code || value?.code || '').trim()
    };
  }
  return null;
}

function extractTaskId(value, depth = 0, seen = new WeakSet()) {
  if (!value || typeof value !== 'object' || depth > 8 || seen.has(value)) return '';
  seen.add(value);
  for (const [key, child] of Object.entries(value)) {
    if (/^(taskId|task_id|renderTaskId|render_task_id|generateTaskId|generate_task_id)$/i.test(key) && child != null && typeof child !== 'object') {
      const id = String(child).trim();
      if (id && id !== '0') return id;
    }
  }
  for (const child of Object.values(value)) {
    const found = extractTaskId(child, depth + 1, seen);
    if (found) return found;
  }
  return '';
}

export async function submitGeneration({ cookieProfileId, prompt, duration, media }) {
  const template = readTemplate();
  const { cookieHeader } = getCookieSecret(cookieProfileId);
  const csrf = csrfFromCookieHeader(cookieHeader);
  const body = buildBody(template, prompt, media, duration);
  const response = await httpRequest(template.url, {
    method: 'POST',
    headers: {
      accept: 'application/json, text/plain, */*',
      'content-type': 'application/json; charset=utf-8',
      cookie: cookieHeader,
      referer: 'https://ads.tiktok.com/creative/creativestudio/image-to-video',
      'x-creative-source': 'creative_studio',
      ...(csrf ? { 'x-csrftoken': csrf } : {})
    },
    body: JSON.stringify(body),
    timeoutMs: 120000,
    retries: 0
  });
  const taskId = extractTaskId(response.json);
  if (!taskId) {
    const moderation = rejectedModerationItem(response.json);
    if (moderation) {
      const kindLabels = { text: '提示词文本', prompt: '提示词', image: '参考图片', video: '参考视频', audio: '参考音频' };
      const label = kindLabels[moderation.kind] || moderation.kind;
      const reason = moderation.reason || 'TikTok 内容审核拒绝';
      throw Object.assign(new Error(`${label}被 TikTok 审核拒绝：${reason}`), {
        code: `TIKTOK_${moderation.kind.toUpperCase()}_REJECTED`,
        moderation,
        providerResponse: response.json || { status: response.status, text: response.text.slice(0, 2000) }
      });
    }
    const message = response.json?.message || response.json?.msg || response.json?.error || response.text || `HTTP ${response.status}`;
    throw Object.assign(new Error(`提交未返回 taskId：${String(message).slice(0, 800)}`), { providerResponse: response.json || { status: response.status, text: response.text.slice(0, 2000) } });
  }
  return { taskId, response: response.json, status: response.status };
}

function collectUrls(value, out = [], depth = 0, seen = new WeakSet()) {
  if (value == null || depth > 10) return out;
  if (typeof value === 'string') {
    const normalized = value.replace(/\\u0026/g, '&').replace(/\\\//g, '/');
    const matches = normalized.match(/https?:\/\/[^\s"'<>\\]+/g) || [];
    matches.forEach(url => out.push(url));
    return out;
  }
  if (typeof value !== 'object' || seen.has(value)) return out;
  seen.add(value);
  if (Array.isArray(value)) value.forEach(item => collectUrls(item, out, depth + 1, seen));
  else Object.values(value).forEach(item => collectUrls(item, out, depth + 1, seen));
  return out;
}

function isVideoUrl(url) {
  const value = String(url || '');
  if (!/^https?:\/\//i.test(value)) return false;
  if (/tplv-noop\.image|cover|common-sign|\.image(?:\?|$)|\.avif(?:\?|$)|\.webp(?:\?|$)/i.test(value)) return false;
  return /mime_type=video_mp4|\.mp4(?:\?|$)|v\d+-ad-creative|video\/tos|video_mp4/i.test(value);
}

function scoreVideoUrl(url) {
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

function findRemoteError(value, depth = 0, seen = new WeakSet()) {
  if (!value || typeof value !== 'object' || depth > 8 || seen.has(value)) return '';
  seen.add(value);
  const keys = /^(error|error_message|errorMessage|generateErrorMessage|generate_error_message|fail_reason|failReason|failure_reason|safety_message|safetyMessage)$/i;
  for (const [key, child] of Object.entries(value)) {
    if (keys.test(key) && child != null && typeof child !== 'object') {
      const text = String(child).trim();
      if (text && text !== '0' && text.toLowerCase() !== 'null') return text;
    }
  }
  for (const child of Object.values(value)) {
    const found = findRemoteError(child, depth + 1, seen);
    if (found) return found;
  }
  return '';
}

function findRemoteErrorCode(value, depth = 0, seen = new WeakSet()) {
  if (!value || typeof value !== 'object' || depth > 8 || seen.has(value)) return '';
  seen.add(value);
  const keys = /^(error_code|errorCode|generateErrorCode|generate_error_code|err_code|errCode|fail_code|failCode|failure_code|failureCode|safety_code|safetyCode)$/i;
  for (const [key, child] of Object.entries(value)) {
    if (keys.test(key) && child != null && typeof child !== 'object') {
      const code = String(child).trim();
      if (code && code !== '0' && code.toLowerCase() !== 'null') return code;
    }
  }
  for (const child of Object.values(value)) {
    const found = findRemoteErrorCode(child, depth + 1, seen);
    if (found) return found;
  }
  return '';
}

export function summarizeRemoteTask(item) {
  if (!item) return { found: false, ready: false, failed: false, status: 'not_visible_yet', videoUrls: [], error: '' };
  let settings = null;
  try { settings = typeof item.settings === 'string' ? JSON.parse(item.settings) : item.settings; } catch {}
  const outputCandidates = [
    ...collectUrls(item.videoInfo || {}),
    ...collectUrls(item.video_info || {}),
    item.previewLink,
    item.preview_link
  ].filter(Boolean);
  const videoUrls = [...new Set(outputCandidates.filter(isVideoUrl))].sort((a, b) => scoreVideoUrl(b) - scoreVideoUrl(a));
  const rawStatuses = [item.status, item.taskStatus, item.draftTaskStatus, item.renderTaskStatus]
    .filter(value => value !== undefined && value !== null);
  const statusText = [...rawStatuses, item.exported, item.hasContent]
    .filter(value => value !== undefined && value !== null)
    .map(String)
    .join('/');
  const error = findRemoteError(item);
  const errorCode = findRemoteErrorCode(item);
  const textualFailure = Boolean(errorCode) || /fail|failed|error|reject|cancel|safety/i.test(`${statusText} ${error}`);
  const generating = rawStatuses.some(value => Number(value) === 2);
  const ready = videoUrls.length > 0 && !textualFailure;
  return {
    found: true,
    ready,
    failed: textualFailure,
    status: textualFailure ? 'remote_failed' : ready ? 'video_ready' : generating ? 'processing' : statusText || 'processing',
    videoUrls,
    error,
    errorCode,
    vid: item.vid || '',
    watermarkVid: item.watermarkVid || '',
    previewLink: item.previewLink || '',
    exported: Boolean(item.exported),
    duration: settings?.duration || null,
    raw: item
  };
}

function historyRequestBody({ pageOffset = 0, pageLimit = 50, startTime = null } = {}) {
  const defaultStart = Math.floor(Date.now() / 1000) - 90 * 24 * 60 * 60;
  return JSON.stringify({
    pageOffset,
    pageLimit,
    edited: false,
    sorted: 2,
    start_time: String(startTime || defaultStart),
    mini_app_type: [2, 3, 11, 13],
    showPlayInfo: true,
    parseSettings: true
  });
}

async function fetchHistoryPage(cookieProfileId, options = {}) {
  const { cookieHeader } = getCookieSecret(cookieProfileId);
  const csrf = csrfFromCookieHeader(cookieHeader);
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
    body: historyRequestBody(options),
    timeoutMs: 120000,
    retries: 2
  });
  const businessOk = Number(response.json?.code) === 0 && Array.isArray(response.json?.data?.draft_infos);
  if (!businessOk) {
    const message = response.json?.message || response.json?.msg || `HTTP ${response.status}`;
    throw Object.assign(new Error(`history/tasks failed: ${String(message).slice(0, 400)}`), {
      code: 'HISTORY_REQUEST_FAILED',
      providerResponse: response.json || { status: response.status, text: response.text.slice(0, 1000) }
    });
  }
  return response.json.data.draft_infos;
}

function remoteItemId(item) {
  return [item?.taskId, item?.task_id, item?.id, item?.genDraftId, item?.renderTaskId]
    .filter(value => value != null && String(value).trim())
    .map(String);
}

export async function pollRemoteTasks(cookieProfileId, remoteTaskIds, options = {}) {
  const wanted = new Set(remoteTaskIds.map(String));
  const found = new Map();
  const pageLimit = Math.max(10, Math.min(100, Number(options.pageLimit || 50)));
  const maxPages = Math.max(1, Math.min(20, Number(options.maxPages || 6)));
  for (let page = 0; page < maxPages && found.size < wanted.size; page += 1) {
    const rows = await fetchHistoryPage(cookieProfileId, { pageOffset: page * pageLimit, pageLimit, startTime: options.startTime });
    for (const item of rows) {
      const ids = remoteItemId(item);
      const matched = ids.find(id => wanted.has(id));
      if (matched) found.set(matched, summarizeRemoteTask(item));
    }
    if (rows.length < pageLimit) break;
  }
  return new Map(remoteTaskIds.map(id => [String(id), found.get(String(id)) || summarizeRemoteTask(null)]));
}

export function providerStatus() {
  if (!fs.existsSync(PROVIDER_TEMPLATE_PATH)) return { key: PROVIDER_KEY, ready: false, reason: 'Provider template missing' };
  const template = readTemplate();
  return {
    key: PROVIDER_KEY,
    ready: Boolean(template.url && template.body),
    templateCapturedAt: template.capturedAt || null,
    endpoint: template.url || '',
    capabilities: {
      imageReference: true,
      maxImages: 9,
      videoReference: true,
      maxVideos: 3,
      maxReferenceVideoDurationTotal: 15,
      audioReference: true,
      maxAudios: 3,
      maxReferenceFiles: 12,
      minDuration: 4,
      maxDuration: 15
    }
  };
}
