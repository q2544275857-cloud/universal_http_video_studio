import crypto from 'node:crypto';
import fs from 'node:fs';
import { MASTER_KEY_PATH } from './config.js';

function getMasterKey() {
  if (fs.existsSync(MASTER_KEY_PATH)) {
    const key = fs.readFileSync(MASTER_KEY_PATH);
    if (key.length !== 32) throw new Error('Invalid local master key.');
    return key;
  }
  const key = crypto.randomBytes(32);
  fs.writeFileSync(MASTER_KEY_PATH, key, { mode: 0o600, flag: 'wx' });
  return key;
}

export function encryptSecret(plaintext) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', getMasterKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([Buffer.from([1]), iv, tag, ciphertext]).toString('base64');
}

export function decryptSecret(payload) {
  const buffer = Buffer.from(String(payload || ''), 'base64');
  if (buffer.length < 30 || buffer[0] !== 1) throw new Error('Invalid encrypted secret payload.');
  const iv = buffer.subarray(1, 13);
  const tag = buffer.subarray(13, 29);
  const ciphertext = buffer.subarray(29);
  const decipher = crypto.createDecipheriv('aes-256-gcm', getMasterKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}
