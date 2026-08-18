import fs from 'node:fs';
import { db, getSetting } from '../server/db.js';
import { validateCookie } from '../server/cookieService.js';
import { createCard, updateCard, cardValidationSummary, createSubmissionBatch, runWorker, listTasks } from '../server/taskService.js';

const OLD_BATCH = 'batch_7d6d2062-407c-47f4-b519-17d75971828c';
const COOKIE_ID = 'cookie_ec641f32-3520-43e5-9a69-0a7a1d20010c';
const SOURCE_CARD_ID = 'card_c2e563c1-4433-4b86-b2b2-04d6b8340b8a';
const EXPECTED_COOKIE_PATH = 'D:/seedance 2.0/universal_http_video_studio/日本cookie.txt';

if (!fs.existsSync(EXPECTED_COOKIE_PATH)) throw new Error('Expected Cookie file is missing.');

const oldActive = db.prepare(`SELECT id,status,remote_task_id FROM generation_tasks
  WHERE batch_id=? AND status IN ('queued','retry_wait','uploading_media','submitting')`).all(OLD_BATCH);
if (oldActive.some(row => row.remote_task_id)) throw new Error('Old active task unexpectedly has a remote task id.');

// Quarantine only the superseded local-only queue so the worker cannot revive it.
const at = new Date().toISOString();
db.prepare(`UPDATE generation_tasks SET status='submit_failed',error_code='SUPERSEDED_BY_V3_QA',
  error_message='Superseded local-only queue; never submitted remotely; do not retry.',failed_at=?,updated_at=?
  WHERE batch_id=? AND remote_task_id IS NULL AND status IN ('queued','retry_wait','uploading_media','submitting')`).run(at, at, OLD_BATCH);
db.prepare(`UPDATE batches SET status='superseded',updated_at=? WHERE id=?`).run(at, OLD_BATCH);

const cookieResult = await validateCookie(COOKIE_ID);
if (!cookieResult.valid) throw new Error(`Cookie validation failed: ${cookieResult.message}`);

const source = db.prepare('SELECT * FROM prompt_cards WHERE id=?').get(SOURCE_CARD_ID);
if (!source) throw new Error('Approved C01 source card is missing.');
const card = createCard(SOURCE_CARD_ID);
const updated = updateCard(card.id, {
  prompt: source.prompt_raw,
  manualAssetIds: JSON.parse(source.manual_asset_ids_json || source.asset_ids_json || '[]'),
  manualMediaRefs: JSON.parse(source.manual_media_refs_json || source.media_refs_json || '[]'),
  duration: 11,
  filename: 'M02_WILLIAM_V3_CANARY_ST-A_C01_11s',
  retryLimit: 0,
  generationCount: 1
});
const validation = cardValidationSummary().find(item => item.id === updated.id);
if (!validation?.valid) throw new Error(`Canary card invalid: ${JSON.stringify(validation)}`);
const outputDirectory = getSetting('outputDirectory', '');
if (!outputDirectory || !fs.existsSync(outputDirectory)) throw new Error(`Output directory invalid: ${outputDirectory}`);

const batch = createSubmissionBatch({ cookieProfileId: COOKIE_ID, cardIds: [updated.id], startWorker: false });
await runWorker();
const task = listTasks().find(item => item.batch_id === batch.batchId);
console.log(JSON.stringify({ cookieResult, validation, outputDirectory, batch, task: task ? {
  id: task.id,
  status: task.status,
  remoteTaskId: task.remote_task_id || null,
  errorCode: task.error_code || null,
  errorMessage: task.error_message || null,
  outputFilename: task.output_filename
} : null }, null, 2));
