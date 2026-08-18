import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, '..');
const packageInfo = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
export const APP_VERSION = String(packageInfo.version || '0.0.0');
export const PUBLIC_DIR = path.join(ROOT, 'public');
export const STORAGE_DIR = process.env.STUDIO_STORAGE_DIR
  ? path.resolve(process.env.STUDIO_STORAGE_DIR)
  : path.join(ROOT, 'storage');
export const DATA_DIR = path.join(STORAGE_DIR, 'data');
export const SECRET_DIR = path.join(STORAGE_DIR, 'secrets');
export const CACHE_DIR = path.join(STORAGE_DIR, 'cache');
export const MEDIA_CLIP_DIR = path.join(CACHE_DIR, 'reference-clips');
export const LOG_DIR = path.join(STORAGE_DIR, 'logs');
export const DB_PATH = process.env.STUDIO_DB_PATH
  ? path.resolve(process.env.STUDIO_DB_PATH)
  : path.join(DATA_DIR, 'studio.db');
export const MASTER_KEY_PATH = path.join(SECRET_DIR, 'master.key');
export const PROVIDER_TEMPLATE_PATH = path.join(ROOT, 'config', 'provider-templates', 'creative_studio_i2v.json');
export const PORT = Number(process.env.PORT || 4174);
export const HOST = process.env.HOST || '127.0.0.1';

for (const dir of [DATA_DIR, SECRET_DIR, CACHE_DIR, MEDIA_CLIP_DIR, LOG_DIR]) {
  fs.mkdirSync(dir, { recursive: true });
}

if (!fs.existsSync(PUBLIC_DIR)) throw new Error(`Public assets missing: ${PUBLIC_DIR}`);
if (!fs.existsSync(PROVIDER_TEMPLATE_PATH)) throw new Error(`Provider template missing: ${PROVIDER_TEMPLATE_PATH}`);
