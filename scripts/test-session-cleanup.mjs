import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { WhatsAppManager } from '../app/wa-manager.mjs';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'neuron-session-test-'));
const events = [];
const manager = new WhatsAppManager({ dataDir: root, emit: (name, value) => events.push({ name, value }) });
function holder() {
  return { socket: { end() {}, async logout() {} }, pendingAcks: new Map(), delayedWarmingAcks: new Map(), authWrites: Promise.resolve() };
}
async function fixture(id) {
  await fs.mkdir(path.join(root, id), { recursive: true });
  await fs.writeFile(path.join(root, id, 'creds.json'), 'old-session');
  manager.accounts.push({ id, name: id, status: 'connected', phone: '60000000000' });
  const connection = holder();
  manager.connections.set(id, connection);
  return connection;
}
async function exists(id) { return fs.access(path.join(root, id, 'creds.json')).then(() => true, () => false); }
try {
  await fs.writeFile(path.join(root, 'campaign-data.json'), 'keep campaign data');
  await fixture('other-account');
  const manual = await fixture('manual');
  await manager.scheduleReconnect('manual');
  const writes = new Promise(resolve => setTimeout(async () => { await fs.writeFile(path.join(root, 'manual', 'late-key.json'), 'drained'); resolve(); }, 20));
  manual.authWrites = writes;
  await manager.logout('manual');
  assert.equal(await exists('manual'), false);
  assert.equal(manager.accounts.find(a => a.id === 'manual').status, 'logged_out');
  assert.equal(manager.reconnectTimers.has('manual'), false);
  assert.equal(manager.connections.has('manual'), false);
  assert.equal(manual.closed, true);
  assert.equal(await exists('other-account'), true);

  const remote = await fixture('remote');
  await manager.handleConnectionClose('remote', remote, { error: { output: { statusCode: 401 } } });
  assert.equal(await exists('remote'), false);
  assert.equal(manager.accounts.find(a => a.id === 'remote').phone, '');
  assert.equal(manager.reconnectTimers.has('remote'), false);
  // Delayed close callbacks from the old socket cannot destroy a replacement.
  const replacement = holder();
  manager.connections.set('remote', replacement);
  await fs.mkdir(path.join(root, 'remote'));
  await fs.writeFile(path.join(root, 'remote', 'creds.json'), 'new-session');
  await manager.handleConnectionClose('remote', remote, { error: { output: { statusCode: 401 } } });
  assert.equal(await exists('remote'), true);
  assert.equal(manager.connections.get('remote'), replacement);

  const temporary = await fixture('temporary');
  await manager.handleConnectionClose('temporary', temporary, { error: { output: { statusCode: 408 } } });
  assert.equal(await exists('temporary'), true);
  assert.equal(manager.reconnectTimers.has('temporary'), true);
  const restricted = await fixture('restricted');
  await manager.handleConnectionClose('restricted', restricted, { error: { output: { statusCode: 403 } } });
  assert.equal(await exists('restricted'), true, '403 alone must not wipe authentication');
  assert.equal(manager.reconnectTimers.has('restricted'), false);
  assert.equal(await fs.readFile(path.join(root, 'campaign-data.json'), 'utf8'), 'keep campaign data');
  assert.throws(() => manager.sessionDirectory('../'), /Invalid account/);
  // Restart must not reconnect accounts already marked logged out.
  const restart = new WhatsAppManager({ dataDir: root, emit() {} });
  const reconnected = [];
  restart.connect = async id => reconnected.push(id);
  await restart.initialize();
  assert.equal(reconnected.includes('manual'), false);
  assert.equal(reconnected.includes('remote'), false);
  restart.shutdown();
  console.log('PASS session cleanup: manual/remote logout, pending auth writes, stale callbacks, retry cancellation, temporary/restricted preservation, restart and account isolation');
} finally {
  manager.shutdown();
  await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
