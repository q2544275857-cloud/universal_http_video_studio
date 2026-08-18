import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export function nowIso() {
  return new Date().toISOString();
}

export function uid(prefix = 'id') {
  return `${prefix}_${crypto.randomUUID()}`;
}

export function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(filePath, 'r');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    let bytesRead = 0;
    do {
      bytesRead = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (bytesRead > 0) hash.update(buffer.subarray(0, bytesRead));
    } while (bytesRead > 0);
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

export function sha256Hex(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

export function md5Hex(value) {
  return crypto.createHash('md5').update(value).digest('hex');
}

export function safeAlias(value, fallback = 'image') {
  const base = String(value || fallback).replace(/\.[^.]+$/, '');
  return base
    .trim()
    .replace(/\s+/g, '_')
    .replace(/[@\\/:*?"<>|，。,.!?；;：:]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 64) || fallback;
}

export function safeFilename(value, fallback = 'video') {
  const base = String(value || fallback)
    .replace(/\.mp4$/i, '')
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 120);
  return base || fallback;
}

export function jsonParse(value, fallback = null) {
  if (value == null || value === '') return fallback;
  try {
    return typeof value === 'string' ? JSON.parse(value) : value;
  } catch {
    return fallback;
  }
}

export function jsonStringify(value) {
  return JSON.stringify(value ?? null);
}

export function ensureWithinRoot(root, candidate) {
  const rootPath = path.resolve(root);
  const target = path.resolve(candidate);
  const relative = path.relative(rootPath, target);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('Path is outside the allowed root.');
  }
  return target;
}

export function readRequestBody(req, maxBytes = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(Object.assign(new Error('Request body too large.'), { statusCode: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text) return resolve({});
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(Object.assign(new Error('Invalid JSON body.'), { statusCode: 400 }));
      }
    });
    req.on('error', reject);
  });
}

export function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
