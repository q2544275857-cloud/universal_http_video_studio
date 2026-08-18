import { db } from '../server/db.js';
import { recoverLifecycleTasks } from '../server/lifecycleService.js';
import { nowIso, uid } from '../server/utils.js';

const cookieId = uid('cookie_recovery');
const batchId = uid('batch_recovery');
const card = db.prepare('SELECT id FROM prompt_cards ORDER BY position LIMIT 1').get();
const at = nowIso();
const ids = {
  submitted: uid('task_submitted'),
  downloading: uid('task_downloading'),
  missing: uid('task_missing')
};

try {
  db.prepare(`INSERT INTO cookie_profiles(id,name,encrypted_secret,status,cookie_count,created_at,updated_at) VALUES(?,?,?,?,?,?,?)`)
    .run(cookieId, 'recovery-smoke', 'unused', 'valid', 1, at, at);
  db.prepare(`INSERT INTO batches(id,cookie_profile_id,output_directory,status,task_count,created_at,updated_at) VALUES(?,?,?,?,?,?,?)`)
    .run(batchId, cookieId, process.cwd(), 'processing', 3, at, at);
  const insert = db.prepare(`INSERT INTO generation_tasks(
    id,batch_id,prompt_card_id,position,status,asset_ids_json,prompt_raw,prompt_compiled,duration_seconds,output_filename,
    retry_limit,retry_count,remote_task_id,video_url,video_urls_json,download_path,created_at,updated_at,submitted_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  insert.run(ids.submitted, batchId, card.id, 1, 'submitted', '[]', 'a', 'a', 15, 'recovery_a', 0, 0, 'remote_a', null, '[]', null, at, at, at);
  insert.run(ids.downloading, batchId, card.id, 2, 'downloading', '[]', 'b', 'b', 15, 'recovery_b', 0, 0, 'remote_b', 'https://example.invalid/b.mp4', '["https://example.invalid/b.mp4"]', null, at, at, at);
  insert.run(ids.missing, batchId, card.id, 3, 'completed', '[]', 'c', 'c', 15, 'recovery_c', 0, 0, 'remote_c', 'https://example.invalid/c.mp4', '["https://example.invalid/c.mp4"]', 'Z:\\missing\\video.mp4', at, at, at);

  recoverLifecycleTasks();
  const rows = db.prepare('SELECT id,status,next_poll_at,error_code FROM generation_tasks WHERE batch_id=? ORDER BY position').all(batchId);
  const map = Object.fromEntries(rows.map(row => [row.id, row]));
  if (map[ids.submitted]?.status !== 'polling' || !map[ids.submitted]?.next_poll_at) throw new Error('Submitted task was not recovered to polling.');
  if (map[ids.downloading]?.status !== 'video_ready' || !map[ids.downloading]?.next_poll_at) throw new Error('Downloading task was not recovered to video_ready.');
  if (map[ids.missing]?.status !== 'download_failed' || map[ids.missing]?.error_code !== 'LOCAL_RESULT_MISSING') throw new Error('Missing completed file was not detected.');
  console.log(JSON.stringify({ ok: true, rows }, null, 2));
} finally {
  db.prepare('DELETE FROM batches WHERE id=?').run(batchId);
  db.prepare('DELETE FROM cookie_profiles WHERE id=?').run(cookieId);
}
