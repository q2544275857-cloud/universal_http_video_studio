import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { buildFolderDialogScript } from '../server/windowsDialog.js';

const script = buildFolderDialogScript({
  description: '选择图片素材文件夹',
  initialPath: 'D:\\seedance 2.0'
});

assert.match(script, /System\.Windows\.Forms\.OpenFileDialog/);
assert.doesNotMatch(script, /FolderBrowserDialog/);
assert.match(script, /CheckFileExists = \$false/);
assert.match(script, /ValidateNames = \$false/);
assert.match(script, /GetDirectoryName/);

const parsed = spawnSync('powershell.exe', [
  '-NoProfile',
  '-Command',
  '$text=[Console]::In.ReadToEnd(); [scriptblock]::Create($text) | Out-Null'
], {
  input: script,
  encoding: 'utf8',
  windowsHide: true
});

assert.equal(parsed.status, 0, parsed.stderr || parsed.stdout || 'PowerShell parse failed');
console.log(JSON.stringify({
  ok: true,
  dialog: 'OpenFileDialog',
  explorerStyle: true,
  initialPathSupported: true
}, null, 2));
