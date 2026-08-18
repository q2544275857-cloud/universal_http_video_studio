import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { db } from '../server/db.js';
import { runLifecycleCycle } from '../server/lifecycleService.js';
import { nowIso, uid } from '../server/utils.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outputDir = path.join(root, 'storage', 'cache', 'stage3-lifecycle-smoke');
fs.rmSync(outputDir, { recursive: true, force: true });
fs.mkdirSync(outputDir, { recursive: true });

const ftyp = Buffer.from([
  0x00,0x00,0x00,0x18, 0x66,0x74,0x79,0x70, 0x69,0x73,0x6f,0x6d,
  0x00,0x00,0x02,0x00, 0x69,0x73,0x6f,0x6d, 0x69,0x73,0x6f,0x32
]);
const fakeVideo = Buffer.concat([ftyp, Buffer.alloc(8192, 1)]);
const server = http.createServer((req, res) => {
  if (req.url === '/result.mp4') {
    res.writeHead(200, { 'content-type': 'video/mp4', 'content-length': fakeVideo.length });
    res.end(fakeVideo);
  } else { res.writeHead(404); res.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${server.address().port}/result.mp4`;
const cookieId = uid('cookie_smoke');
const batchId = uid('batch_smoke');
const taskId = uid('task_smoke');
const card = db.prepare('SELECT id FROM prompt_cards ORDER BY position LIMIT 1').get();
const at = nowIso();

try {
  db.prepare(`INSERT INTO cookie_profiles(id,name,encrypted_secret,status,cookie_count,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?)`).run(cookieId, 'stage3-smoke', 'unused', 'valid', 1, at, at);
  db.prepare(`INSERT INTO batches(id,cookie_profile_id,output_directory,status,task_count,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?)`).run(batchId, cookieId, outputDir, 'processing', 1, at, at);
  db.prepare(`INSERT INTO generation_tasks(
      id,batch_id,prompt_card_id,position,status,asset_ids_json,prompt_raw,prompt_compiled,duration_seconds,
      output_filename,retry_limit,retry_count,remote_task_id,video_url,video_urls_json,next_poll_at,created_at,updated_at,submitted_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      taskId, batchId, card.id, 1, 'video_ready', '[]', 'smoke', 'smoke', 15,
      'lifecycle_smoke_result', 0, 0, 'remote-smoke', url, JSON.stringify([url]), at, at, at, at
    );

  await runLifecycleCycle();
  const task = db.prepare('SELECT * FROM generation_tasks WHERE id=?').get(taskId);
  const result = db.prepare('SELECT * FROM result_assets WHERE task_id=?').get(taskId);
  if (task?.status !== 'completed') throw new Error(`Lifecycle task status=${task?.status}`);
  if (!result || !fs.existsSync(result.local_path)) throw new Error('Result asset was not persisted.');
  console.log(JSON.stringify({ ok: true, status: task.status, downloadPath: task.download_path, resultBytes: result.byte_size }, null, 2));
} finally {
  db.prepare('DELETE FROM batches WHERE id=?').run(batchId);
  db.prepare('DELETE FROM cookie_profiles WHERE id=?').run(cookieId);
  await new Promise(resolve => server.close(resolve));
  fs.rmSync(outputDir, { recursive: true, force: true });
}
