import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

function powershellUtf8String(value) {
  const encoded = Buffer.from(String(value ?? ''), 'utf8').toString('base64');
  return `[System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${encoded}'))`;
}

export function buildFolderDialogScript({ description = '选择文件夹', initialPath = '' } = {}) {
  const title = powershellUtf8String(description);
  const filter = powershellUtf8String('文件夹|*.folder');
  const placeholder = powershellUtf8String('选择当前文件夹');
  const initial = initialPath ? powershellUtf8String(initialPath) : '';
  return [
    '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
    'Add-Type -AssemblyName System.Windows.Forms',
    '$dialog = New-Object System.Windows.Forms.OpenFileDialog',
    `$dialog.Title = ${title}`,
    `$dialog.Filter = ${filter}`,
    '$dialog.CheckFileExists = $false',
    '$dialog.CheckPathExists = $true',
    '$dialog.ValidateNames = $false',
    '$dialog.Multiselect = $false',
    '$dialog.DereferenceLinks = $true',
    `$dialog.FileName = ${placeholder}`,
    initial ? `$initialPath = ${initial}; if (Test-Path -LiteralPath $initialPath) { $dialog.InitialDirectory = $initialPath }` : '',
    'if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {',
    '  $selected = [System.IO.Path]::GetDirectoryName($dialog.FileName)',
    '  if ($selected) { Write-Output $selected }',
    '}'
  ].filter(Boolean).join('; ');
}

export function selectFolder(options = {}) {
  const script = buildFolderDialogScript(options);
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-STA', '-Command', script], { windowsHide: false });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', chunk => { stderr += chunk.toString('utf8'); });
    child.on('error', reject);
    child.on('close', code => {
      if (code !== 0) return reject(new Error(stderr.trim() || `Folder dialog exited with code ${code}`));
      resolve(stdout.trim());
    });
  });
}

export function selectMediaFiles({ title = '选择音视频参考文件', initialPath = '', mediaType = 'all' } = {}) {
  const dialogTitle = powershellUtf8String(title);
  const filterText = mediaType === 'video'
    ? '视频文件|*.mp4;*.mov;*.webm;*.mkv;*.m4v|所有文件|*.*'
    : mediaType === 'audio'
      ? '音频文件|*.mp3;*.wav;*.m4a;*.aac;*.ogg;*.flac|所有文件|*.*'
      : '音视频文件|*.mp4;*.mov;*.webm;*.mkv;*.m4v;*.mp3;*.wav;*.m4a;*.aac;*.ogg;*.flac|视频文件|*.mp4;*.mov;*.webm;*.mkv;*.m4v|音频文件|*.mp3;*.wav;*.m4a;*.aac;*.ogg;*.flac|所有文件|*.*';
  const filter = powershellUtf8String(filterText);
  const initial = initialPath ? powershellUtf8String(initialPath) : '';
  const script = [
    '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
    'Add-Type -AssemblyName System.Windows.Forms',
    '$dialog = New-Object System.Windows.Forms.OpenFileDialog',
    `$dialog.Title = ${dialogTitle}`,
    `$dialog.Filter = ${filter}`,
    '$dialog.CheckFileExists = $true',
    '$dialog.CheckPathExists = $true',
    '$dialog.Multiselect = $true',
    '$dialog.DereferenceLinks = $true',
    initial ? `$initialPath = ${initial}; if (Test-Path -LiteralPath $initialPath) { $dialog.InitialDirectory = $initialPath }` : '',
    'if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {',
    '  $dialog.FileNames | ForEach-Object { Write-Output $_ }',
    '}'
  ].filter(Boolean).join('; ');
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-STA', '-Command', script], { windowsHide: false });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', chunk => { stderr += chunk.toString('utf8'); });
    child.on('error', reject);
    child.on('close', code => {
      if (code !== 0) return reject(new Error(stderr.trim() || `Media dialog exited with code ${code}`));
      resolve(stdout.split(/\r?\n/).map(line => line.trim()).filter(Boolean));
    });
  });
}

export function openInExplorer(targetPath) {
  const resolved = path.resolve(String(targetPath || ''));
  if (!fs.existsSync(resolved)) throw Object.assign(new Error('本地文件或目录不存在。'), { statusCode: 404 });
  const args = fs.statSync(resolved).isFile() ? [`/select,${resolved}`] : [resolved];
  const child = spawn('explorer.exe', args, { windowsHide: false, detached: true, stdio: 'ignore' });
  child.unref();
  return resolved;
}
