import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const renderer = await readFile(new URL('../app/renderer.js', import.meta.url), 'utf8');
const main = await readFile(new URL('../app/main.mjs', import.meta.url), 'utf8');
const elements = new Map();
let popups = 0;
const $ = selector => {
  if (!elements.has(selector)) {
    const classes = new Set();
    elements.set(selector, {
      open: false, disabled: false, textContent: '', innerHTML: '',
      classList: { add: v => classes.add(v), remove: v => classes.delete(v), contains: v => classes.has(v), toggle(v, yes) { yes ? classes.add(v) : classes.delete(v); } },
      showModal() { this.open = true; popups++; }, close() { this.open = false; }
    });
  }
  return elements.get(selector);
};
let info = { available: true, currentVersion: '3.4.4', latestVersion: '3.4.5', size: 100, notes: 'Test' };
let downloads = 0;
const timers = [];
const toasts = [];
const state = { campaigns: [], warming: { status: 'ready' }, numberFilter: { status: 'ready' } };
const context = vm.createContext({
  $, state, campaignCounts: () => ({ remaining: 1 }),
  escapeHtml: String, formatBytes: String, errorMessage: e => e.message,
  toast: value => toasts.push(value), setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
  window: { neuron: { setUpdateBusy: async () => {}, checkForUpdates: async () => info, downloadUpdate: async () => { downloads++; }, installUpdate: async () => { throw new Error('Installation must not run in notification tests'); } } }
});
vm.runInContext('let availableUpdate=null, updateAfterProcess=false, updateDownloading=false, updateCheckTimer=null, updateCheckInFlight=false, lastUpdateBusy=null;', context);
vm.runInContext(renderer.slice(renderer.indexOf('function hasRunningProcess()'), renderer.indexOf('function campaignById(')), context);
context.startUpdateChecks(); context.startUpdateChecks();
assert.equal(timers.length, 1);
assert.equal(timers[0].ms, 1800);
await timers[0].fn();
assert.equal(popups, 1);
assert.equal($('#updateNow').classList.contains('hidden'), false);
context.closeUpdateDialog();

for (const kind of ['campaign', 'warming', 'filter']) {
  if (kind === 'campaign') state.campaigns = [{ status: 'running' }];
  else (kind === 'warming' ? state.warming : state.numberFilter).status = 'running';
  context.syncUpdateBusy(); context.showUpdateDialog(info);
  assert.equal($('#updateNow').classList.contains('hidden'), true);
  assert.equal($('#updateAfter').classList.contains('hidden'), false);
  context.remindUpdateAfterProcess();
  assert.equal($('#updateDialog').open, false);
  // Another task is still active: do not remind until all tasks have stopped.
  state.numberFilter.status = 'running';
  state.campaigns = []; state.warming.status = 'paused';
  context.syncUpdateBusy();
  assert.equal($('#updateDialog').open, false);
  state.numberFilter.status = 'paused'; context.syncUpdateBusy();
  assert.equal($('#updateDialog').open, true);
  assert.equal($('#updateNow').classList.contains('hidden'), false);
  assert.equal(downloads, 0, 'Deferred reminder must not install/download automatically');
  context.closeUpdateDialog();
}
state.warming.status = 'running'; context.syncUpdateBusy(); context.showUpdateDialog(info);
context.remindUpdateAfterProcess(); context.closeUpdateDialog();
state.warming.status = 'paused'; context.syncUpdateBusy();
assert.equal($('#updateDialog').open, false, 'Later cancels a queued reminder');
const count = popups;
info = { available: false }; await context.checkForUpdates(false);
info = { available: false, error: 'offline' }; await context.checkForUpdates(false);
assert.equal(popups, count, 'Automatic no-update/error checks must be quiet');
await context.checkForUpdates(true);
assert.match($('#updateSettingsStatus').textContent, /offline/);
assert.equal(downloads, 0);

let networkChecks = 0;
const backend = vm.createContext({ Buffer, Date, checkedUpdate: null,
  app: { getVersion: () => '3.4.4' }, UPDATE_API: 'fixture',
  readUpdateState: async () => ({ lastCheckedAt: Date.now(), latestVersion: '3.4.4' }), writeUpdateState: async () => {},
  githubRequest: async () => { networkChecks++; return { status: 200, body: Buffer.from(JSON.stringify({ tag_name: 'v3.4.5', assets: [
    { name: 'Neuron-WA-Blaster-3.4.5.exe' }, { name: 'Neuron-WA-Blaster-3.4.5.exe.sha256' }
  ] })) }; }
});
vm.runInContext(main.slice(main.indexOf('function versionParts('), main.indexOf('function githubRequest(')), backend);
vm.runInContext(main.slice(main.indexOf('async function checkForUpdate('), main.indexOf('function downloadToFile(')), backend);
assert.equal((await backend.checkForUpdate(false)).available, true);
assert.equal((await backend.checkForUpdate(false)).available, true);
assert.equal(networkChecks, 2, 'A recent check must not suppress the next startup check');
console.log('PASS: startup check, recent-cache bypass, quiet checks, manual errors, all-task deferred reminders, no automatic installation');
