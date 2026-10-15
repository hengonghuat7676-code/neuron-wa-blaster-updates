const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn, execFileSync } = require('node:child_process');
const assert = require('node:assert/strict');
const version = require('../package.json').version;

(async () => {
  const executable = path.resolve(process.argv[2] || `release-assets/v${version}/Neuron-WA-Blaster-${version}.exe`);
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'neuron-portable-smoke-'));
  const net = require('node:net');
  const listener = net.createServer();
  await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  const environment = { ...process.env, NEURON_USER_DATA_DIR: folder };
  delete environment.ELECTRON_RUN_AS_NODE;
  delete environment.ELECTRON_NO_ASAR;
  const child = spawn(executable, [`--remote-debugging-port=${port}`], {
    windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: environment
  });
  let diagnostics = '';
  child.stdout.on('data', chunk => { diagnostics = (diagnostics + chunk).slice(-6000); });
  child.stderr.on('data', chunk => { diagnostics = (diagnostics + chunk).slice(-6000); });
  let launchError;
  child.on('error', error => { launchError = error; });
  let socket;
  try {
    let target;
    for (let attempt = 0; attempt < 45; attempt++) {
      try {
        const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
        target = targets.find(item => item.type === 'page' && item.title === 'Neuron WA Blaster');
        if (target) break;
      } catch {}
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    assert.ok(target, `Portable application must start a renderer. Exit=${child.exitCode}; ${launchError || ''}; ${diagnostics}`);
    socket = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
    const result = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Renderer inspection timed out')), 15000);
      socket.addEventListener('message', event => {
        const data = JSON.parse(event.data);
        if (data.id !== 1) return;
        clearTimeout(timer);
        if (data.result?.exceptionDetails || data.error) reject(new Error(JSON.stringify(data)));
        else resolve(data.result.result.value);
      });
      socket.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: {
        expression: `(async()=>{const version=${JSON.stringify(version)};for(let attempt=0;attempt<100;attempt+=1){const brand=document.querySelector('.brand')?.innerText||'';const installed=document.querySelector('#installedVersion')?.textContent||'';const about=document.querySelector('#aboutVersion')?.textContent||'';if(brand.includes('WA BLASTER '+version)&&installed===version&&about==='Version '+version)return {brand,installed,about,checkButton:!!document.querySelector('#checkUpdates'),bridge:typeof window.neuron.installUpdate};await new Promise(resolve=>setTimeout(resolve,100));}return {brand:document.querySelector('.brand')?.innerText||'',installed:document.querySelector('#installedVersion')?.textContent||'',about:document.querySelector('#aboutVersion')?.textContent||'',checkButton:!!document.querySelector('#checkUpdates'),bridge:typeof window.neuron.installUpdate};})()`, returnByValue: true, awaitPromise: true
      } }));
    });
    assert.ok(result.brand.includes(version), 'Packaged UI version must match package.json');
    assert.equal(result.installed, version);
    assert.equal(result.about, `Version ${version}`);
    assert.equal(result.checkButton, true);
    assert.equal(result.bridge, 'function');
    console.log(`PASS: portable ${version} starts with isolated data, update UI and IPC bridge`);
  } finally {
    socket?.close();
    if (child.pid) {
      try { execFileSync(path.join(process.env.SystemRoot, 'System32/taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); } catch {}
    }
    // Chromium may release its data handles after the launcher exits.
    await new Promise(resolve => setTimeout(resolve, 1000));
    fs.rmSync(folder, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
