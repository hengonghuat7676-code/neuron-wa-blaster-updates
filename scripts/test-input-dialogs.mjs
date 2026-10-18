import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { spawn, execFileSync } from 'node:child_process';
import electron from 'electron';

const renderer = await readFile(new URL('../app/renderer.js', import.meta.url), 'utf8');
assert.doesNotMatch(renderer, /\b(?:confirm|prompt|alert)\s*\(/, 'No blocking native JavaScript dialogs');
const folder = await mkdtemp(path.join(os.tmpdir(), 'neuron-input-test-'));
const server = net.createServer();
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
await new Promise(resolve => server.close(resolve));
const env = { ...process.env, NEURON_USER_DATA_DIR: folder };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(electron, ['.', `--remote-debugging-port=${port}`], { env, stdio: 'ignore', windowsHide: true });
let socket;
try {
  let target;
  for (let i = 0; i < 150; i++) {
    try { target = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find(t => t.type === 'page'); } catch {}
    if (target) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(target, 'Isolated app opened');
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
  let counter = 0;
  const pending = new Map();
  socket.addEventListener('message', event => {
    const m = JSON.parse(event.data);
    if (!pending.has(m.id)) return;
    const p = pending.get(m.id); pending.delete(m.id); clearTimeout(p.timer);
    m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result);
  });
  function command(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++counter;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Timeout: ${method}`)); }, 15000);
      pending.set(id, { resolve, reject, timer });
      socket.send(JSON.stringify({ id, method, params }));
    });
  }
  async function evaluate(expression) {
    const r = await command('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  }
  await evaluate(`(async()=>{for(let i=0;i<200;i++){if(typeof askAction==='function'&&document.readyState==='complete'&&licenseState.status!=='checking')break;await new Promise(r=>setTimeout(r,50));}if(licenseState.status==='checking')throw new Error('Initialization not complete');clearTimeout(updateCheckTimer);licenseState.valid=true;state=structuredClone(initial);accounts=[{id:'qa',name:'QA',phone:'60000000000',status:'connected'}];state.campaigns=[{id:'qa-campaign',name:'QA Campaign',status:'ready',config:defaultConfig()}];renderAll();go('contacts');})()`);
  const fields = await evaluate(`[...document.querySelectorAll('input[id],textarea[id]')].filter(e=>['text','number','textarea'].includes(e.type)&&!e.readOnly&&!['licenseKeyInput','actionInput'].includes(e.id)).map(e=>({id:e.id,type:e.type,page:e.closest('.page')?.id.replace('page-',''),dialog:e.closest('dialog')?.id}))`);
  for (const phase of ['baseline', 'after-confirm', 'after-qr', 'after-account-updates']) {
    if (phase === 'after-confirm') {
      await evaluate(`void askAction('QA confirmation')`);
      assert.equal(await evaluate(`document.querySelector('#actionDialog').open`), true);
      assert.equal(await evaluate(`getComputedStyle(document.querySelector('#actionInputLabel')).display`), 'none');
      await evaluate(`document.querySelector('#actionAccept').click()`);
    }
    if (phase === 'after-qr') {
      await evaluate(`showQr(accounts[0]);document.querySelector('#qrDialog [data-close]').click()`);
      await new Promise(r => setTimeout(r, 50));
      assert.equal(await evaluate('qrAccountId'), null);
    }
    if (phase === 'after-account-updates') await evaluate(`for(let i=0;i<30;i++)upsertAccount({...accounts[0],status:['connecting','connected'][i%2]})`);
    for (const f of fields) {
      await evaluate(`(()=>{document.activeElement?.blur();document.querySelectorAll('dialog[open]').forEach(d=>d.close());${f.page ? `go(${JSON.stringify(f.page)});` : ''}${f.dialog ? `document.getElementById(${JSON.stringify(f.dialog)}).showModal();` : ''}if(${JSON.stringify(f.page)}==='sending'){document.querySelector('#messageType').value='cta';updateComposer();}const el=document.getElementById(${JSON.stringify(f.id)});el.focus();el.value='';})()`);
      const text = f.type === 'number' ? '12' : 'QA typing';
      await command('Input.insertText', { text });
      assert.equal(await evaluate(`document.getElementById(${JSON.stringify(f.id)}).value`), text, `${phase}: ${f.id} accepts typing`);
    }
    await evaluate(`document.activeElement?.blur();document.querySelectorAll('dialog[open]').forEach(d=>d.close())`);
  }
  await evaluate(`window.qaRenameResult=null;askAction('Rename QA', 'Old name').then(value=>window.qaRenameResult=value);void 0`);
  assert.notEqual(await evaluate(`getComputedStyle(document.querySelector('#actionInputLabel')).display`), 'none');
  await command('Input.insertText', { text: 'New name' });
  await evaluate(`document.querySelector('#actionAccept').click()`);
  await new Promise(r => setTimeout(r, 50));
  assert.equal(await evaluate('window.qaRenameResult'), 'New name', 'Rename form returns edited name');
  for (const f of fields.filter(f => f.page === 'warming' && f.type === 'number')) {
    await evaluate(`(()=>{document.activeElement?.blur();go('warming');const el=document.getElementById(${JSON.stringify(f.id)});el.focus();el.value='';})()`);
    await command('Input.insertText', { text: '73' });
    await evaluate('renderAll()');
    assert.equal(await evaluate(`document.getElementById(${JSON.stringify(f.id)}).value`), '73', `${f.id} retains live draft`);
  }
  // Exercise the real async delete handler against synthetic local data only.
  await evaluate(`document.activeElement?.blur();go('queue');document.querySelector('[data-campaign-action="delete"]').click()`);
  assert.equal(await evaluate(`document.querySelector('#actionDialog').open`), true);
  await evaluate(`document.querySelector('#actionDialog').close('cancel')`);
  await new Promise(r => setTimeout(r, 50));
  assert.equal(await evaluate('state.campaigns.length'), 1, 'Cancel preserves campaign');
  await evaluate(`document.querySelector('[data-campaign-action="delete"]').click();document.querySelector('#actionDialog').close('ok')`);
  await new Promise(r => setTimeout(r, 50));
  assert.equal(await evaluate('state.campaigns.length'), 0, 'Confirm deletes fixture campaign');
  await evaluate(`go('contacts');document.querySelector('#bulkContacts').focus();document.querySelector('#bulkContacts').value=''`);
  await command('Input.insertText', { text: 'after delete' });
  assert.equal(await evaluate(`document.querySelector('#bulkContacts').value`), 'after delete');
  // Escape must cancel custom confirmation and clear the QR tracking state.
  await evaluate(`void askAction('Cancel with Escape')`);
  await command('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await command('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await new Promise(r => setTimeout(r, 50));
  assert.equal(await evaluate(`document.querySelector('#actionDialog').open`), false);
  await evaluate(`showQr(accounts[0])`);
  await command('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await command('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await new Promise(r => setTimeout(r, 50));
  assert.equal(await evaluate('qrAccountId'), null);
  console.log(`PASS input/dialog regression: ${fields.length} fields x 4 phases, 8 Warming drafts, real async delete/cancel, QR close and Escape. CDP input, not a physical-keyboard certification.`);
} finally {
  socket?.close();
  try { execFileSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); } catch {}
  await rm(folder, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
}
