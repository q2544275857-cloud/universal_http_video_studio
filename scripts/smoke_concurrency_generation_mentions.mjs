import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'uvs-concurrency-'));
process.env.STUDIO_STORAGE_DIR = path.join(root, 'storage');
process.env.STUDIO_DB_PATH = path.join(root, 'storage', 'data', 'studio.db');

const { db, listCards, setSetting } = await import('../server/db.js');
const { updateCard, createSubmissionBatch, runConcurrentSlots } = await import('../server/taskService.js');
const { nowIso } = await import('../server/utils.js');

const at = nowIso();
const folderId = 'folder_test';
fs.mkdirSync(path.join(root, 'images'), { recursive: true });
db.prepare(`INSERT INTO asset_folders(id,folder_path,display_name,recursive,active,scanned_at,created_at,updated_at)
  VALUES(?,?,?,?,?,?,?,?)`).run(folderId, path.join(root, 'images'), 'test', 1, 1, at, at, at);

const assets = [
  { id: 'asset_1636', alias: '枕头床垫白底图1636' },
  { id: 'asset_1446', alias: '枕头床垫白底图1446' },
  { id: 'asset_1583', alias: '枕头床垫白底图1583' },
  { id: 'asset_1489', alias: '枕头床垫白底图1489' }
];
for (const [index, asset] of assets.entries()) {
  const filePath = path.join(root, 'images', `${asset.alias}.jpg`);
  fs.writeFileSync(filePath, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
  db.prepare(`INSERT INTO assets(id,folder_id,absolute_path,relative_path,file_name,alias,mime_type,byte_size,width,height,sha256,active,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      asset.id, folderId, filePath, path.basename(filePath), path.basename(filePath), asset.alias,
      'image/jpeg', 4, 100, 100, `sha_${index}`, 1, at, at
    );
}

const card = listCards()[0];
const prompt = `@枕头床垫白底图1636 主参考。\n@枕头床垫白底图1446 立体参考。\n@枕头床垫白底图1636 再次强调主参考。\n@枕头床垫白底图1583 侧面参考。\n@枕头床垫白底图1489 后侧参考。`;
const updated = updateCard(card.id, {
  manualAssetIds: [],
  prompt,
  duration: 15,
  filename: 'pillow_test',
  retryLimit: 0,
  generationCount: 3
});

if (updated.asset_ids.length !== 4) throw new Error(`自动参考图应为 4 张，实际 ${updated.asset_ids.length}`);
if (updated.auto_asset_ids.length !== 4) throw new Error(`自动匹配应为 4 张，实际 ${updated.auto_asset_ids.length}`);
if (updated.generation_count !== 3) throw new Error('生成条数未保存。');

const cookieId = 'cookie_test';
db.prepare(`INSERT INTO cookie_profiles(id,name,encrypted_secret,status,cookie_count,created_at,updated_at)
  VALUES(?,?,?,?,?,?,?)`).run(cookieId, 'test', 'encrypted-placeholder', 'valid', 1, at, at);
setSetting('outputDirectory', root);
setSetting('submitConcurrency', 5);

const batch = createSubmissionBatch({ cookieProfileId: cookieId, cardIds: [card.id], startWorker: false });
if (batch.taskCount !== 3) throw new Error(`应创建 3 条任务，实际 ${batch.taskCount}`);
const tasks = db.prepare(`SELECT position,asset_ids_json,prompt_compiled,output_filename,status
  FROM generation_tasks WHERE batch_id=? ORDER BY position`).all(batch.batchId);
if (tasks.length !== 3) throw new Error('任务展开数量错误。');
const expectedNames = ['pillow_test_01', 'pillow_test_02', 'pillow_test_03'];
for (let index = 0; index < tasks.length; index += 1) {
  if (tasks[index].output_filename !== expectedNames[index]) throw new Error(`文件名编号错误：${tasks[index].output_filename}`);
  const refs = JSON.parse(tasks[index].asset_ids_json);
  if (refs.length !== 4) throw new Error('任务参考图数量错误。');
  const repeated = tasks[index].prompt_compiled.match(/<\|media:0\|>/g) || [];
  if (repeated.length !== 2) throw new Error(`重复 @ 引用没有保留，实际 ${repeated.length} 次。`);
}

let remainingJobs = 20;
let activeJobs = 0;
let maxActiveJobs = 0;
let finishedJobs = 0;
await runConcurrentSlots(5, async () => {
  while (remainingJobs > 0) {
    remainingJobs -= 1;
    activeJobs += 1;
    maxActiveJobs = Math.max(maxActiveJobs, activeJobs);
    await new Promise(resolve => setTimeout(resolve, 15));
    activeJobs -= 1;
    finishedJobs += 1;
  }
});
if (finishedJobs !== 20 || maxActiveJobs !== 5) throw new Error(`并发池错误：finished=${finishedJobs}, max=${maxActiveJobs}`);

console.log(JSON.stringify({
  ok: true,
  submitConcurrency: 5,
  maxObservedConcurrency: maxActiveJobs,
  autoMatchedAssets: updated.auto_asset_ids.length,
  repeatedMentionCount: (tasks[0].prompt_compiled.match(/<\|media:0\|>/g) || []).length,
  generatedTasks: tasks.length,
  filenames: tasks.map(task => task.output_filename)
}, null, 2));
