import { DatabaseSync } from 'node:sqlite';
import { DB_PATH } from './config.js';
import { nowIso, jsonParse, jsonStringify, uid } from './utils.js';

export const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode=WAL;');
db.exec('PRAGMA foreign_keys=ON;');
db.exec('PRAGMA busy_timeout=5000;');

db.exec(`
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS cookie_profiles (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  encrypted_secret TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'unknown',
  cookie_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  validated_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS asset_folders (
  id TEXT PRIMARY KEY,
  folder_path TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  recursive INTEGER NOT NULL DEFAULT 1,
  active INTEGER NOT NULL DEFAULT 1,
  scanned_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS assets (
  id TEXT PRIMARY KEY,
  folder_id TEXT NOT NULL,
  absolute_path TEXT NOT NULL,
  relative_path TEXT NOT NULL,
  file_name TEXT NOT NULL,
  alias TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  byte_size INTEGER NOT NULL,
  width INTEGER NOT NULL DEFAULT 0,
  height INTEGER NOT NULL DEFAULT 0,
  sha256 TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(folder_id, relative_path),
  FOREIGN KEY(folder_id) REFERENCES asset_folders(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_assets_folder_active ON assets(folder_id, active);
CREATE INDEX IF NOT EXISTS idx_assets_sha256 ON assets(sha256);

CREATE TABLE IF NOT EXISTS reference_media (
  id TEXT PRIMARY KEY,
  media_type TEXT NOT NULL,
  source_path TEXT NOT NULL UNIQUE,
  file_name TEXT NOT NULL,
  alias TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  byte_size INTEGER NOT NULL DEFAULT 0,
  duration_seconds REAL NOT NULL DEFAULT 0,
  width INTEGER NOT NULL DEFAULT 0,
  height INTEGER NOT NULL DEFAULT 0,
  sha256 TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_reference_media_active ON reference_media(active, media_type);
CREATE INDEX IF NOT EXISTS idx_reference_media_sha256 ON reference_media(sha256);

CREATE TABLE IF NOT EXISTS reference_media_clips (
  id TEXT PRIMARY KEY,
  media_id TEXT NOT NULL,
  start_ms INTEGER NOT NULL,
  duration_ms INTEGER NOT NULL,
  clip_path TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  byte_size INTEGER NOT NULL DEFAULT 0,
  sha256 TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(media_id, start_ms, duration_ms),
  FOREIGN KEY(media_id) REFERENCES reference_media(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS prompt_cards (
  id TEXT PRIMARY KEY,
  position INTEGER NOT NULL,
  title TEXT NOT NULL,
  asset_ids_json TEXT NOT NULL DEFAULT '[]',
  manual_asset_ids_json TEXT NOT NULL DEFAULT '[]',
  auto_asset_ids_json TEXT NOT NULL DEFAULT '[]',
  media_refs_json TEXT NOT NULL DEFAULT '[]',
  manual_media_refs_json TEXT NOT NULL DEFAULT '[]',
  auto_media_refs_json TEXT NOT NULL DEFAULT '[]',
  prompt_raw TEXT NOT NULL DEFAULT '',
  duration_seconds INTEGER NOT NULL DEFAULT 15,
  output_filename TEXT NOT NULL DEFAULT '',
  retry_limit INTEGER NOT NULL DEFAULT 0,
  generation_count INTEGER NOT NULL DEFAULT 1,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS batches (
  id TEXT PRIMARY KEY,
  cookie_profile_id TEXT NOT NULL,
  output_directory TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  task_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(cookie_profile_id) REFERENCES cookie_profiles(id)
);

CREATE TABLE IF NOT EXISTS generation_tasks (
  id TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL,
  prompt_card_id TEXT NOT NULL,
  position INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  asset_ids_json TEXT NOT NULL,
  media_refs_json TEXT NOT NULL DEFAULT '[]',
  prompt_raw TEXT NOT NULL,
  prompt_compiled TEXT NOT NULL,
  duration_seconds INTEGER NOT NULL,
  output_filename TEXT NOT NULL,
  retry_limit INTEGER NOT NULL DEFAULT 0,
  retry_count INTEGER NOT NULL DEFAULT 0,
  remote_task_id TEXT,
  remote_response_json TEXT,
  error_code TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  submitted_at TEXT,
  FOREIGN KEY(batch_id) REFERENCES batches(id) ON DELETE CASCADE,
  FOREIGN KEY(prompt_card_id) REFERENCES prompt_cards(id)
);
CREATE INDEX IF NOT EXISTS idx_generation_tasks_batch ON generation_tasks(batch_id, position);
CREATE INDEX IF NOT EXISTS idx_generation_tasks_status ON generation_tasks(status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_generation_tasks_remote ON generation_tasks(remote_task_id) WHERE remote_task_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS result_assets (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL UNIQUE,
  video_url TEXT NOT NULL,
  local_path TEXT NOT NULL,
  byte_size INTEGER NOT NULL DEFAULT 0,
  sha256 TEXT,
  metadata_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(task_id) REFERENCES generation_tasks(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS media_cache (
  id TEXT PRIMARY KEY,
  asset_sha256 TEXT NOT NULL,
  cookie_profile_id TEXT NOT NULL,
  provider_key TEXT NOT NULL,
  cdn_url TEXT NOT NULL,
  remote_uri TEXT,
  width INTEGER,
  height INTEGER,
  metadata_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(asset_sha256, cookie_profile_id, provider_key),
  FOREIGN KEY(cookie_profile_id) REFERENCES cookie_profiles(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS event_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  level TEXT NOT NULL,
  stage TEXT NOT NULL,
  entity_type TEXT,
  entity_id TEXT,
  message TEXT NOT NULL,
  payload_json TEXT,
  created_at TEXT NOT NULL
);
`);

