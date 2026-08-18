import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'uvs-valid-cards-'));
process.env.STUDIO_DB_PATH = path.join(tempDir, 'test.db');

const { db, listCards, setSetting } = await import('../server/db.js');
const { createSubmissionBatch, cardValidationSummary } = await import('../server/taskService.js');

const now = new Date().toISOString();
try {
  db.prepare('DELETE FROM prompt_cards').run();
  db.prepare(`INSERT INTO cookie_profiles(id,name,encrypted_secret,status,cookie_count,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?)`).run('cookie_test', 'test-cookie', 'encrypted-placeholder', 'valid', 1, now, now);
  setSetting('outputDirectory', tempDir);

  db.prepare(`INSERT INTO asset_folders(id,folder_path,display_name,recursive,active,scanned_at,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?)`).run('folder_test', tempDir, 'test-folder', 1, 1, now, now, now);
  db.prepare(`INSERT INTO assets(id,folder_id,absolute_path,relative_path,file_name,alias,mime_type,byte_size,width,height,sha256,active,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      'asset_test', 'folder_test', path.join(tempDir, 'reference.png'), 'reference.png', 'reference.png',
      'reference', 'image/png', 100, 100, 100, 'sha256-test', 1, now, now
    );

  db.prepare(`INSERT INTO prompt_cards(id,position,title,asset_ids_json,prompt_raw,duration_seconds,output_filename,retry_limit,active,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(
      'card_valid', 1, '有效卡片', JSON.stringify(['asset_test']),
      '使用手动选择的参考图生成视频。文本中允许出现 @Image 1，也不要求绑定。',
      15, 'valid_video', 0, 1, now, now
    );
  db.prepare(`INSERT INTO prompt_cards(id,position,title,asset_ids_json,prompt_raw,duration_seconds,output_filename,retry_limit,active,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(
      'card_invalid', 2, '未完成卡片', '[]', '', 15, '', 0, 1, now, now
    );

  const before = cardValidationSummary();
  const result = createSubmissionBatch({ cookieProfileId: 'cookie_test', startWorker: false });
  const remainingCards = listCards();
  const tasks = db.prepare('SELECT id,prompt_card_id,status,prompt_raw,prompt_compiled FROM generation_tasks').all();
  const archived = db.prepare('SELECT id,active FROM prompt_cards ORDER BY id').all();

  if (before.filter(item => item.valid).length !== 1) throw new Error('Expected exactly one valid card before submit.');
  if (result.taskCount !== 1 || result.skippedCount !== 1) throw new Error('Expected one submitted and one skipped card.');
  if (tasks.length !== 1 || tasks[0].prompt_card_id !== 'card_valid') throw new Error('Only the valid card should create a task.');
  if (!tasks[0].prompt_raw.includes('@Image 1')) throw new Error('@ text should be accepted without mandatory binding.');
  if (remainingCards.length !== 1 || remainingCards[0].id !== 'card_invalid') throw new Error('Only the invalid draft should remain in input cards.');
  if (archived.find(row => row.id === 'card_valid')?.active !== 0) throw new Error('Submitted card should be archived from the input area.');

  console.log(JSON.stringify({
    ok: true,
    submitted: result.taskCount,
    skipped: result.skippedCount,
    remainingInputCards: remainingCards.map(card => card.id),
    promptAccepted: tasks[0].prompt_raw
  }, null, 2));
} finally {
  db.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
}
