import { db, ensureInitialCard } from '../server/db.js';

const tables = [
  'event_logs',
  'media_cache',
  'generation_tasks',
  'batches',
  'prompt_cards',
  'assets',
  'asset_folders',
  'cookie_profiles',
  'settings'
];

db.exec('PRAGMA foreign_keys=OFF; BEGIN IMMEDIATE;');
try {
  for (const table of tables) db.exec(`DELETE FROM ${table};`);
  db.exec('COMMIT; PRAGMA foreign_keys=ON;');
} catch (error) {
  db.exec('ROLLBACK; PRAGMA foreign_keys=ON;');
  throw error;
}
ensureInitialCard();
console.log('Development state reset.');