function ensureColumn(table, name, ddl) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all().map(column => column.name);
  if (!columns.includes(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${ddl}`);
}

ensureColumn('generation_tasks', 'remote_status', 'TEXT');
ensureColumn('generation_tasks', 'remote_poll_json', 'TEXT');
ensureColumn('generation_tasks', 'poll_count', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('generation_tasks', 'poll_error_count', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('generation_tasks', 'next_poll_at', 'TEXT');
ensureColumn('generation_tasks', 'last_polled_at', 'TEXT');
ensureColumn('generation_tasks', 'video_url', 'TEXT');
ensureColumn('generation_tasks', 'video_urls_json', "TEXT NOT NULL DEFAULT '[]'");
ensureColumn('generation_tasks', 'download_path', 'TEXT');
ensureColumn('generation_tasks', 'download_attempts', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('generation_tasks', 'download_error', 'TEXT');
ensureColumn('generation_tasks', 'downloaded_at', 'TEXT');
ensureColumn('generation_tasks', 'completed_at', 'TEXT');
ensureColumn('generation_tasks', 'result_metadata_json', 'TEXT');
ensureColumn('generation_tasks', 'first_submitted_at', 'TEXT');
ensureColumn('generation_tasks', 'failed_at', 'TEXT');
ensureColumn('prompt_cards', 'active', 'INTEGER NOT NULL DEFAULT 1');
ensureColumn('prompt_cards', 'manual_asset_ids_json', "TEXT NOT NULL DEFAULT '[]'");
ensureColumn('prompt_cards', 'auto_asset_ids_json', "TEXT NOT NULL DEFAULT '[]'");
ensureColumn('prompt_cards', 'generation_count', 'INTEGER NOT NULL DEFAULT 1');
ensureColumn('prompt_cards', 'archived_at', 'TEXT');
ensureColumn('prompt_cards', 'media_refs_json', "TEXT NOT NULL DEFAULT '[]'");
ensureColumn('prompt_cards', 'manual_media_refs_json', "TEXT NOT NULL DEFAULT '[]'");
ensureColumn('prompt_cards', 'auto_media_refs_json', "TEXT NOT NULL DEFAULT '[]'");
ensureColumn('generation_tasks', 'media_refs_json', "TEXT NOT NULL DEFAULT '[]'");

db.exec(`UPDATE prompt_cards
  SET manual_asset_ids_json=asset_ids_json
  WHERE manual_asset_ids_json='[]' AND asset_ids_json<>'[]'`);
db.exec(`UPDATE prompt_cards
  SET manual_media_refs_json=media_refs_json
  WHERE manual_media_refs_json='[]' AND media_refs_json<>'[]'`);
db.exec(`UPDATE generation_tasks
  SET first_submitted_at=submitted_at
  WHERE first_submitted_at IS NULL AND submitted_at IS NOT NULL`);
db.exec(`UPDATE generation_tasks
  SET failed_at=updated_at
  WHERE failed_at IS NULL AND status IN ('submit_failed','remote_failed','download_failed')`);

export function getSetting(key, fallback = null) {
  const row = db.prepare('SELECT value_json FROM settings WHERE key=?').get(key);
  return row ? jsonParse(row.value_json, fallback) : fallback;
}

export function setSetting(key, value) {
  const at = nowIso();
  db.prepare(`INSERT INTO settings(key,value_json,updated_at) VALUES(?,?,?)
    ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json, updated_at=excluded.updated_at`)
    .run(key, jsonStringify(value), at);
  return value;
}

export function logEvent({ level = 'info', stage, entityType = null, entityId = null, message, payload = null }) {
  db.prepare('INSERT INTO event_logs(level,stage,entity_type,entity_id,message,payload_json,created_at) VALUES(?,?,?,?,?,?,?)')
    .run(level, stage, entityType, entityId, message, payload == null ? null : jsonStringify(payload), nowIso());
}

export function listAssets() {
  return db.prepare(`SELECT a.*, f.display_name AS folder_name, f.folder_path
    FROM assets a JOIN asset_folders f ON f.id=a.folder_id
    WHERE a.active=1 AND f.active=1 ORDER BY a.relative_path COLLATE NOCASE`).all();
}

export function listCards() {
  return db.prepare('SELECT * FROM prompt_cards WHERE active=1 ORDER BY position,id').all().map(row => ({
    ...row,
    asset_ids: jsonParse(row.asset_ids_json, []),
    manual_asset_ids: jsonParse(row.manual_asset_ids_json, []),
    auto_asset_ids: jsonParse(row.auto_asset_ids_json, []),
    media_refs: jsonParse(row.media_refs_json, []),
    manual_media_refs: jsonParse(row.manual_media_refs_json, []),
    auto_media_refs: jsonParse(row.auto_media_refs_json, [])
  }));
}

export function ensureInitialCard() {
  const existing = db.prepare('SELECT COUNT(*) AS count FROM prompt_cards WHERE active=1').get().count;
  if (existing) return;
  const total = db.prepare('SELECT COUNT(*) AS count FROM prompt_cards').get().count;
  if (total) return;
  const at = nowIso();
  db.prepare(`INSERT INTO prompt_cards(id,position,title,asset_ids_json,manual_asset_ids_json,auto_asset_ids_json,prompt_raw,duration_seconds,output_filename,retry_limit,generation_count,active,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(uid('card'), 1, '提示词卡 1', '[]', '[]', '[]', '', 15, '', 0, 1, 1, at, at);
}

export function normalizeCardPositions() {
  const cards = db.prepare('SELECT id FROM prompt_cards WHERE active=1 ORDER BY position,id').all();
  const stmt = db.prepare('UPDATE prompt_cards SET position=?, title=?, updated_at=? WHERE id=?');
  const at = nowIso();
  cards.forEach((card, index) => stmt.run(index + 1, `提示词卡 ${index + 1}`, at, card.id));
}

export function publicTask(row) {
  return {
    ...row,
    asset_ids: jsonParse(row.asset_ids_json, []),
    media_refs: jsonParse(row.media_refs_json, []),
    remote_response: jsonParse(row.remote_response_json, null),
    remote_poll: jsonParse(row.remote_poll_json, null),
    video_urls: jsonParse(row.video_urls_json, []),
    result_metadata: jsonParse(row.result_metadata_json, null)
  };
}

export function listTasks(limit = 500) {
  return db.prepare(`SELECT t.*, b.output_directory, b.cookie_profile_id
    FROM generation_tasks t JOIN batches b ON b.id=t.batch_id
    ORDER BY t.created_at DESC, t.position LIMIT ?`).all(Number(limit)).map(publicTask);
}

export function listResults(limit = 500) {
  return db.prepare(`SELECT r.*, t.output_filename, t.duration_seconds, t.prompt_raw, t.prompt_compiled,
      t.remote_task_id, t.asset_ids_json, t.completed_at, b.output_directory
    FROM result_assets r
    JOIN generation_tasks t ON t.id=r.task_id
    JOIN batches b ON b.id=t.batch_id
    ORDER BY r.created_at DESC LIMIT ?`).all(Number(limit)).map(row => ({
      ...row,
      asset_ids: jsonParse(row.asset_ids_json, []),
      metadata: jsonParse(row.metadata_json, null)
    }));
}

export function listCookies() {
  return db.prepare(`SELECT id,name,status,cookie_count,last_error,validated_at,created_at,updated_at
    FROM cookie_profiles ORDER BY created_at DESC`).all();
}

ensureInitialCard();
