import { EventEmitter } from 'node:events';
import { db, getSetting, listCards as listDbCards, listTasks, logEvent, normalizeCardPositions } from './db.js';
import { listCookies } from './cookieService.js';
import { nowIso, safeFilename, sleep, uid, jsonParse } from './utils.js';
import { providerStatus, resolveRemoteImage, resolveRemoteReferenceMedia, submitGeneration } from './provider/creativeStudioI2V.js';

export const taskEvents = new EventEmitter();
let workerPromise = null;

const MB = 1024 * 1024;
const SUBMISSION_LIMITS = Object.freeze({
  maxImageBytes: 30 * MB,
  maxVideoBytesTotal: 50 * MB,
  maxAudioBytesEach: 15 * MB,
  maxReferenceSeconds: 15
});

function mb(value) {
  return (Number(value || 0) / MB).toFixed(1);
}

function emit(type, payload = {}) {
  taskEvents.emit('event', { type, at: nowIso(), ...payload });
}

function parsedCard(row) {
  return {
    ...row,
    asset_ids: jsonParse(row.asset_ids_json, []),
    manual_asset_ids: jsonParse(row.manual_asset_ids_json, []),
    auto_asset_ids: jsonParse(row.auto_asset_ids_json, []),
    media_refs: jsonParse(row.media_refs_json, []),
    manual_media_refs: jsonParse(row.manual_media_refs_json, []),
    auto_media_refs: jsonParse(row.auto_media_refs_json, [])
  };
}

function synchronizeCardReferences(card) {
  const manualAssetIds = uniqueIds(card.manual_asset_ids || []);
  const autoAssetIds = detectPromptAssets(card.prompt_raw);
  const combinedAssetIds = uniqueIds([...manualAssetIds, ...autoAssetIds]);
  const manualMediaRefs = normalizeMediaRefs(card.manual_media_refs || card.media_refs || []);
  const autoMediaRefs = detectPromptMedia(card.prompt_raw);
  const combinedMediaRefs = mergeMediaRefs(manualMediaRefs, autoMediaRefs);
  if (JSON.stringify(card.asset_ids) !== JSON.stringify(combinedAssetIds)
    || JSON.stringify(card.auto_asset_ids) !== JSON.stringify(autoAssetIds)
    || JSON.stringify(normalizeMediaRefs(card.media_refs || [])) !== JSON.stringify(combinedMediaRefs)
    || JSON.stringify(normalizeMediaRefs(card.auto_media_refs || [])) !== JSON.stringify(autoMediaRefs)) {
    db.prepare('UPDATE prompt_cards SET asset_ids_json=?,auto_asset_ids_json=?,media_refs_json=?,auto_media_refs_json=?,updated_at=? WHERE id=?')
      .run(JSON.stringify(combinedAssetIds), JSON.stringify(autoAssetIds), JSON.stringify(combinedMediaRefs), JSON.stringify(autoMediaRefs), nowIso(), card.id);
  }
  return {
    ...card,
    asset_ids: combinedAssetIds,
    manual_asset_ids: manualAssetIds,
    auto_asset_ids: autoAssetIds,
    media_refs: combinedMediaRefs,
    manual_media_refs: manualMediaRefs,
    auto_media_refs: autoMediaRefs
  };
}

function cardRow(id) {
  const row = db.prepare('SELECT * FROM prompt_cards WHERE id=?').get(id);
  if (!row) throw Object.assign(new Error('提示词卡不存在。'), { statusCode: 404 });
  return synchronizeCardReferences(parsedCard(row));
}

export function listCards() {
  return listDbCards().map(synchronizeCardReferences);
}

function assetRows(assetIds) {
  if (!assetIds.length) return [];
  const placeholders = assetIds.map(() => '?').join(',');
  const rows = db.prepare(`SELECT * FROM assets WHERE active=1 AND id IN (${placeholders})`).all(...assetIds);
  const map = new Map(rows.map(row => [row.id, row]));
  return assetIds.map(id => map.get(id)).filter(Boolean);
}

function normalizeMediaRefs(values) {
  const out = [];
  const seen = new Set();
  for (const value of Array.isArray(values) ? values : []) {
    const mediaId = String(value?.mediaId || '').trim();
    if (!mediaId || seen.has(mediaId)) continue;
    seen.add(mediaId);
    out.push({
      mediaId,
      clipId: String(value?.clipId || '').trim(),
      startSeconds: Math.max(0, Number(value?.startSeconds || 0)),
      durationSeconds: Math.max(0, Number(value?.durationSeconds || 0))
    });
  }
  return out;
}

function mergeMediaRefs(...groups) {
  const map = new Map();
  for (const group of groups) {
    for (const ref of normalizeMediaRefs(group)) {
      if (!map.has(ref.mediaId)) map.set(ref.mediaId, ref);
    }
  }
  return [...map.values()];
}

function mediaRefRows(mediaRefs) {
  const normalized = normalizeMediaRefs(mediaRefs);
  return normalized.map(ref => {
    const media = db.prepare('SELECT * FROM reference_media WHERE id=? AND active=1').get(ref.mediaId);
    if (!media) return { ref, media: null, clip: null };
    const clip = ref.clipId ? db.prepare('SELECT * FROM reference_media_clips WHERE id=? AND media_id=?').get(ref.clipId, ref.mediaId) : null;
    return { ref, media, clip };
  });
}

function uniqueIds(values) {
  return [...new Set((values || []).map(String).filter(Boolean))];
}

export function detectPromptDuration(prompt) {
  const value = String(prompt || '');
  const patterns = [
    /生成一段(?:独立的)?\s*(\d{1,2})\s*秒/i,
    /(?:目标|视频时长|时长)\s*(?:为|[:：])?\s*(\d{1,2})\s*秒/i
  ];
  for (const pattern of patterns) {
    const match = value.match(pattern);
    const duration = Number(match?.[1] || 0);
    if (Number.isInteger(duration) && duration >= 4 && duration <= 15) return duration;
  }
  return null;
}

