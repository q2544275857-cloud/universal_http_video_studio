import { db, getSetting } from '../server/db.js';
import { resolveRemoteImage } from '../server/provider/creativeStudioI2V.js';

const cookieProfileId = getSetting('activeCookieId', '');
if (!cookieProfileId) throw new Error('没有活动 Cookie。');

const asset = db.prepare(`SELECT * FROM assets WHERE active=1 ORDER BY updated_at DESC LIMIT 1`).get();
if (!asset) throw new Error('素材库中没有活动图片。');

const startedAt = Date.now();
try {
  const remote = await resolveRemoteImage(asset, cookieProfileId);
  console.log(JSON.stringify({
    ok: true,
    asset: {
      id: asset.id,
      fileName: asset.file_name,
      byteSize: asset.byte_size,
      sha256Prefix: String(asset.sha256).slice(0, 12)
    },
    remote: {
      cacheHit: Boolean(remote.cacheHit),
      width: remote.width || null,
      height: remote.height || null,
      remoteUriPrefix: String(remote.remoteUri || '').slice(0, 40),
      cdnHost: remote.cdnUrl ? new URL(remote.cdnUrl).host : null
    },
    elapsedMs: Date.now() - startedAt
  }, null, 2));
} catch (error) {
  console.error(JSON.stringify({
    ok: false,
    stage: String(error.message || '').split(':')[0],
    error: String(error.message || error).slice(0, 2000),
    elapsedMs: Date.now() - startedAt
  }, null, 2));
  process.exitCode = 1;
}
