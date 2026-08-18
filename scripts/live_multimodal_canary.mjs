import fs from 'node:fs';
import path from 'node:path';
import { db, listCookies, setSetting } from '../server/db.js';
import { importCookie, validateCookie } from '../server/cookieService.js';
import { scanAssetFolder } from '../server/assets.js';
import { createReferenceClip, importReferenceMedia } from '../server/referenceMedia.js';
import { createCard, updateCard, createSubmissionBatch, runWorker } from '../server/taskService.js';

const cookiePath = process.env.COOKIE_PATH || 'D:/seedance 2.0/tiktok_seedance2.0_api_submit/日本cookie.txt';
const videoPath = process.env.VIDEO_PATH || 'D:/seedance 2.0/枕头/03_AI视频资产/每日生产/2026-08-12/DISKRUGS-30S-排行榜复刻/04_后期/原始生成素材/DISKRUGS_30s_ranking_clean_plate_05-A.mp4';
const audioPath = process.env.AUDIO_PATH || 'D:/seedance 2.0/枕头/03_AI视频资产/每日生产/2026-08-12/DISKRUGS-30S-排行榜复刻/04_后期/DISKRUGS_30s_es_voiceover.m4a';
const outputDirectory = process.env.OUTPUT_DIR || 'D:/seedance 2.0/枕头/03_AI视频资产/每日生产/2026-08-12/DISKRUGS-30S-排行榜复刻/04_后期';
const imageFolder = process.env.IMAGE_FOLDER || 'D:/seedance 2.0/枕头/01_预生产资产/视频制作资产/M02_SE/01_预览图';
const outputFilename = process.env.OUTPUT_FILENAME || 'DISKRUGS_universal_multimodal_live_test_v2_6s';

for (const required of [cookiePath, videoPath, audioPath, outputDirectory, imageFolder]) {
  if (!fs.existsSync(required)) throw new Error(`Required path does not exist: ${required}`);
}

let cookie = listCookies().find(item => item.name === '日本cookie-live-canary' && item.status === 'valid');
if (!cookie) {
  cookie = importCookie({ name: '日本cookie-live-canary', content: fs.readFileSync(cookiePath, 'utf8') });
  const validation = await validateCookie(cookie.id);
  if (!validation.valid) throw new Error(`Cookie validation failed: ${validation.message}`);
  cookie = listCookies().find(item => item.id === cookie.id);
}

const imported = await importReferenceMedia([videoPath, audioPath]);
if (imported.rejected?.length) throw new Error(`Reference import rejected: ${JSON.stringify(imported.rejected)}`);
const video = imported.imported.find(item => item.media_type === 'video');
const audio = imported.imported.find(item => item.media_type === 'audio');
if (!video || !audio) throw new Error('Video/audio reference import did not return both media items.');
const audioClip = await createReferenceClip(audio.id, { startSeconds: 0, durationSeconds: 6 });

scanAssetFolder(imageFolder, { force: true });
const image = db.prepare('SELECT * FROM assets WHERE active=1 AND lower(folder_id) IN (SELECT lower(id) FROM asset_folders WHERE lower(folder_path)=lower(?)) ORDER BY relative_path LIMIT 1').get(path.resolve(imageFolder));
if (!image) throw new Error('No active local image asset is available for the mandatory image reference.');

setSetting('activeCookieId', cookie.id);
setSetting('outputDirectory', path.resolve(outputDirectory));
setSetting('submitConcurrency', 1);

const card = createCard();
const prompt = [
  `使用 @${image.alias} 作为产品外形参考。`,
  `参考 @${video.alias} 的镜头节奏、构图变化和动作时序，生成一个 6 秒竖屏真实 TikTok UGC 测试片段。`,
  `使用 @${audio.alias} 作为声音参考；不要添加字幕、水印或额外文案。`,
  '这是多模态接口联调测试：保持产品外形稳定、动作自然、画面真实，不需要医疗功效表达。'
].join('\n');

const updated = updateCard(card.id, {
  assetIds: [image.id],
  mediaRefs: [
    { mediaId: video.id, startSeconds: 0, durationSeconds: Number(video.duration_seconds || 0) },
    { mediaId: audio.id, clipId: audioClip.id, startSeconds: 0, durationSeconds: 6 }
  ],
  prompt,
  duration: 6,
  filename: outputFilename,
  retryLimit: 0,
  generationCount: 1
});

const batch = createSubmissionBatch({ cookieProfileId: cookie.id, cardIds: [updated.id], startWorker: false });
await runWorker();

const task = db.prepare('SELECT * FROM generation_tasks WHERE batch_id=? ORDER BY position LIMIT 1').get(batch.batchId);
const mediaCache = db.prepare('SELECT asset_sha256,remote_uri,cdn_url,metadata_json,updated_at FROM media_cache WHERE cookie_profile_id=? ORDER BY updated_at DESC LIMIT 8').all(cookie.id)
  .map(row => {
    let metadata = {};
    try { metadata = JSON.parse(row.metadata_json || '{}'); } catch {}
    return {
      remoteUri: row.remote_uri,
      hasCdnUrl: Boolean(row.cdn_url),
      fileType: metadata.fileType || 'image',
      duration: Number(metadata.duration || 0),
      updatedAt: row.updated_at
    };
  });

console.log(JSON.stringify({
  ok: Boolean(task?.remote_task_id),
  cookie: { id: cookie.id, name: cookie.name, status: cookie.status },
  references: {
    image: { id: image.id, file: image.file_name, alias: image.alias },
    video: { id: video.id, file: video.file_name, alias: video.alias, duration: video.duration_seconds },
    audio: { id: audio.id, file: audio.file_name, alias: audio.alias, duration: audio.duration_seconds, clipId: audioClip.id, submittedDuration: 6 }
  },
  batch: { id: batch.batchId, taskCount: batch.taskCount },
  task: task ? {
    id: task.id,
    status: task.status,
    remoteTaskId: task.remote_task_id,
    errorCode: task.error_code,
    errorMessage: task.error_message,
    submittedAt: task.submitted_at,
    outputFilename: task.output_filename
  } : null,
  recentRemoteMedia: mediaCache
}, null, 2));

if (!task?.remote_task_id) process.exitCode = 2;