function splitPlainBulkPrompts(value) {
  const text = String(value || '').replace(/\r\n/g, '\n').trim();
  if (!text) return [];
  const starts = [];
  const pattern = /^\s*(?=生成一段(?:独立的)?\s*\d{1,2}\s*秒)/gmi;
  let match;
  while ((match = pattern.exec(text))) {
    starts.push(match.index);
    pattern.lastIndex = Math.max(pattern.lastIndex, match.index + 1);
  }
  if (!starts.length) return [text];
  const prompts = [];
  for (let index = 0; index < starts.length; index += 1) {
    const start = starts[index];
    const end = index + 1 < starts.length ? starts[index + 1] : text.length;
    const prompt = text.slice(start, end).trim();
    if (prompt) prompts.push(prompt);
  }
  return prompts;
}

export function splitBulkPromptText(input) {
  const raw = String(input || '').replace(/\r\n/g, '\n').trim();
  if (!raw) return [];
  const fenced = [...raw.matchAll(/```(?:text|txt)?\s*\n([\s\S]*?)```/gi)]
    .flatMap(match => splitPlainBulkPrompts(match[1]))
    .map(prompt => prompt.trim())
    .filter(Boolean);
  const prompts = fenced.length ? fenced : splitPlainBulkPrompts(raw);
  return prompts.filter(prompt => detectPromptDuration(prompt) != null || /^\s*生成一段/i.test(prompt));
}

function detectPromptAssets(prompt) {
  const value = String(prompt || '').replace(/\\@/g, '__ESCAPED_AT__');
  const assets = db.prepare('SELECT id,alias FROM assets WHERE active=1 ORDER BY LENGTH(alias) DESC, alias COLLATE NOCASE').all();
  const matches = [];
  let cursor = 0;
  while (cursor < value.length) {
    const position = value.indexOf('@', cursor);
    if (position < 0) break;
    const matched = assets.find(asset => value.startsWith(`@${asset.alias}`, position));
    if (matched) {
      matches.push(matched.id);
      cursor = position + matched.alias.length + 1;
    } else {
      cursor = position + 1;
    }
  }
  return uniqueIds(matches);
}

function detectPromptMedia(prompt) {
  const value = String(prompt || '').replace(/\\@/g, '__ESCAPED_AT__');
  const media = db.prepare(`SELECT id,alias,file_name,media_type FROM reference_media
    WHERE active=1 AND (media_type<>'video' OR duration_seconds<=20.001)
    ORDER BY MAX(LENGTH(alias),LENGTH(file_name)) DESC, alias COLLATE NOCASE`).all();
  const candidates = [];
  for (const item of media) {
    for (const token of uniqueIds([item.file_name, item.alias]).sort((a, b) => b.length - a.length)) {
      candidates.push({ item, token });
    }
  }
  candidates.sort((a, b) => b.token.length - a.token.length);
  const matches = [];
  const seen = new Set();
  let cursor = 0;
  while (cursor < value.length) {
    const position = value.indexOf('@', cursor);
    if (position < 0) break;
    const matched = candidates.find(candidate => value.startsWith(`@${candidate.token}`, position));
    if (matched) {
      if (!seen.has(matched.item.id)) {
        seen.add(matched.item.id);
        matches.push({ mediaId: matched.item.id, clipId: '', startSeconds: 0, durationSeconds: 0 });
      }
      cursor = position + matched.token.length + 1;
    } else {
      cursor = position + 1;
    }
  }
  return matches;
}

