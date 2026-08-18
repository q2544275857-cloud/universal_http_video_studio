import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { db } from '../server/db.js';
import { nowIso } from '../server/utils.js';

const mode = process.argv[2] || 'create';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixtureDir = path.join(root, 'storage', 'cache', 'stage3-ui-fixture');
const legacyFixtureDir = path.join(root.replace('seedance 2.0', 'seedance%202.0'), 'storage', 'cache', 'stage3-ui-fixture');
const ids = { cookie: 'cookie_stage3_ui_fixture', batch: 'batch_stage3_ui_fixture', task: 'task_stage3_ui_fixture', result: 'result_stage3_ui_fixture' };

function cleanup() {
  db.prepare('DELETE FROM batches WHERE id=?').run(ids.batch);
  db.prepare('DELETE FROM cookie_profiles WHERE id=?').run(ids.cookie);
  fs.rmSync(fixtureDir, { recursive: true, force: true });
  if (legacyFixtureDir !== fixtureDir) fs.rmSync(legacyFixtureDir, { recursive: true, force: true });
}

cleanup();
if (mode === 'cleanup') {
  console.log('Stage 3 UI fixture removed.');
  process.exit(0);
}

fs.mkdirSync(fixtureDir, { recursive: true });
const videoPath = path.join(fixtureDir, 'stage3_ui_result.mp4');
const ftyp = Buffer.from([
  0x00,0x00,0x00,0x18, 0x66,0x74,0x79,0x70, 0x69,0x73,0x6f,0x6d,
  0x00,0x00,0x02,0x00, 0x69,0x73,0x6f,0x6d, 0x69,0x73,0x6f,0x32
]);
fs.writeFileSync(videoPath, Buffer.concat([ftyp, Buffer.alloc(16384, 2)]));
const card = db.prepare('SELECT id FROM prompt_cards ORDER BY position LIMIT 1').get();
const at = nowIso();
db.prepare(`INSERT INTO cookie_profiles(id,name,encrypted_secret,status,cookie_count,created_at,updated_at) VALUES(?,?,?,?,?,?,?)`)
  .run(ids.cookie, 'stage3-ui-fixture', 'unused', 'valid', 1, at, at);
db.prepare(`INSERT INTO batches(id,cookie_profile_id,output_directory,status,task_count,created_at,updated_at) VALUES(?,?,?,?,?,?,?)`)
  .run(ids.batch, ids.cookie, fixtureDir, 'completed', 1, at, at);
db.prepare(`INSERT INTO generation_tasks(
  id,batch_id,prompt_card_id,position,status,asset_ids_json,prompt_raw,prompt_compiled,duration_seconds,output_filename,
  retry_limit,retry_count,remote_task_id,remote_status,poll_count,video_url,video_urls_json,download_path,download_attempts,
  downloaded_at,completed_at,result_metadata_json,created_at,updated_at,submitted_at)
  VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
  ids.task, ids.batch, card.id, 1, 'completed', '[]', '测试提示词', '测试提示词', 15, 'stage3_ui_result',
  0, 0, 'remote_stage3_ui_fixture', 'video_ready', 4, 'https://example.invalid/stage3-ui.mp4',
  JSON.stringify(['https://example.invalid/stage3-ui.mp4']), videoPath, 1, at, at,
  JSON.stringify({ byteSize: fs.statSync(videoPath).size, sha256: 'fixture' }), at, at, at
);
db.prepare(`INSERT INTO result_assets(id,task_id,video_url,local_path,byte_size,sha256,metadata_json,created_at,updated_at)
  VALUES(?,?,?,?,?,?,?,?,?)`).run(
  ids.result, ids.task, 'https://example.invalid/stage3-ui.mp4', videoPath, fs.statSync(videoPath).size, 'fixture', '{}', at, at
);
console.log(JSON.stringify({ ok: true, taskId: ids.task, videoPath }, null, 2));
