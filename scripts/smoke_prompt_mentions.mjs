import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { applyPromptMention, promptMentionContext } from '../public/promptMentions.js';

const empty = promptMentionContext('请参考 @', '请参考 @'.length);
assert.deepEqual(empty && { query: empty.query, start: empty.start }, { query: '', start: 4 });

const filtered = promptMentionContext('请参考 @枕', '请参考 @枕'.length);
assert.equal(filtered?.query, '枕');
assert.equal(promptMentionContext('请保留 \\@ 符号', '请保留 \\@'.length), null);

const inserted = applyPromptMention('请参考 @ 制作视频', empty, '商品图');
assert.equal(inserted.value, '请参考 @商品图 制作视频');
assert.equal(inserted.caret, '请参考 @商品图'.length);

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'uvs-mention-'));
process.env.STUDIO_DB_PATH = path.join(tempRoot, 'studio.db');

const { db, listCards, setSetting } = await import('../server/db.js');
const { createSubmissionBatch, updateCard } = await import('../server/taskService.js');
const now = new Date().toISOString();
const card = listCards()[0];

db.prepare(`INSERT INTO cookie_profiles(id,name,encrypted_secret,status,cookie_count,created_at,updated_at)
  VALUES(?,?,?,?,?,?,?)`).run('cookie_test', 'test', 'encrypted-placeholder', 'valid', 1, now, now);
db.prepare(`INSERT INTO asset_folders(id,folder_path,display_name,recursive,active,scanned_at,created_at,updated_at)
  VALUES(?,?,?,?,?,?,?,?)`).run('folder_test', tempRoot, 'test', 1, 1, now, now, now);
db.prepare(`INSERT INTO assets(id,folder_id,absolute_path,relative_path,file_name,alias,mime_type,byte_size,width,height,sha256,active,created_at,updated_at)
  VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    'asset_test', 'folder_test', path.join(tempRoot, 'product.png'), 'product.png', 'product.png', '商品图',
    'image/png', 1, 1, 1, 'sha-test', 1, now, now
  );
setSetting('outputDirectory', tempRoot);
updateCard(card.id, {
  assetIds: ['asset_test'],
  prompt: '使用 @商品图 作为产品外观参考。',
  duration: 15,
  filename: 'mention-test',
  retryLimit: 0
});

const batch = createSubmissionBatch({ cookieProfileId: 'cookie_test', startWorker: false });
assert.equal(batch.taskCount, 1);
const task = db.prepare('SELECT prompt_raw,prompt_compiled FROM generation_tasks LIMIT 1').get();
assert.equal(task.prompt_raw, '使用 @商品图 作为产品外观参考。');
assert.equal(task.prompt_compiled, '使用 <|media:0|> 作为产品外观参考。');

console.log(JSON.stringify({
  ok: true,
  pickerQuery: filtered.query,
  insertedPrompt: inserted.value,
  compiledPrompt: task.prompt_compiled
}, null, 2));

db.close();
fs.rmSync(tempRoot, { recursive: true, force: true });
