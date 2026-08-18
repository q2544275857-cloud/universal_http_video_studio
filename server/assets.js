import fs from 'node:fs';
import path from 'node:path';
import { db, listAssets, logEvent } from './db.js';
import { nowIso, safeAlias, sha256File, uid } from './utils.js';

const IMAGE_EXTENSIONS = new Map([
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.webp', 'image/webp']
]);

function walkImages(root) {
  const out = [];
  const stack = [root];
  while (stack.length) {
    const current = stack.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans'));
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile() && IMAGE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) out.push(full);
    }
  }
  return out.sort((a, b) => a.localeCompare(b, 'zh-Hans'));
}

function imageDimensions(filePath) {
  try {
    const buffer = fs.readFileSync(filePath);
    const ext = path.extname(filePath).toLowerCase();
    if (ext === '.png' && buffer.length >= 24 && buffer.toString('ascii', 1, 4) === 'PNG') {
      return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
    }
    if ((ext === '.jpg' || ext === '.jpeg') && buffer[0] === 0xff && buffer[1] === 0xd8) {
      let offset = 2;
      while (offset + 9 < buffer.length) {
        if (buffer[offset] !== 0xff) { offset += 1; continue; }
        const marker = buffer[offset + 1];
        const length = buffer.readUInt16BE(offset + 2);
        if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
          return { height: buffer.readUInt16BE(offset + 5), width: buffer.readUInt16BE(offset + 7) };
        }
        if (!length) break;
        offset += length + 2;
      }
    }
    if (ext === '.webp' && buffer.length >= 30 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') {
      const chunk = buffer.toString('ascii', 12, 16);
      if (chunk === 'VP8X') {
        return {
          width: 1 + buffer.readUIntLE(24, 3),
          height: 1 + buffer.readUIntLE(27, 3)
        };
      }
    }
  } catch {}
  return { width: 0, height: 0 };
}

function uniqueAlias(base, used) {
  let alias = safeAlias(base, 'image');
  let counter = 2;
  while (used.has(alias.toLowerCase())) alias = `${safeAlias(base, 'image')}_${counter++}`;
  used.add(alias.toLowerCase());
  return alias;
}

export function scanAssetFolder(folderPath, { force = false } = {}) {
  const resolved = path.resolve(String(folderPath || ''));
  if (!resolved || !fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
    throw Object.assign(new Error('图片文件夹不存在。'), { statusCode: 422 });
  }

  const referenced = db.prepare(`SELECT COUNT(*) AS count FROM prompt_cards pc, json_each(pc.asset_ids_json) j
    JOIN assets a ON a.id=j.value WHERE a.active=1`).get().count;
  const activeFolder = db.prepare('SELECT * FROM asset_folders WHERE active=1 LIMIT 1').get();
  if (activeFolder && path.resolve(activeFolder.folder_path).toLowerCase() !== resolved.toLowerCase() && referenced > 0 && !force) {
    throw Object.assign(new Error('当前素材库仍被提示词卡引用。'), {
      statusCode: 409,
      code: 'ASSET_FOLDER_REPLACE_REQUIRES_CONFIRM',
      details: { referenced }
    });
  }

  const files = walkImages(resolved);
  if (!files.length) throw Object.assign(new Error('该文件夹中未找到支持的图片。'), { statusCode: 422 });
  const at = nowIso();
  const folderId = uid('folder');
  const usedAliases = new Set();

  db.exec('BEGIN IMMEDIATE');
  try {
    if (activeFolder && path.resolve(activeFolder.folder_path).toLowerCase() !== resolved.toLowerCase()) {
      db.prepare('UPDATE asset_folders SET active=0,updated_at=? WHERE active=1').run(at);
      db.prepare('UPDATE assets SET active=0,updated_at=? WHERE active=1').run(at);
      db.prepare(`UPDATE prompt_cards SET asset_ids_json='[]',updated_at=?`).run(at);
    }

    let folder = db.prepare('SELECT * FROM asset_folders WHERE folder_path=?').get(resolved);
    if (!folder) {
      db.prepare(`INSERT INTO asset_folders(id,folder_path,display_name,recursive,active,scanned_at,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?)`).run(folderId, resolved, path.basename(resolved), 1, 1, at, at, at);
      folder = { id: folderId };
    } else {
      db.prepare('UPDATE asset_folders SET active=1,scanned_at=?,updated_at=? WHERE id=?').run(at, at, folder.id);
      db.prepare('UPDATE assets SET active=0,updated_at=? WHERE folder_id=?').run(at, folder.id);
    }

    const existingByPath = new Map(db.prepare('SELECT * FROM assets WHERE folder_id=?').all(folder.id).map(row => [row.relative_path.toLowerCase(), row]));
    const insert = db.prepare(`INSERT INTO assets(id,folder_id,absolute_path,relative_path,file_name,alias,mime_type,byte_size,width,height,sha256,active,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    const update = db.prepare(`UPDATE assets SET absolute_path=?,file_name=?,alias=?,mime_type=?,byte_size=?,width=?,height=?,sha256=?,active=1,updated_at=? WHERE id=?`);

    for (const file of files) {
      const relative = path.relative(resolved, file).replace(/\\/g, '/');
      const stat = fs.statSync(file);
      const dimensions = imageDimensions(file);
      const existing = existingByPath.get(relative.toLowerCase());
      const alias = uniqueAlias(existing?.alias || path.basename(file, path.extname(file)), usedAliases);
      const mime = IMAGE_EXTENSIONS.get(path.extname(file).toLowerCase());
      const hash = sha256File(file);
      if (existing) {
        update.run(file, path.basename(file), alias, mime, stat.size, dimensions.width, dimensions.height, hash, at, existing.id);
      } else {
        insert.run(uid('asset'), folder.id, file, relative, path.basename(file), alias, mime, stat.size, dimensions.width, dimensions.height, hash, 1, at, at);
      }
    }

    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }

  logEvent({ stage: 'asset_folder_scanned', entityType: 'folder', entityId: folderId, message: 'Asset folder scanned', payload: { folderPath: resolved, count: files.length } });
  return { folderPath: resolved, count: files.length, assets: listAssets() };
}

export function updateAssetAlias(id, alias) {
  const row = db.prepare('SELECT * FROM assets WHERE id=? AND active=1').get(id);
  if (!row) throw Object.assign(new Error('素材不存在。'), { statusCode: 404 });
  const normalized = safeAlias(alias, row.alias);
  const duplicate = db.prepare('SELECT id FROM assets WHERE active=1 AND lower(alias)=lower(?) AND id<>?').get(normalized, id);
  if (duplicate) throw Object.assign(new Error('素材别名已存在。'), { statusCode: 409 });
  db.prepare('UPDATE assets SET alias=?,updated_at=? WHERE id=?').run(normalized, nowIso(), id);
  return db.prepare('SELECT * FROM assets WHERE id=?').get(id);
}

export function removeAssetFromLibrary(id) {
  const refs = db.prepare(`SELECT COUNT(*) AS count FROM prompt_cards pc, json_each(pc.asset_ids_json) j WHERE j.value=?`).get(id).count;
  if (refs > 0) throw Object.assign(new Error(`该素材被 ${refs} 张提示词卡引用。`), { statusCode: 409 });
  db.prepare('UPDATE assets SET active=0,updated_at=? WHERE id=?').run(nowIso(), id);
}

export function activeAssetFolder() {
  return db.prepare('SELECT * FROM asset_folders WHERE active=1 ORDER BY scanned_at DESC LIMIT 1').get() || null;
}

export { listAssets };
