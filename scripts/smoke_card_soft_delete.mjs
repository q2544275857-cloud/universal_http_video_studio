import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'uvs-card-delete-'));
process.env.STUDIO_STORAGE_DIR = tempRoot;

const { db } = await import('../server/db.js');
const { createCard, deleteCard, listCards } = await import('../server/taskService.js');
const { uid, nowIso } = await import('../server/utils.js');

const activeBefore = listCards();
const card = activeBefore[0] || createCard();
const at = nowIso();
const cookieId = uid('cookie');
const batchId = uid('batch');
const taskId = uid('task');

db.prepare(`INSERT INTO cookie_profiles(id,name,encrypted_secret,status,cookie_count,created_at,updated_at)
  VALUES(?,?,?,?,?,?,?)`).run(cookieId, 'test', 'encrypted', 'valid', 1, at, at);
db.prepare(`INSERT INTO batches(id,cookie_profile_id,output_directory,status,task_count,created_at,updated_at)
  VALUES(?,?,?,?,?,?,?)`).run(batchId, cookieId, tempRoot, 'submitted', 1, at, at);
db.prepare(`INSERT INTO generation_tasks(id,batch_id,prompt_card_id,position,status,asset_ids_json,prompt_raw,prompt_compiled,duration_seconds,output_filename,retry_limit,retry_count,created_at,updated_at)
  VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(taskId, batchId, card.id, 1, 'submitted', '[]', 'test prompt', 'test prompt', 15, 'test-video', 0, 0, at, at);

const result = deleteCard(card.id);
const archived = db.prepare('SELECT id,active,archived_at FROM prompt_cards WHERE id=?').get(card.id);
const task = db.prepare('SELECT id,prompt_card_id FROM generation_tasks WHERE id=?').get(taskId);
const activeAfter = listCards();

console.log(JSON.stringify({
  ok: Boolean(result.archived)
    && result.taskCount === 1
    && Number(archived.active) === 0
    && Boolean(archived.archived_at)
    && task.prompt_card_id === card.id
    && activeAfter.length === 1
    && activeAfter[0].id !== card.id,
  result,
  archived,
  taskPreserved: Boolean(task),
  replacementCardCount: activeAfter.length
}, null, 2));
