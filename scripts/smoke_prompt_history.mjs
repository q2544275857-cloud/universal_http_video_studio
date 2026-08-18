import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'uvs-prompt-history-'));
process.env.STUDIO_STORAGE_DIR = path.join(root, 'runtime');
process.env.STUDIO_DB_PATH = path.join(root, 'runtime', 'data', 'history.db');

const { db } = await import('../server/db.js');
const { listPromptHistory, reusePromptHistory } = await import('../server/taskService.js');
const now = new Date().toISOString();

const folderId = 'folder_history';
db.prepare(`INSERT INTO asset_folders(id,folder_path,display_name,recursive,active,scanned_at,created_at,updated_at)
  VALUES(?,?,?,?,?,?,?,?)`).run(folderId, root, 'history-assets', 1, 1, now, now, now);

db.prepare(`INSERT INTO assets(id,folder_id,absolute_path,relative_path,file_name,alias,mime_type,byte_size,width,height,sha256,active,created_at,updated_at)
  VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    'asset_active', folderId, path.join(root, 'active.png'), 'active.png', 'active.png', 'active', 'image/png', 100, 100, 100, 'a'.repeat(64), 1, now, now
  );
db.prepare(`INSERT INTO assets(id,folder_id,absolute_path,relative_path,file_name,alias,mime_type,byte_size,width,height,sha256,active,created_at,updated_at)
  VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    'asset_inactive', folderId, path.join(root, 'inactive.png'), 'inactive.png', 'inactive.png', 'inactive', 'image/png', 100, 100, 100, 'b'.repeat(64), 0, now, now
  );

const cardId = 'card_source';
db.prepare(`INSERT INTO prompt_cards(id,position,title,asset_ids_json,prompt_raw,duration_seconds,output_filename,retry_limit,active,created_at,updated_at)
  VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(cardId, 1, 'source', '[]', '', 15, '', 0, 0, now, now);
db.prepare(`INSERT INTO cookie_profiles(id,name,encrypted_secret,status,cookie_count,created_at,updated_at)
  VALUES(?,?,?,?,?,?,?)`).run('cookie_source', 'source', 'encrypted', 'valid', 1, now, now);
db.prepare(`INSERT INTO batches(id,cookie_profile_id,output_directory,status,task_count,created_at,updated_at)
  VALUES(?,?,?,?,?,?,?)`).run('batch_source', 'cookie_source', root, 'completed', 1, now, now);

const prompt = '使用 @active 作为产品参考，生成 15 秒视频。';
db.prepare(`INSERT INTO generation_tasks(id,batch_id,prompt_card_id,position,status,asset_ids_json,prompt_raw,prompt_compiled,duration_seconds,output_filename,retry_limit,retry_count,remote_task_id,created_at,updated_at,submitted_at)
  VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    'task_history', 'batch_source', cardId, 1, 'completed', JSON.stringify(['asset_active', 'asset_inactive']), prompt,
    '使用 <|media:0|> 作为产品参考，生成 15 秒视频。', 15, 'history_video', 2, 0, 'remote_123', now, now, now
  );

const history = listPromptHistory(20);
if (history.length !== 1) throw new Error(`Expected one history row, got ${history.length}`);
if (history[0].reusableAssetCount !== 1 || history[0].missingAssetCount !== 1) {
  throw new Error(`Unexpected asset recovery counts: ${JSON.stringify(history[0])}`);
}

const reused = reusePromptHistory('task_history');
if (reused.reusableAssetCount !== 1 || reused.missingAssetCount !== 1) throw new Error('Unexpected reuse counts.');
const card = db.prepare('SELECT * FROM prompt_cards WHERE id=?').get(reused.card.id);
const assetIds = JSON.parse(card.asset_ids_json);
if (card.prompt_raw !== prompt || card.duration_seconds !== 15 || card.retry_limit !== 2 || card.output_filename !== '') {
  throw new Error(`Reused card fields are incorrect: ${JSON.stringify(card)}`);
}
if (JSON.stringify(assetIds) !== JSON.stringify(['asset_active'])) throw new Error(`Unexpected reused assets: ${JSON.stringify(assetIds)}`);

console.log(JSON.stringify({
  ok: true,
  historyCount: history.length,
  reusedCardId: card.id,
  restoredAssets: reused.reusableAssetCount,
  missingAssets: reused.missingAssetCount,
  filenameReset: card.output_filename === ''
}, null, 2));

db.close();
fs.rmSync(root, { recursive: true, force: true });
