import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const userData = path.join(os.tmpdir(), 'uvs-046-clean-test');
fs.rmSync(userData, { recursive: true, force: true });
fs.mkdirSync(userData, { recursive: true });
const executable = path.resolve('release-0.4.6/Universal HTTP Video Studio-0.4.6-Portable.exe');
const child = spawn(executable, [], {
  detached: true,
  windowsHide: true,
  stdio: 'ignore',
  env: { ...process.env, STUDIO_USER_DATA_DIR: userData }
});
child.unref();

const runtimePath = path.join(userData, 'app-runtime.json');
let runtime = null;
for (let attempt = 0; attempt < 120; attempt += 1) {
  if (fs.existsSync(runtimePath)) {
    try { runtime = JSON.parse(fs.readFileSync(runtimePath, 'utf8')); break; } catch {}
  }
  await sleep(250);
}
if (!runtime) throw new Error('便携版未生成 app-runtime.json');
const state = await fetch(`http://127.0.0.1:${runtime.port}/api/state`).then(response => response.json());
const diagnostics = await fetch(`http://127.0.0.1:${runtime.port}/api/network/diagnostics`).then(response => response.json());
try { process.kill(runtime.pid); } catch {}
console.log(JSON.stringify({
  version: runtime.version,
  cookies: state.cookies.length,
  tasks: state.tasks.length,
  results: state.results.length,
  cards: state.cards.length,
  submitConcurrency: state.settings.submitConcurrency,
  proxyMode: diagnostics.proxyMode,
  reachable: diagnostics.reachable,
  networkStatus: diagnostics.status || null
}, null, 2));
