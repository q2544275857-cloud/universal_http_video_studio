import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { db, logEvent } from './db.js';
import { MEDIA_CLIP_DIR } from './config.js';
import { nowIso, safeAlias, sha256File, uid } from './utils.js';

const MEDIA_EXTENSIONS = new Map([
  ['.mp4', { type: 'video', mime: 'video/mp4' }],
  ['.mov', { type: 'video', mime: 'video/quicktime' }],
  ['.webm', { type: 'video', mime: 'video/webm' }],
  ['.mkv', { type: 'video', mime: 'video/x-matroska' }],
  ['.m4v', { type: 'video', mime: 'video/x-m4v' }],
  ['.mp3', { type: 'audio', mime: 'audio/mpeg' }],
  ['.wav', { type: 'audio', mime: 'audio/wav' }],
  ['.m4a', { type: 'audio', mime: 'audio/mp4' }],
  ['.aac', { type: 'audio', mime: 'audio/aac' }],
  ['.ogg', { type: 'audio', mime: 'audio/ogg' }],
  ['.flac', { type: 'audio', mime: 'audio/flac' }]
]);

function existingTool(name) {
  const candidates = [];
  if (process.env.STUDIO_RESOURCES_PATH) candidates.push(path.join(process.env.STUDIO_RESOURCES_PATH, 'bin', `${name}.exe`));
  candidates.push(`C:\\ffmpeg\\bin\\${name}.exe`);
  for (const candidate of candidates) if (fs.existsSync(candidate)) return candidate;
  return `${name}.exe`;
}

function runProcess(command, args, { timeoutMs = 120000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`${path.basename(command)} 执行超时。`));
    }, timeoutMs);
    child.stdout.on('data', chunk => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', chunk => { stderr += chunk.toString('utf8'); });
    child.on('error', error => {
      clearTimeout(timer);
      reject(Object.assign(new Error(`未找到媒体处理组件 ${path.basename(command)}：${error.message}`), { code: 'MEDIA_TOOL_MISSING' }));
    });
    child.on('close', code => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(`${path.basename(command)} 失败：${stderr.trim().slice(-1200)}`));
      resolve({ stdout, stderr });
    });
  });
}

async function probeMedia(filePath) {
  const { stdout } = await runProcess(existingTool('ffprobe'), [
    '-v', 'error',
    '-show_entries', 'format=duration:stream=codec_type,width,height',
    '-of', 'json',
    filePath
  ], { timeoutMs: 30000 });
  const parsed = JSON.parse(stdout || '{}');
  const streams = Array.isArray(parsed.streams) ? parsed.streams : [];
  const video = streams.find(stream => stream.codec_type === 'video');
  return {
    duration: Math.max(0, Number(parsed.format?.duration || 0)),
    width: Number(video?.width || 0),
    height: Number(video?.height || 0)
  };
}

function uniqueAlias(base, excludeId = '') {
  const normalized = safeAlias(base, 'media');
  let alias = normalized;
  let counter = 2;
  while (db.prepare('SELECT id FROM reference_media WHERE active=1 AND lower(alias)=lower(?) AND id<>?').get(alias, excludeId || '')) {
    alias = `${normalized}_${counter++}`;
  }
  return alias;
}

function normalizedMediaType(value) {
  return ['video', 'audio'].includes(value) ? value : 'all';
}

function mediaSpecForPath(filePath, mediaType = 'all') {
  const spec = MEDIA_EXTENSIONS.get(path.extname(filePath).toLowerCase());
  if (!spec) return null;
  const type = normalizedMediaType(mediaType);
  if (type !== 'all' && spec.type !== type) return null;
  return spec;
}

