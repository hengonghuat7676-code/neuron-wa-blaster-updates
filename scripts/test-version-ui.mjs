import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn, execFileSync } from 'node:child_process';

const version = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')).version;
const folder = await mkdtemp(path.join(os.tmpdir(), 'neuron-version-ui-'));
const env = { ...process.env, NEURON_USER_DATA_DIR: folder };
delete env.ELECTRON_RUN_AS_NODE;
const port = 19366;
const child = spawn(path.resolve('dist/win-unpacked/Neuron WA Blaster.exe'), [`--remote-debugging-port=${port}`], { env, stdio: 'ignore', windowsHide: true });
let socket;
try {
  let target;
  for (let attempt = 0; attempt < 100; attempt++) {
    try { target = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find(item => item.type === 'page'); } catch {}
    if (target) break;
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  assert.ok(target, 'Packaged app must open');
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
  const result = await new Promise((resolve, reject) => {
    socket.addEventListener('message', event => { const value = JSON.parse(event.data); if (value.id === 1) value.error ? reject(new Error(value.error.message)) : resolve(value.result); });
    socket.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: {
      expression: `(async()=>{for(let i=0;i<100;i++){const labels=[...document.querySelectorAll('[data-app-version]')].map(el=>el.textContent);if(labels.length===3&&!labels.some(v=>v.includes('…')))return {version:await window.neuron.getAppVersion(),labels};await new Promise(r=>setTimeout(r,100));}throw new Error('Version labels did not load')})()`,
      awaitPromise: true, returnByValue: true
    } }));
  });
  assert.equal(result.exceptionDetails, undefined);
  assert.deepEqual(result.result.value, { version, labels: [`WA BLASTER ${version}`, version, `Version ${version}`] });
  console.log(`PASS: packaged sidebar, Settings and About all display actual version ${version}`);
} finally {
  socket?.close();
  try { execFileSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); } catch {}
  await rm(folder, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
}
