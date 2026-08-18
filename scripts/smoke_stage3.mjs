import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { summarizeRemoteTask } from '../server/provider/creativeStudioI2V.js';
import { downloadCandidates, isExistingVideo } from '../server/downloadService.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outputDir = path.join(root, 'storage', 'cache', 'stage3-smoke');
fs.rmSync(outputDir, { recursive: true, force: true });
fs.mkdirSync(outputDir, { recursive: true });

const ftyp = Buffer.from([
  0x00,0x00,0x00,0x18, 0x66,0x74,0x79,0x70, 0x69,0x73,0x6f,0x6d,
  0x00,0x00,0x02,0x00, 0x69,0x73,0x6f,0x6d, 0x69,0x73,0x6f,0x32
]);
const fakeVideo = Buffer.concat([ftyp, Buffer.alloc(4096, 0)]);
const server = http.createServer((req, res) => {
  if (req.url === '/video.mp4') {
    res.writeHead(200, { 'content-type': 'video/mp4', 'content-length': fakeVideo.length });
    res.end(fakeVideo);
    return;
  }
  res.writeHead(404); res.end();
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
const videoUrl = `http://127.0.0.1:${port}/video.mp4`;

try {
  const summary = summarizeRemoteTask({
    taskId: 'stage3_task_001',
    renderTaskStatus: 2,
    exported: true,
    previewLink: videoUrl,
    settings: JSON.stringify({ duration: 15 })
  });
  if (!summary.ready || summary.videoUrls[0] !== videoUrl) throw new Error('Remote summary did not detect video URL.');

  const downloaded = await downloadCandidates({
    urls: summary.videoUrls,
    outputDirectory: outputDir,
    filename: 'stage3_smoke_video'
  });
  if (!isExistingVideo(downloaded.localPath)) throw new Error('Downloaded video verification failed.');
  if (downloaded.byteSize !== fakeVideo.length) throw new Error('Downloaded byte size mismatch.');

  console.log(JSON.stringify({
    ok: true,
    remoteStatus: summary.status,
    videoUrl: downloaded.url,
    localPath: downloaded.localPath,
    byteSize: downloaded.byteSize,
    sha256: downloaded.sha256
  }, null, 2));
} finally {
  await new Promise(resolve => server.close(resolve));
  fs.rmSync(outputDir, { recursive: true, force: true });
}