function walkMediaFolder(folderPath, mediaType = 'all', out = []) {
  const entries = fs.readdirSync(folderPath, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'));
  for (const entry of entries) {
    const child = path.join(folderPath, entry.name);
    if (entry.isDirectory()) walkMediaFolder(child, mediaType, out);
    else if (entry.isFile() && mediaSpecForPath(child, mediaType)) out.push(child);
  }
  return out;
}

function expandImportSources(paths, { mediaType = 'all' } = {}) {
  const values = [];
  const rejected = [];
  const seen = new Set();
  for (const source of Array.isArray(paths) ? paths : []) {
    const sourcePath = path.resolve(String(source || ''));
    if (!sourcePath || seen.has(sourcePath.toLowerCase())) continue;
    seen.add(sourcePath.toLowerCase());
    if (!fs.existsSync(sourcePath)) {
      rejected.push({ path: sourcePath, error: '文件或文件夹不存在' });
      continue;
    }
    const stat = fs.statSync(sourcePath);
    if (stat.isDirectory()) {
      for (const filePath of walkMediaFolder(sourcePath, mediaType)) {
        const key = filePath.toLowerCase();
        if (!seen.has(key)) {
          seen.add(key);
          values.push(filePath);
        }
      }
      continue;
    }
    if (stat.isFile()) {
      if (mediaSpecForPath(sourcePath, mediaType)) values.push(sourcePath);
      else rejected.push({ path: sourcePath, error: '不支持的文件格式或与当前库类型不匹配' });
      continue;
    }
    rejected.push({ path: sourcePath, error: '不是有效文件或文件夹' });
  }
  return { values, rejected };
}

export function listReferenceMedia() {
  return db.prepare(`SELECT * FROM reference_media
    WHERE active=1 AND (media_type<>'video' OR duration_seconds<=20.001)
    ORDER BY updated_at DESC, file_name COLLATE NOCASE`).all();
}

export function referenceMediaById(id) {
  return db.prepare('SELECT * FROM reference_media WHERE id=? AND active=1').get(id) || null;
}

export function referenceMediaClipById(id) {
  return db.prepare(`SELECT c.*, m.media_type, m.file_name, m.alias, m.source_path
    FROM reference_media_clips c JOIN reference_media m ON m.id=c.media_id
    WHERE c.id=? AND m.active=1`).get(id) || null;
}

export async function importReferenceMedia(paths, { mediaType = 'all', maxVideoDurationSeconds = 0 } = {}) {
  const expanded = expandImportSources(paths, { mediaType });
  const values = expanded.values;
  if (!values.length) {
    const target = normalizedMediaType(mediaType) === 'video' ? '视频' : normalizedMediaType(mediaType) === 'audio' ? '音频' : '音视频';
    throw Object.assign(new Error(`没有找到可导入的${target}文件。`), { statusCode: 422, details: expanded.rejected });
  }
  const imported = [];
  const rejected = [...expanded.rejected];
  const skipped = [];
  for (const filePath of values) {
    try {
      if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) throw new Error('文件不存在');
      const spec = mediaSpecForPath(filePath, mediaType);
      if (!spec) throw new Error('不支持的文件格式或与当前库类型不匹配');
      const stat = fs.statSync(filePath);
      const probe = await probeMedia(filePath);
      if (!(probe.duration > 0)) throw new Error('无法读取媒体时长');
      if (spec.type === 'video' && Number(maxVideoDurationSeconds) > 0 && probe.duration > Number(maxVideoDurationSeconds) + 0.001) {
        skipped.push({ path: filePath, reason: `视频时长 ${probe.duration.toFixed(1)} 秒，超过 ${Number(maxVideoDurationSeconds)} 秒素材库上限` });
        continue;
      }
      const existing = db.prepare('SELECT * FROM reference_media WHERE lower(source_path)=lower(?)').get(filePath);
      const at = nowIso();
      const alias = uniqueAlias(existing?.alias || path.basename(filePath, path.extname(filePath)), existing?.id || '');
      const hash = sha256File(filePath);
      if (existing) {
        db.prepare(`UPDATE reference_media SET media_type=?,file_name=?,alias=?,mime_type=?,byte_size=?,duration_seconds=?,width=?,height=?,sha256=?,active=1,updated_at=? WHERE id=?`)
          .run(spec.type, path.basename(filePath), alias, spec.mime, stat.size, probe.duration, probe.width, probe.height, hash, at, existing.id);
        imported.push(db.prepare('SELECT * FROM reference_media WHERE id=?').get(existing.id));
      } else {
        const id = uid('media');
        db.prepare(`INSERT INTO reference_media(id,media_type,source_path,file_name,alias,mime_type,byte_size,duration_seconds,width,height,sha256,active,created_at,updated_at)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
          .run(id, spec.type, filePath, path.basename(filePath), alias, spec.mime, stat.size, probe.duration, probe.width, probe.height, hash, 1, at, at);
        imported.push(db.prepare('SELECT * FROM reference_media WHERE id=?').get(id));
      }
    } catch (error) {
      rejected.push({ path: filePath, error: error.message });
    }
  }
  if (!imported.length && !skipped.length) {
    throw Object.assign(new Error(`音视频导入失败：${rejected.map(item => `${path.basename(item.path)}：${item.error}`).join('；')}`), { statusCode: 422, details: rejected });
  }
  logEvent({ stage: 'reference_media_imported', entityType: 'reference_media', message: 'Reference media imported', payload: { imported: imported.length, rejected: rejected.length, skipped: skipped.length, mediaType: normalizedMediaType(mediaType), sourceCount: Array.isArray(paths) ? paths.length : 0 } });
  return { imported, rejected, skipped, media: listReferenceMedia() };
}

export function updateReferenceMediaAlias(id, alias) {
  const row = referenceMediaById(id);
  if (!row) throw Object.assign(new Error('音视频素材不存在。'), { statusCode: 404 });
  const normalized = uniqueAlias(alias || row.alias, id);
  db.prepare('UPDATE reference_media SET alias=?,updated_at=? WHERE id=?').run(normalized, nowIso(), id);
  return referenceMediaById(id);
}

export function removeReferenceMedia(id) {
  const refs = db.prepare(`SELECT COUNT(*) AS count FROM prompt_cards pc, json_each(pc.media_refs_json) j
    WHERE json_extract(j.value,'$.mediaId')=? AND pc.active=1`).get(id).count;
  if (Number(refs || 0) > 0) throw Object.assign(new Error(`该音视频素材被 ${refs} 张提示词卡引用。`), { statusCode: 409 });
  db.prepare('UPDATE reference_media SET active=0,updated_at=? WHERE id=?').run(nowIso(), id);
}

function clipOutputPath(media, startMs, durationMs) {
  const ext = media.media_type === 'video' ? '.mp4' : '.m4a';
  const key = `${media.sha256.slice(0, 16)}_${startMs}_${durationMs}`;
  return path.join(MEDIA_CLIP_DIR, `${key}${ext}`);
}

export async function createReferenceClip(mediaId, { startSeconds = 0, durationSeconds = 15 } = {}) {
  const media = referenceMediaById(mediaId);
  if (!media) throw Object.assign(new Error('音视频素材不存在。'), { statusCode: 404 });
  const sourceDuration = Number(media.duration_seconds || 0);
  const start = Number(startSeconds);
  const requested = Number(durationSeconds);
  if (!Number.isFinite(start) || start < 0 || start >= sourceDuration) {
    throw Object.assign(new Error('片段起点超出媒体时长。'), { statusCode: 422 });
  }
  if (!Number.isFinite(requested) || requested <= 0) {
    throw Object.assign(new Error('片段时长必须大于 0 秒。'), { statusCode: 422 });
  }
  if (media.media_type === 'video' && requested > 15.001) {
    throw Object.assign(new Error('视频参考片段最长 15 秒，不能自动截短。'), { statusCode: 422 });
  }
  if (media.media_type === 'audio' && requested > 15.001) {
    throw Object.assign(new Error('音频参考片段最长 15 秒，不能自动截短。'), { statusCode: 422 });
  }
  if (start + requested > sourceDuration + 0.001) {
    throw Object.assign(new Error('片段结束位置超出媒体时长。'), { statusCode: 422 });
  }
  const duration = requested;
  const startMs = Math.round(start * 1000);
  const durationMs = Math.round(duration * 1000);
  const existing = db.prepare('SELECT * FROM reference_media_clips WHERE media_id=? AND start_ms=? AND duration_ms=?').get(mediaId, startMs, durationMs);
  if (existing && fs.existsSync(existing.clip_path)) return existing;

  const outputPath = clipOutputPath(media, startMs, durationMs);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const ffmpeg = existingTool('ffmpeg');
  const common = ['-hide_banner', '-loglevel', 'error', '-y', '-ss', (startMs / 1000).toFixed(3), '-i', media.source_path, '-t', (durationMs / 1000).toFixed(3)];
  const args = media.media_type === 'video'
    ? [...common, '-map', '0:v:0', '-map', '0:a?', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-c:a', 'aac', '-movflags', '+faststart', outputPath]
    : [...common, '-vn', '-c:a', 'aac', '-b:a', '192k', outputPath];
  await runProcess(ffmpeg, args, { timeoutMs: 180000 });
  if (!fs.existsSync(outputPath) || fs.statSync(outputPath).size <= 0) throw new Error('裁剪文件生成失败。');
  const at = nowIso();
  const mime = media.media_type === 'video' ? 'video/mp4' : 'audio/mp4';
  const clip = {
    id: existing?.id || uid('clip'),
    media_id: mediaId,
    start_ms: startMs,
    duration_ms: durationMs,
    clip_path: outputPath,
    mime_type: mime,
    byte_size: fs.statSync(outputPath).size,
    sha256: sha256File(outputPath),
    created_at: existing?.created_at || at,
    updated_at: at
  };
  db.prepare(`INSERT INTO reference_media_clips(id,media_id,start_ms,duration_ms,clip_path,mime_type,byte_size,sha256,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(media_id,start_ms,duration_ms) DO UPDATE SET clip_path=excluded.clip_path,mime_type=excluded.mime_type,byte_size=excluded.byte_size,sha256=excluded.sha256,updated_at=excluded.updated_at`)
    .run(clip.id, clip.media_id, clip.start_ms, clip.duration_ms, clip.clip_path, clip.mime_type, clip.byte_size, clip.sha256, clip.created_at, clip.updated_at);
  logEvent({ stage: 'reference_media_clipped', entityType: 'reference_media', entityId: mediaId, message: 'Reference media segment materialized', payload: { startMs, durationMs, clipId: clip.id } });
  return db.prepare('SELECT * FROM reference_media_clips WHERE media_id=? AND start_ms=? AND duration_ms=?').get(mediaId, startMs, durationMs);
}

export function mediaFileForRequest(mediaId, clipId = '') {
  if (clipId) {
    const clip = referenceMediaClipById(clipId);
    if (!clip || clip.media_id !== mediaId || !fs.existsSync(clip.clip_path)) return null;
    return { path: clip.clip_path, mime: clip.mime_type, size: fs.statSync(clip.clip_path).size };
  }
  const media = referenceMediaById(mediaId);
  if (!media || !fs.existsSync(media.source_path)) return null;
  return { path: media.source_path, mime: media.mime_type, size: fs.statSync(media.source_path).size };
}
