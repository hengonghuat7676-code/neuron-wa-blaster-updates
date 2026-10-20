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
    try { target = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find(t => t.type === 'page' && t.url?.startsWith('file:') && t.url.endsWith('/app/index.html')); } catch {}
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
  // Poll from Node, not inside the initial page context: Electron can still
  // replace about:blank after its target URL has changed to index.html.
  let ready = false;
  for (let attempt = 0; attempt < 200; attempt++) {
    try {
      ready = await evaluate(`document.readyState==='complete' && typeof askAction==='function' && typeof licenseState!=='undefined' && licenseState.status!=='checking'`);
    } catch (error) {
      if (!/Execution context was destroyed|Cannot find context|Cannot access .* before initialization/.test(error.message)) throw error;
    }
    if (ready) break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.ok(ready, 'Renderer initialization complete before fixtures and input tests');
  await evaluate(`(()=>{clearTimeout(updateCheckTimer);licenseState.valid=true;state=structuredClone(initial);accounts=[{id:'qa',name:'QA',phone:'60000000000',status:'connected'}];state.campaigns=[{id:'qa-campaign',name:'QA Campaign',status:'ready',config:defaultConfig()}];renderAll();go('contacts');})()`);
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
  // Contacts pagination/export use only synthetic data in this isolated profile.
  await evaluate(`(()=>{go('contacts');document.querySelector('#contactSearch').value='';document.querySelector('#contactView').value='available';contactPage=1;state.contacts=Array.from({length:3712},(_,i)=>({id:'page-'+i,name:'Contact '+i,phone:String(65000000000+i),campaignId:null,selected:false,deliveryStatus:'available'}));renderContacts();})()`);
  const pageSnapshot = () => evaluate(`({page:contactPage,rows:document.querySelectorAll('#contactsBody tr').length,first:document.querySelector('.contact-check')?.dataset.id,last:[...document.querySelectorAll('.contact-check')].at(-1)?.dataset.id,previousDisabled:document.querySelector('#contactsPrevious').disabled,nextDisabled:document.querySelector('#contactsNext').disabled,info:document.querySelector('#contactPageInfo').textContent})`);
  let page = await pageSnapshot();
  assert.equal(page.rows, 1000); assert.equal(page.first, 'page-0'); assert.equal(page.previousDisabled, true);
  await evaluate(`document.querySelector('.contact-check').click();document.querySelector('#contactsNext').click()`);
  page = await pageSnapshot();
  assert.equal(page.page, 2); assert.equal(page.first, 'page-1000'); assert.equal(page.last, 'page-1999');
  await evaluate(`document.querySelector('#selectAll').click();document.querySelector('#contactsPrevious').click()`);
  assert.equal(await evaluate(`state.contacts.filter(c=>c.selected).length`), 1001, 'Select All applies only to current page and retains earlier selection');
  assert.equal(await evaluate(`document.querySelector('.contact-check').checked`), true);
  await evaluate(`document.querySelector('#contactsNext').click();document.querySelector('#contactsNext').click()`);
  page = await pageSnapshot(); assert.equal(page.first, 'page-2000'); assert.equal(page.rows, 1000);
  await evaluate(`document.querySelector('#contactsNext').click()`);
  page = await pageSnapshot();
  assert.equal(page.rows, 712); assert.equal(page.first, 'page-3000'); assert.equal(page.last, 'page-3711'); assert.equal(page.nextDisabled, true);
  assert.match(page.info, /Page 4 of 4/);
  await evaluate(`state.contacts=state.contacts.slice(0,1001);renderContacts()`);
  page = await pageSnapshot(); assert.equal(page.page, 2); assert.equal(page.rows, 1);
  await evaluate(`document.querySelector('#contactSearch').value='no match';document.querySelector('#contactSearch').dispatchEvent(new Event('input'))`);
  page = await pageSnapshot(); assert.equal(page.page, 1); assert.equal(page.rows, 0); assert.equal(page.nextDisabled, true); assert.equal(page.previousDisabled, true);
  await evaluate(`document.querySelector('#contactSearch').value='';document.querySelector('#contactSearch').dispatchEvent(new Event('input'));document.querySelector('#batchQuantity').value='1001';document.querySelector('#selectBatch').click()`);
  assert.equal(await evaluate(`state.contacts.filter(c=>c.selected).length`), 1001, 'Batch selection remains cross-page');
  await evaluate(`(()=>{state.contacts=Array.from({length:5000},(_,i)=>({id:'export-'+i,name:'Export '+i,phone:String(65000000000+i),campaignId:i>=4000?'assigned':null,selected:i===0,deliveryStatus:i>=4000?'waiting':'available'}));contactPage=4;renderContacts();document.querySelector('#contactSearch').value='Export 0';document.querySelector('#contactSearch').dispatchEvent(new Event('input'));})()`);
  // Capture the actual download Blob without writing into any user Downloads folder.
  const exported = await evaluate(`(async()=>{const original=HTMLAnchorElement.prototype.click;const originalUrl=URL.createObjectURL;let captured,blob;const before=JSON.stringify(state.contacts);URL.createObjectURL=function(value){blob=value;return originalUrl.call(URL,value);};HTMLAnchorElement.prototype.click=function(){captured={url:this.href,name:this.download};};try{document.querySelector('#exportContacts').click();const text=await blob.text();const expected=state.contacts.map(c=>c.phone).join('\\r\\n')+'\\r\\n';return {name:captured.name,count:text.trimEnd().split('\\r\\n').length,exact:text===expected,unchanged:before===JSON.stringify(state.contacts),visible:document.querySelectorAll('#contactsBody tr').length};}finally{HTMLAnchorElement.prototype.click=original;URL.createObjectURL=originalUrl;}})()`);
  assert.equal(exported.name, 'neuron-wa-contacts.txt'); assert.equal(exported.count, 5000); assert.equal(exported.exact, true); assert.equal(exported.unchanged, true); assert.equal(exported.visible, 1);
  await evaluate(`state.contacts=[];renderContacts()`);
  assert.equal(await evaluate(`document.querySelector('#exportContacts').disabled`), true);
  await command('Emulation.setDeviceMetricsOverride', { width: 1120, height: 768, deviceScaleFactor: 1, mobile: false });
  const exportLayout = await evaluate(`(()=>{const r=document.querySelector('#exportContacts').getBoundingClientRect();return {left:r.left,right:r.right,width:innerWidth};})()`);
  assert.ok(exportLayout.left >= 0 && exportLayout.right <= exportLayout.width, 'Export button fits minimum supported viewport');
  console.log('PASS Contacts: 3712 rows across four pages, boundary clamping, search reset, selection retention/page scope, cross-page batch, and exact 5000-number TXT export including assigned/hidden contacts without mutation');
  console.log(`PASS input/dialog regression: ${fields.length} fields x 4 phases, 8 Warming drafts, real async delete/cancel, QR close and Escape. CDP input, not a physical-keyboard certification.`);
} finally {
  socket?.close();
  try { execFileSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); } catch {}
  await rm(folder, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
}