function validateCard(card) {
  const errors = [];
  const mediaRefs = normalizeMediaRefs(card.media_refs || []);
  const imageIds = Array.isArray(card.asset_ids) ? card.asset_ids : [];
  if (imageIds.length < 1) errors.push('至少需要 1 张参考图片，纯视频/纯音频任务不允许提交。');
  if (imageIds.length > 9) errors.push('参考图片最多 9 张。');
  if (!String(card.prompt_raw || '').trim()) errors.push('提示词不能为空。');
  const duration = Number(card.duration_seconds);
  if (!Number.isInteger(duration) || duration < 4 || duration > 15) errors.push('输出时长必须是 4–15 秒整数。');
  const retryLimit = Number(card.retry_limit);
  if (!Number.isInteger(retryLimit) || retryLimit < 0 || retryLimit > 5) errors.push('失败重提次数必须是 0–5 整数。');
  const generationCount = Number(card.generation_count);
  if (!Number.isInteger(generationCount) || generationCount < 1 || generationCount > 99) errors.push('生成条数必须是 1–99 整数。');
  if (/[\\/:*?"<>|]/.test(String(card.output_filename || ''))) errors.push('视频文件名包含非法字符。');

  const assets = assetRows(imageIds);
  if (assets.length !== imageIds.length) errors.push('部分参考图片已不存在或未激活。');
  for (const asset of assets) {
    if (Number(asset.byte_size || 0) > SUBMISSION_LIMITS.maxImageBytes) {
      errors.push(`${asset.file_name || asset.alias || asset.id} 图片大小为 ${mb(asset.byte_size)}MB，超过 30MB 上限。`);
    }
  }
  const mediaRows = mediaRefRows(mediaRefs);
  if (mediaRows.some(item => !item.media)) errors.push('部分音视频参考已不存在或未激活。');

  const videoRows = mediaRows.filter(item => item.media?.media_type === 'video');
  const audioRows = mediaRows.filter(item => item.media?.media_type === 'audio');
  if (videoRows.length > 3) errors.push('参考视频最多 3 个。');
  if (audioRows.length > 3) errors.push('参考音频最多 3 个。');
  if (imageIds.length + videoRows.length + audioRows.length > 12) errors.push('图片 + 视频 + 音频总文件数最多 12 个。');

  let totalVideoSeconds = 0;
  let totalVideoBytes = 0;
  const videoDurationLimit = Math.min(SUBMISSION_LIMITS.maxReferenceSeconds, duration);
  for (const item of videoRows) {
    if (item.ref.clipId && !item.clip) {
      errors.push(`${item.media.file_name} 的裁剪片段已失效。`);
      continue;
    }
    const sourceDuration = Number(item.media.duration_seconds || 0);
    const effectiveDuration = item.clip ? Number(item.clip.duration_ms || 0) / 1000 : sourceDuration;
    const effectiveBytes = item.clip ? Number(item.clip.byte_size || 0) : Number(item.media.byte_size || 0);
    if (sourceDuration > videoDurationLimit + 0.001 && !item.clip) errors.push(`${item.media.file_name} 原视频 ${sourceDuration.toFixed(1)} 秒，超过当前输出时长 ${videoDurationLimit} 秒，必须先完成片段审核。`);
    if (!(effectiveDuration > 0) || effectiveDuration > videoDurationLimit + 0.001) errors.push(`${item.media.file_name} 的参考片段必须大于 0 秒且不超过当前输出时长 ${videoDurationLimit} 秒。`);
    totalVideoSeconds += Math.max(0, effectiveDuration);
    totalVideoBytes += Math.max(0, effectiveBytes);
  }
  if (totalVideoSeconds > videoDurationLimit + 0.001) errors.push(`参考视频总时长为 ${totalVideoSeconds.toFixed(1)} 秒，超过当前输出时长 ${videoDurationLimit} 秒。`);
  if (totalVideoBytes > SUBMISSION_LIMITS.maxVideoBytesTotal) errors.push(`参考视频总大小为 ${mb(totalVideoBytes)}MB，超过 50MB 上限，请先压缩或裁剪。`);

  let totalAudioSeconds = 0;
  const audioDurationLimit = Math.min(SUBMISSION_LIMITS.maxReferenceSeconds, duration);
  for (const item of audioRows) {
    if (item.ref.clipId && !item.clip) {
      errors.push(`${item.media.file_name} 的音频裁剪片段已失效。`);
      continue;
    }
    const sourceDuration = Number(item.media.duration_seconds || 0);
    const effectiveDuration = item.clip ? Number(item.clip.duration_ms || 0) / 1000 : sourceDuration;
    const effectiveBytes = item.clip ? Number(item.clip.byte_size || 0) : Number(item.media.byte_size || 0);
    if (effectiveBytes > SUBMISSION_LIMITS.maxAudioBytesEach) errors.push(`${item.media.file_name} 音频大小为 ${mb(effectiveBytes)}MB，超过 15MB 上限。`);
    if (sourceDuration > audioDurationLimit + 0.001 && !item.clip) {
      errors.push(`${item.media.file_name} 音频 ${sourceDuration.toFixed(1)} 秒，超过当前输出时长 ${audioDurationLimit} 秒；请先裁剪音频，禁止提交时静默截断。`);
    }
    if (!(effectiveDuration > 0) || effectiveDuration > audioDurationLimit + 0.001) {
      errors.push(`${item.media.file_name} 的音频参考片段必须大于 0 秒且不超过当前输出时长 ${audioDurationLimit} 秒。`);
    }
    totalAudioSeconds += Math.max(0, effectiveDuration);
  }
  if (totalAudioSeconds > audioDurationLimit + 0.001) errors.push(`参考音频总时长为 ${totalAudioSeconds.toFixed(1)} 秒，超过当前输出时长 ${audioDurationLimit} 秒。`);

  const capabilities = providerStatus().capabilities || {};
  if (videoRows.length && !capabilities.videoReference) errors.push('当前 Provider 尚未启用视频参考远端提交。');
  if (audioRows.length && !capabilities.audioReference) errors.push('当前 Provider 尚未启用音频参考远端提交。');

  return {
    errors,
    assets,
    mediaRows,
    review: {
      imageCount: imageIds.length,
      videoCount: videoRows.length,
      audioCount: audioRows.length,
      totalFiles: imageIds.length + videoRows.length + audioRows.length,
      totalVideoSeconds: Number(totalVideoSeconds.toFixed(3)),
      totalAudioSeconds: Number(totalAudioSeconds.toFixed(3))
    }
  };
}

function compilePrompt(prompt, assets, mediaRows = []) {
  let value = String(prompt || '').replace(/\\@/g, '__ESCAPED_AT__');
  const mappings = [
    ...assets.map((asset, index) => ({ token: asset.alias, index })),
    ...mediaRows.filter(item => item.media).flatMap((item, mediaIndex) => uniqueIds([item.media.file_name, item.media.alias])
      .map(token => ({ token, index: assets.length + mediaIndex })))
  ].sort((a, b) => b.token.length - a.token.length);
  mappings.forEach(mapping => { value = value.replaceAll(`@${mapping.token}`, `<|media:${mapping.index}|>`); });
  return value.replaceAll('__ESCAPED_AT__', '@');
}

function insertCard({ assetIds = [], mediaRefs = [], prompt = '', duration = 15, filename = '', retryLimit = 0, generationCount = 1 } = {}) {
  const nextPosition = Number(db.prepare('SELECT COALESCE(MAX(position),0)+1 AS next FROM prompt_cards WHERE active=1').get().next);
  const id = uid('card');
  const at = nowIso();
  const manualAssetIds = uniqueIds(assetIds);
  const autoAssetIds = detectPromptAssets(prompt);
  const combinedAssetIds = uniqueIds([...manualAssetIds, ...autoAssetIds]);
  const manualMediaRefs = normalizeMediaRefs(mediaRefs);
  const autoMediaRefs = detectPromptMedia(prompt);
  const combinedMediaRefs = mergeMediaRefs(manualMediaRefs, autoMediaRefs);
  db.prepare(`INSERT INTO prompt_cards(id,position,title,asset_ids_json,manual_asset_ids_json,auto_asset_ids_json,media_refs_json,manual_media_refs_json,auto_media_refs_json,prompt_raw,duration_seconds,output_filename,retry_limit,generation_count,active,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      id,
      nextPosition,
      `提示词卡 ${nextPosition}`,
      JSON.stringify(combinedAssetIds),
      JSON.stringify(manualAssetIds),
      JSON.stringify(autoAssetIds),
      JSON.stringify(combinedMediaRefs),
      JSON.stringify(manualMediaRefs),
      JSON.stringify(autoMediaRefs),
      String(prompt || ''),
      Number(duration || 15),
      String(filename || ''),
      Number(retryLimit || 0),
      Number(generationCount || 1),
      1,
      at,
      at
    );
  return cardRow(id);
}

export function createCard(sourceId = null) {
  const source = sourceId ? cardRow(sourceId) : null;
  return insertCard({
    assetIds: source?.asset_ids || [],
    mediaRefs: source?.manual_media_refs || source?.media_refs || [],
    prompt: source?.prompt_raw || '',
    duration: Number(source?.duration_seconds || 15),
    filename: source?.output_filename ? `${source.output_filename}_copy` : '',
    retryLimit: Number(source?.retry_limit || 0),
    generationCount: Number(source?.generation_count || 1)
  });
}

export function createCardsBulk({ text, generationCount = 1 } = {}) {
  const count = Number(generationCount);
  if (!Number.isInteger(count) || count < 1 || count > 99) {
    throw Object.assign(new Error('每条提示词生成数量必须是 1–99 整数。'), { statusCode: 422 });
  }
  const prompts = splitBulkPromptText(text);
  if (!prompts.length) {
    throw Object.assign(new Error('没有识别到可拆分的提示词。请确保每条提示词以“生成一段……X秒”开头，或放在独立 ```text 代码块中。'), { statusCode: 422 });
  }
  if (prompts.length > 200) {
    throw Object.assign(new Error(`一次最多导入 200 条提示词，当前识别到 ${prompts.length} 条。`), { statusCode: 422 });
  }

  const activeCards = listCards();
  if (activeCards.length === 1) {
    const only = activeCards[0];
    const isBlank = !String(only.prompt_raw || '').trim()
      && !(only.asset_ids || []).length
      && !(only.media_refs || []).length
      && !String(only.output_filename || '').trim();
    if (isBlank) {
      const at = nowIso();
      db.prepare('UPDATE prompt_cards SET active=0,archived_at=?,updated_at=? WHERE id=?').run(at, at, only.id);
    }
  }

  const cards = prompts.map(prompt => {
    const duration = detectPromptDuration(prompt) || 15;
    return insertCard({ prompt, duration, generationCount: count });
  });
  normalizeCardPositions();
  const detectedDurations = cards.map(card => Number(card.duration_seconds || 15));
  logEvent({
    stage: 'prompt_cards_bulk_created',
    entityType: 'prompt_card',
    message: 'Bulk prompt cards created',
    payload: { count: cards.length, generationCount: count, durations: detectedDurations }
  });
  emit('cards_bulk_created', { count: cards.length });
  return { cards: listCards(), createdCount: cards.length, generationCount: count, durations: detectedDurations };
}

export function applyGenerationCountToActiveCards(generationCount) {
  const count = Number(generationCount);
  if (!Number.isInteger(count) || count < 1 || count > 99) {
    throw Object.assign(new Error('每条提示词生成数量必须是 1–99 整数。'), { statusCode: 422 });
  }
  const at = nowIso();
  const result = db.prepare('UPDATE prompt_cards SET generation_count=?,updated_at=? WHERE active=1').run(count, at);
  emit('cards_generation_count_updated', { generationCount: count, updated: Number(result.changes || 0) });
  return { generationCount: count, updated: Number(result.changes || 0), cards: listCards() };
}

export function applyFilenamesToActiveCards({ prefix, startNumber = 1, padding = 3 } = {}) {
  const rawPrefix = String(prefix || '').trim().replace(/\.mp4$/i, '');
  if (!rawPrefix) throw Object.assign(new Error('批量命名前缀不能为空。'), { statusCode: 422 });
  if (/[\\/:*?"<>|]/.test(rawPrefix)) {
    throw Object.assign(new Error('批量命名前缀包含 Windows 文件名非法字符。'), { statusCode: 422 });
  }
  const start = Number(startNumber);
  const digits = Number(padding);
  if (!Number.isInteger(start) || start < 0 || start > 999999) {
    throw Object.assign(new Error('起始序号必须是 0–999999 的整数。'), { statusCode: 422 });
  }
  if (!Number.isInteger(digits) || digits < 1 || digits > 6) {
    throw Object.assign(new Error('序号位数必须是 1–6 的整数。'), { statusCode: 422 });
  }
  const cards = db.prepare('SELECT id,position FROM prompt_cards WHERE active=1 ORDER BY position,id').all();
  if (!cards.length) throw Object.assign(new Error('当前没有可批量命名的提示词卡。'), { statusCode: 422 });
  const normalizedPrefix = rawPrefix.replace(/\s+/g, '_');
  const separator = /[_-]$/.test(normalizedPrefix) ? '' : '_';
  const at = nowIso();
  const stmt = db.prepare('UPDATE prompt_cards SET output_filename=?,updated_at=? WHERE id=?');
  db.exec('BEGIN IMMEDIATE');
  try {
    cards.forEach((card, index) => {
      const number = String(start + index).padStart(digits, '0');
      const filename = safeFilename(`${normalizedPrefix}${separator}${number}`);
      stmt.run(filename, at, card.id);
    });
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  emit('cards_filenames_updated', { updated: cards.length, prefix: normalizedPrefix, startNumber: start, padding: digits });
  return { updated: cards.length, prefix: normalizedPrefix, startNumber: start, padding: digits, cards: listCards() };
}

export function listFailedPromptRecords({ startIso, endIso } = {}) {
  const startMs = Date.parse(String(startIso || ''));
  const endMs = Date.parse(String(endIso || ''));
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || startMs >= endMs) {
    throw Object.assign(new Error('失败提示词导出的日期范围无效。'), { statusCode: 422 });
  }
  const rows = db.prepare(`SELECT id,status,output_filename,prompt_raw,duration_seconds,error_code,error_message,
      asset_ids_json,media_refs_json,remote_task_id,failed_at,updated_at,created_at
    FROM generation_tasks
    WHERE status IN ('submit_failed','remote_failed','download_failed')
      AND COALESCE(failed_at,updated_at,created_at) >= ?
      AND COALESCE(failed_at,updated_at,created_at) < ?
    ORDER BY COALESCE(failed_at,updated_at,created_at), id`).all(new Date(startMs).toISOString(), new Date(endMs).toISOString());
  const assetLookup = db.prepare('SELECT alias,file_name FROM assets WHERE id=?');
  const mediaLookup = db.prepare('SELECT media_type,alias,file_name FROM reference_media WHERE id=?');
  const records = rows.map(row => {
    const assetIds = jsonParse(row.asset_ids_json, []);
    const mediaRefs = normalizeMediaRefs(jsonParse(row.media_refs_json, []));
    return {
      id: row.id,
      status: row.status,
      filename: row.output_filename || '',
      prompt: row.prompt_raw || '',
      duration: Number(row.duration_seconds || 0),
      errorCode: row.error_code || '',
      errorMessage: row.error_message || '',
      remoteTaskId: row.remote_task_id || '',
      failureTime: row.failed_at || row.updated_at || row.created_at,
      images: assetIds.map(id => {
        const item = assetLookup.get(id);
        return { id, name: item?.alias || item?.file_name || id };
      }),
      media: mediaRefs.map(ref => {
        const item = mediaLookup.get(ref.mediaId);
        return {
          id: ref.mediaId,
          type: item?.media_type || 'unknown',
          name: item?.file_name || item?.alias || ref.mediaId,
          clipId: ref.clipId || '',
          startSeconds: Number(ref.startSeconds || 0),
          durationSeconds: Number(ref.durationSeconds || 0)
        };
      })
    };
  });
  return { records, count: records.length };
}

export function listCompletedPromptRecords({ startIso, endIso } = {}) {
  const startMs = Date.parse(String(startIso || ''));
  const endMs = Date.parse(String(endIso || ''));
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || startMs >= endMs) {
    throw Object.assign(new Error('提示词导出的日期范围无效。'), { statusCode: 422 });
  }
  const records = db.prepare(`SELECT output_filename,prompt_raw,created_at
    FROM generation_tasks
    WHERE status='completed'
      AND created_at >= ?
      AND created_at < ?
      AND TRIM(output_filename)<>''
      AND TRIM(prompt_raw)<>''
    ORDER BY created_at,id`).all(new Date(startMs).toISOString(), new Date(endMs).toISOString())
    .map(row => ({
      filename: `${String(row.output_filename || '').replace(/\.mp4$/i, '')}.mp4`,
      prompt: row.prompt_raw || ''
    }));
  return { records, count: records.length };
}

export function listPromptHistory(limit = 300) {
  const safeLimit = Math.max(1, Math.min(1000, Number(limit) || 300));
  const rows = db.prepare(`SELECT t.id,t.status,t.asset_ids_json,t.media_refs_json,t.prompt_raw,t.duration_seconds,t.output_filename,t.retry_limit,
      t.remote_task_id,t.error_message,t.created_at,t.submitted_at,t.completed_at,
      COALESCE(c.generation_count,1) AS generation_count
    FROM generation_tasks t
    LEFT JOIN prompt_cards c ON c.id=t.prompt_card_id
    WHERE TRIM(t.prompt_raw)<>''
    ORDER BY t.created_at DESC
    LIMIT ?`).all(safeLimit * 3);
  const activeAssetIds = new Set(db.prepare('SELECT id FROM assets WHERE active=1').all().map(row => row.id));
  const seen = new Set();
  const history = [];
  for (const row of rows) {
    const sourceAssetIds = jsonParse(row.asset_ids_json, []);
    const sourceMediaRefs = normalizeMediaRefs(jsonParse(row.media_refs_json, []));
    const key = `${String(row.prompt_raw).trim()}\u0000${Number(row.duration_seconds)}\u0000${JSON.stringify(sourceAssetIds)}\u0000${JSON.stringify(sourceMediaRefs)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const reusableAssetIds = sourceAssetIds.filter(id => activeAssetIds.has(id));
    history.push({
      id: row.id,
      status: row.status,
      prompt: row.prompt_raw,
      duration: Number(row.duration_seconds || 15),
      filename: row.output_filename || '',
      retryLimit: Number(row.retry_limit || 0),
      generationCount: Number(row.generation_count || 1),
      remoteTaskId: row.remote_task_id || '',
      errorMessage: row.error_message || '',
      createdAt: row.created_at,
      submittedAt: row.submitted_at || '',
      completedAt: row.completed_at || '',
      sourceAssetCount: sourceAssetIds.length,
      reusableAssetCount: reusableAssetIds.length,
      missingAssetCount: sourceAssetIds.length - reusableAssetIds.length,
      sourceMediaCount: sourceMediaRefs.length,
      reusableMediaCount: sourceMediaRefs.filter(ref => Boolean(db.prepare('SELECT 1 FROM reference_media WHERE id=? AND active=1').get(ref.mediaId))).length
    });
    if (history.length >= safeLimit) break;
  }
  return history;
}

export function reusePromptHistory(taskId) {
  const task = db.prepare(`SELECT t.id,t.asset_ids_json,t.media_refs_json,t.prompt_raw,t.duration_seconds,t.retry_limit,
      COALESCE(c.generation_count,1) AS generation_count
    FROM generation_tasks t
    LEFT JOIN prompt_cards c ON c.id=t.prompt_card_id
    WHERE t.id=?`).get(taskId);
  if (!task) throw Object.assign(new Error('历史提示词不存在。'), { statusCode: 404 });
  const sourceAssetIds = jsonParse(task.asset_ids_json, []);
  const reusableAssetIds = assetRows(sourceAssetIds).map(asset => asset.id);
  const reusableMediaRefs = normalizeMediaRefs(jsonParse(task.media_refs_json, [])).filter(ref => Boolean(db.prepare('SELECT 1 FROM reference_media WHERE id=? AND active=1').get(ref.mediaId)));
  const card = insertCard({
    assetIds: reusableAssetIds,
    mediaRefs: reusableMediaRefs,
    prompt: task.prompt_raw,
    duration: Number(task.duration_seconds || 15),
    filename: '',
    retryLimit: Number(task.retry_limit || 0),
    generationCount: Number(task.generation_count || 1)
  });
  const sourceMediaRefs = normalizeMediaRefs(jsonParse(task.media_refs_json, []));
  const missingAssetCount = sourceAssetIds.length - reusableAssetIds.length;
  const missingMediaCount = sourceMediaRefs.length - reusableMediaRefs.length;
  logEvent({
    stage: 'prompt_history_reused',
    entityType: 'task',
    entityId: task.id,
    message: 'Prompt history reused as a new card',
    payload: { cardId: card.id, reusableAssetCount: reusableAssetIds.length, missingAssetCount, reusableMediaCount: reusableMediaRefs.length, missingMediaCount }
  });
  emit('prompt_history_reused', { sourceTaskId: task.id, cardId: card.id });
  return { card, reusableAssetCount: reusableAssetIds.length, missingAssetCount, reusableMediaCount: reusableMediaRefs.length, missingMediaCount };
}

export function updateCard(id, patch) {
  const existing = cardRow(id);
  const manualAssetIds = Array.isArray(patch.manualAssetIds)
    ? uniqueIds(patch.manualAssetIds)
    : Array.isArray(patch.assetIds)
      ? uniqueIds(patch.assetIds)
      : existing.manual_asset_ids;
  const prompt = patch.prompt != null ? String(patch.prompt) : existing.prompt_raw;
  const autoAssetIds = detectPromptAssets(prompt);
  const combinedAssetIds = uniqueIds([...manualAssetIds, ...autoAssetIds]);
  const duration = patch.duration != null ? Number(patch.duration) : existing.duration_seconds;
  const filename = patch.filename != null ? String(patch.filename).replace(/\.mp4$/i, '') : existing.output_filename;
  const retryLimit = patch.retryLimit != null ? Number(patch.retryLimit) : existing.retry_limit;
  const generationCount = patch.generationCount != null ? Number(patch.generationCount) : existing.generation_count;
  const manualMediaRefs = patch.manualMediaRefs != null
    ? normalizeMediaRefs(patch.manualMediaRefs)
    : patch.mediaRefs != null
      ? normalizeMediaRefs(patch.mediaRefs)
      : normalizeMediaRefs(existing.manual_media_refs || existing.media_refs || []);
  const autoMediaRefs = detectPromptMedia(prompt);
  const mediaRefs = mergeMediaRefs(manualMediaRefs, autoMediaRefs);
  db.prepare(`UPDATE prompt_cards SET asset_ids_json=?,manual_asset_ids_json=?,auto_asset_ids_json=?,media_refs_json=?,manual_media_refs_json=?,auto_media_refs_json=?,prompt_raw=?,duration_seconds=?,output_filename=?,retry_limit=?,generation_count=?,updated_at=? WHERE id=?`)
    .run(JSON.stringify(combinedAssetIds), JSON.stringify(manualAssetIds), JSON.stringify(autoAssetIds), JSON.stringify(mediaRefs), JSON.stringify(manualMediaRefs), JSON.stringify(autoMediaRefs), prompt, duration, filename, retryLimit, generationCount, nowIso(), id);
  return cardRow(id);
}

export function deleteCard(id) {
  const existing = cardRow(id);
  const taskCount = Number(db.prepare('SELECT COUNT(*) AS count FROM generation_tasks WHERE prompt_card_id=?').get(id).count || 0);
  const archivedAt = nowIso();
  db.prepare('UPDATE prompt_cards SET active=0,archived_at=?,updated_at=? WHERE id=?')
    .run(archivedAt, archivedAt, id);
  normalizeCardPositions();
  if (!db.prepare('SELECT COUNT(*) AS count FROM prompt_cards WHERE active=1').get().count) createCard();
  logEvent({
    stage: 'prompt_card_archived',
    entityType: 'prompt_card',
    entityId: id,
    message: 'Prompt card removed from input workspace',
    payload: { taskCount, title: existing.title }
  });
  emit('card_deleted', { cardId: id, archived: true, taskCount });
  return { archived: true, taskCount };
}

export function cardValidationSummary() {
  return listCards().map(card => {
    const { errors, review } = validateCard(card);
    return { id: card.id, valid: errors.length === 0, errors, review };
  });
}

export function createSubmissionBatch({ cookieProfileId, cardIds = null, startWorker = true }) {
  const cookie = listCookies().find(item => item.id === cookieProfileId);
  if (!cookie) throw Object.assign(new Error('请选择 Cookie。'), { statusCode: 422 });
  if (cookie.status !== 'valid') throw Object.assign(new Error('Cookie 尚未验证通过。'), { statusCode: 422 });
  const outputDirectory = getSetting('outputDirectory', '');
  if (!outputDirectory) throw Object.assign(new Error('请先选择视频保存目录。'), { statusCode: 422 });

  const candidates = listCards().filter(card => !cardIds || cardIds.includes(card.id));
  if (!candidates.length) throw Object.assign(new Error('没有可提交的提示词卡。'), { statusCode: 422 });
  const evaluated = candidates.map(card => ({ card, result: validateCard(card) }));
  const validItems = evaluated.filter(item => item.result.errors.length === 0);
  const invalidItems = evaluated.filter(item => item.result.errors.length > 0);
  const overVideoLimit = invalidItems.filter(item => Number(item.result.review?.videoCount || 0) > 3);
  if (overVideoLimit.length) {
    throw Object.assign(new Error('存在参考视频超过 3 个的提示词卡。Seedance 2.0 单个任务最多参考 3 个视频，请先移除多余视频后再提交。'), {
      statusCode: 422,
      code: 'REFERENCE_VIDEO_LIMIT_EXCEEDED',
      details: overVideoLimit.map(item => ({ id: item.card.id, title: item.card.title, errors: item.result.errors }))
    });
  }
  if (!validItems.length) {
    throw Object.assign(new Error('当前没有通过校验的提示词卡。'), {
      statusCode: 422,
      details: invalidItems.map(item => ({ id: item.card.id, title: item.card.title, errors: item.result.errors }))
    });
  }
  const selected = validItems.map(item => item.card);
  const expandedTaskCount = selected.reduce((sum, card) => sum + Number(card.generation_count || 1), 0);

  const batchId = uid('batch');
  const at = nowIso();
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare('INSERT INTO batches(id,cookie_profile_id,output_directory,status,task_count,created_at,updated_at) VALUES(?,?,?,?,?,?,?)')
      .run(batchId, cookieProfileId, outputDirectory, 'queued', expandedTaskCount, at, at);
    const insertTask = db.prepare(`INSERT INTO generation_tasks(id,batch_id,prompt_card_id,position,status,asset_ids_json,media_refs_json,prompt_raw,prompt_compiled,duration_seconds,output_filename,retry_limit,retry_count,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    let taskPosition = 0;
    selected.forEach((card, cardIndex) => {
      const assets = assetRows(card.asset_ids);
      const mediaRows = mediaRefRows(card.media_refs || []);
      const count = Number(card.generation_count || 1);
      const autoBase = `video_${new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14)}_${String(cardIndex + 1).padStart(3, '0')}`;
      const baseFilename = safeFilename(card.output_filename || autoBase);
      for (let copyIndex = 0; copyIndex < count; copyIndex += 1) {
        taskPosition += 1;
        const filename = count > 1 ? safeFilename(`${baseFilename}_${String(copyIndex + 1).padStart(2, '0')}`) : baseFilename;
        insertTask.run(
          uid('task'), batchId, card.id, taskPosition, 'queued', JSON.stringify(card.asset_ids), JSON.stringify(normalizeMediaRefs(card.media_refs || [])), card.prompt_raw,
          compilePrompt(card.prompt_raw, assets, mediaRows), card.duration_seconds, filename, card.retry_limit, 0, at, at
        );
      }
      db.prepare('UPDATE prompt_cards SET active=0,updated_at=? WHERE id=?').run(at, card.id);
    });
    normalizeCardPositions();
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  logEvent({ stage: 'batch_created', entityType: 'batch', entityId: batchId, message: 'Submission batch created', payload: { taskCount: expandedTaskCount, cardCount: selected.length, skippedCount: invalidItems.length } });
  emit('batch_created', { batchId });
  if (startWorker) runWorker().catch(error => logEvent({ level: 'error', stage: 'worker_crash', message: error.message }));
  return {
    batchId,
    taskCount: expandedTaskCount,
    skippedCount: invalidItems.length,
    submittedCardIds: selected.map(card => card.id),
    skippedCards: invalidItems.map(item => ({ id: item.card.id, title: item.card.title, errors: item.result.errors }))
  };
}

const TERMINAL_TASK_STATUSES = new Set(['completed', 'submit_failed', 'remote_failed', 'download_failed']);

function refreshBatchAfterTaskDeletion(batchId) {
  if (!batchId) return;
  const remaining = Number(db.prepare('SELECT COUNT(*) AS count FROM generation_tasks WHERE batch_id=?').get(batchId)?.count || 0);
  if (!remaining) {
    db.prepare('DELETE FROM batches WHERE id=?').run(batchId);
    return;
  }
  const active = Number(db.prepare(`SELECT COUNT(*) AS count FROM generation_tasks
    WHERE batch_id=? AND status NOT IN ('completed','submit_failed','remote_failed','download_failed')`).get(batchId)?.count || 0);
  db.prepare('UPDATE batches SET task_count=?,status=?,updated_at=? WHERE id=?')
    .run(remaining, active ? 'running' : 'submitted', nowIso(), batchId);
}

export function deleteTaskRecord(id) {
  const task = db.prepare('SELECT id,batch_id,status,download_path FROM generation_tasks WHERE id=?').get(id);
  if (!task) throw Object.assign(new Error('任务记录不存在。'), { statusCode: 404 });
  if (!TERMINAL_TASK_STATUSES.has(task.status)) {
    throw Object.assign(new Error('正在排队、上传、提交、生成或下载中的任务不能删除。'), {
      statusCode: 409,
      code: 'TASK_STILL_ACTIVE'
    });
  }
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare("DELETE FROM event_logs WHERE entity_type='task' AND entity_id=?").run(id);
    db.prepare('DELETE FROM generation_tasks WHERE id=?').run(id);
    refreshBatchAfterTaskDeletion(task.batch_id);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  emit('task_deleted', { taskId: id });
  return { deleted: 1, skippedActive: 0, keptFile: Boolean(task.download_path), downloadPath: task.download_path || '' };
}

export function deleteFinishedTaskRecords() {
  const rows = db.prepare(`SELECT id,batch_id,status,download_path FROM generation_tasks
    WHERE status IN ('completed','submit_failed','remote_failed','download_failed')`).all();
  if (!rows.length) return { deleted: 0, skippedActive: Number(db.prepare('SELECT COUNT(*) AS count FROM generation_tasks').get()?.count || 0) };
  const batchIds = [...new Set(rows.map(row => row.batch_id).filter(Boolean))];
  const deleteEvents = db.prepare("DELETE FROM event_logs WHERE entity_type='task' AND entity_id=?");
  const deleteTask = db.prepare('DELETE FROM generation_tasks WHERE id=?');
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const row of rows) {
      deleteEvents.run(row.id);
      deleteTask.run(row.id);
    }
    for (const batchId of batchIds) refreshBatchAfterTaskDeletion(batchId);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  const skippedActive = Number(db.prepare('SELECT COUNT(*) AS count FROM generation_tasks').get()?.count || 0);
  emit('tasks_deleted', { deleted: rows.length, skippedActive });
  return { deleted: rows.length, skippedActive, keptDownloadedFiles: rows.filter(row => row.download_path).length };
}

export function updateTaskRecord(id, patch) {
  const entries = Object.entries({ ...patch, updated_at: nowIso() }).filter(([, value]) => value !== undefined);
  const sql = `UPDATE generation_tasks SET ${entries.map(([key]) => `${key}=?`).join(',')} WHERE id=?`;
  db.prepare(sql).run(...entries.map(([, value]) => value), id);
  emit('task_updated', { taskId: id, patch });
}

function restoreCardToInput(cardId) {
  if (!cardId) return;
  const card = db.prepare('SELECT id,active,archived_at FROM prompt_cards WHERE id=?').get(cardId);
  if (!card || Number(card.active) === 1 || card.archived_at) return;
  const nextPosition = Number(db.prepare('SELECT COALESCE(MAX(position),0)+1 AS next FROM prompt_cards WHERE active=1').get().next);
  db.prepare('UPDATE prompt_cards SET active=1,position=?,generation_count=1,updated_at=? WHERE id=?').run(nextPosition, nowIso(), cardId);
  normalizeCardPositions();
  emit('card_restored', { cardId });
}

async function processTask(task) {
  const batch = db.prepare('SELECT * FROM batches WHERE id=?').get(task.batch_id);
  const assets = assetRows(jsonParse(task.asset_ids_json, []));
  const mediaRows = mediaRefRows(jsonParse(task.media_refs_json, []));
  const maxAttempts = 1 + Number(task.retry_limit || 0);
  let lastError;

  for (let attempt = Number(task.retry_count || 0); attempt < maxAttempts; attempt += 1) {
    try {
      updateTaskRecord(task.id, { status: 'uploading_media', retry_count: attempt, error_code: null, error_message: null });
      const media = [];
      for (const asset of assets) {
        const remote = await resolveRemoteImage(asset, batch.cookie_profile_id);
        media.push({ ...remote, name: asset.file_name, assetId: asset.id });
      }
      for (const item of mediaRows) {
        if (!item.media) throw new Error('任务中的音视频参考已不存在。');
        const remote = await resolveRemoteReferenceMedia(item, batch.cookie_profile_id);
        media.push({ ...remote, name: item.media.file_name, mediaId: item.media.id });
      }
      updateTaskRecord(task.id, { status: 'submitting' });
      const submitted = await submitGeneration({
        cookieProfileId: batch.cookie_profile_id,
        prompt: task.prompt_compiled,
        duration: task.duration_seconds,
        media
      });
      const submittedAt = nowIso();
      updateTaskRecord(task.id, {
        status: 'submitted',
        remote_task_id: submitted.taskId,
        remote_response_json: JSON.stringify(submitted.response),
        submitted_at: submittedAt,
        first_submitted_at: task.first_submitted_at || submittedAt,
        failed_at: null,
        retry_count: attempt
      });
      logEvent({ stage: 'task_submitted', entityType: 'task', entityId: task.id, message: 'Task submitted', payload: { remoteTaskId: submitted.taskId, attempt } });
      return;
    } catch (error) {
      lastError = error;
      const providerResponse = error.providerResponse ? JSON.stringify(error.providerResponse).slice(0, 10000) : null;
      const terminal = attempt + 1 >= maxAttempts;
      updateTaskRecord(task.id, {
        status: terminal ? 'submit_failed' : 'retry_wait',
        retry_count: attempt,
        failed_at: terminal ? nowIso() : null,
        error_code: error.code || 'SUBMIT_FAILED',
        error_message: String(error.message).slice(0, 2000),
        remote_response_json: providerResponse
      });
      logEvent({ level: 'error', stage: 'task_submit_failed', entityType: 'task', entityId: task.id, message: error.message, payload: { attempt: attempt + 1, maxAttempts } });
      if (attempt + 1 < maxAttempts) {
        await sleep(Math.min(15000, 2000 * (attempt + 1)));
      } else {
        restoreCardToInput(task.prompt_card_id);
      }
    }
  }
  if (lastError) throw lastError;
}

function submitConcurrency() {
  return Math.max(1, Math.min(99, Number(getSetting('submitConcurrency', 5)) || 5));
}

function claimNextCardGroup() {
  const first = db.prepare(`SELECT * FROM generation_tasks
    WHERE status IN ('queued','retry_wait')
    ORDER BY created_at,position LIMIT 1`).get();
  if (!first) return [];
  const rows = db.prepare(`SELECT * FROM generation_tasks
    WHERE batch_id=? AND prompt_card_id=? AND status IN ('queued','retry_wait')
    ORDER BY position`).all(first.batch_id, first.prompt_card_id);
  if (!rows.length) return [];
  const at = nowIso();
  const claimed = [];
  const stmt = db.prepare(`UPDATE generation_tasks SET status='uploading_media',updated_at=?
    WHERE id=? AND status IN ('queued','retry_wait')`);
  for (const row of rows) {
    const result = stmt.run(at, row.id);
    if (Number(result.changes || 0) === 1) claimed.push({ ...row, status: 'uploading_media' });
  }
  return claimed;
}

function finalizeBatch(batchId) {
  const remaining = db.prepare(`SELECT COUNT(*) AS count FROM generation_tasks WHERE batch_id=? AND status IN ('queued','retry_wait','uploading_media','submitting')`).get(batchId).count;
  if (remaining) return;
  const failed = db.prepare(`SELECT COUNT(*) AS count FROM generation_tasks WHERE batch_id=? AND status='submit_failed'`).get(batchId).count;
  db.prepare('UPDATE batches SET status=?,updated_at=? WHERE id=?').run(failed ? 'submitted_with_errors' : 'submitted', nowIso(), batchId);
  emit('batch_updated', { batchId });
}

async function processCardGroup(tasks, concurrency) {
  let index = 0;
  const slotCount = Math.max(1, Math.min(Number(concurrency) || 1, tasks.length));
  const slot = async () => {
    while (index < tasks.length) {
      const task = tasks[index];
      index += 1;
      try { await processTask(task); } catch {}
    }
  };
  await Promise.all(Array.from({ length: slotCount }, () => slot()));
}

async function groupedWorker() {
  const slots = submitConcurrency();
  while (true) {
    const tasks = claimNextCardGroup();
    if (!tasks.length) return;
    const batch = db.prepare('SELECT * FROM batches WHERE id=?').get(tasks[0].batch_id);
    if (batch.status === 'queued') db.prepare('UPDATE batches SET status=?,updated_at=? WHERE id=?').run('running', nowIso(), batch.id);
    logEvent({
      stage: 'prompt_card_group_submit_started',
      entityType: 'batch',
      entityId: tasks[0].batch_id,
      message: 'Prompt-card submission group started',
      payload: { promptCardId: tasks[0].prompt_card_id, taskCount: tasks.length, concurrency: Math.min(slots, tasks.length) }
    });
    await processCardGroup(tasks, slots);
    finalizeBatch(tasks[0].batch_id);
    logEvent({
      stage: 'prompt_card_group_submit_finished',
      entityType: 'batch',
      entityId: tasks[0].batch_id,
      message: 'Prompt-card submission group finished',
      payload: { promptCardId: tasks[0].prompt_card_id, taskCount: tasks.length }
    });
    const pending = db.prepare(`SELECT COUNT(*) AS count FROM generation_tasks WHERE status IN ('queued','retry_wait')`).get().count;
    if (pending) await sleep(1200);
  }
}

export async function runConcurrentSlots(concurrency, slotHandler) {
  const count = Math.max(1, Math.min(99, Number(concurrency) || 1));
  return Promise.all(Array.from({ length: count }, () => slotHandler()));
}

export async function runWorker() {
  if (workerPromise) return workerPromise;
  workerPromise = groupedWorker()
    .finally(() => {
      workerPromise = null;
      const pending = db.prepare(`SELECT COUNT(*) AS count FROM generation_tasks WHERE status IN ('queued','retry_wait')`).get().count;
      if (pending) setTimeout(() => runWorker().catch(() => {}), 0);
    });
  return workerPromise;
}

export function recoverInterruptedTasks() {
  const at = nowIso();
  db.prepare(`UPDATE generation_tasks SET status='submit_failed',error_code='APP_RESTARTED_BEFORE_TASK_ID',error_message='应用在获得 taskId 前退出；为避免重复提交，任务未自动重提。',failed_at=?,updated_at=?
    WHERE status IN ('uploading_media','submitting') AND remote_task_id IS NULL`).run(at, at);
}

export { listTasks };
