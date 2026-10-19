import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createHash } from 'node:crypto';
import { DisconnectReason } from '@whiskeysockets/baileys';
import { WhatsAppManager } from '../app/wa-manager.mjs';

// Freeze the user-approved 3.4.5 implementation, not a mixed/new session engine.
// Normalize CRLF so this guard works on both Windows and GitHub checkouts.
const source = (await fs.readFile(new URL('../app/wa-manager.mjs', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
assert.equal(createHash('sha256').update(source).digest('hex'), '1aef8221e29bf0928f5ad435be75b0c49260ab1377c5becd795b4254f0445023',
  'Account/session implementation must match 3.4.5 commit 6022460 exactly');
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'neuron-session-345-test-'));
const manager = new WhatsAppManager({ dataDir: root, emit() {} });
async function fixture(id) {
  await fs.mkdir(path.join(root, id), { recursive: true });
  await fs.writeFile(path.join(root, id, 'creds.json'), 'synthetic session');
  manager.accounts.push({ id, name: id, status: 'connected', phone: '60000000000' });
  const holder = { socket: { async logout() {}, end() {} }, pendingAcks: new Map(), delayedWarmingAcks: new Map() };
  manager.connections.set(id, holder);
  return holder;
}
const exists = id => fs.access(path.join(root, id, 'creds.json')).then(() => true, () => false);
try {
  await fs.writeFile(path.join(root, 'campaign-data.json'), 'preserve');
  await fixture('other-account');
  await fixture('manual');
  await manager.logout('manual');
  assert.equal(await exists('manual'), false);
  assert.equal(manager.connections.has('manual'), false);
  assert.equal(manager.accounts.find(a => a.id === 'manual').status, 'logged_out');
  assert.equal(await exists('other-account'), true);
  assert.equal(await fs.readFile(path.join(root, 'campaign-data.json'), 'utf8'), 'preserve');

  // Execute the restored connection-close handler without opening a WA connection.
  const holder = await fixture('remote');
  const startMarker = 'socket.ev.on("connection.update", async ({ connection, lastDisconnect, qr }) => {';
  const start = source.indexOf(startMarker) + startMarker.length;
  const end = source.indexOf('\n    });\n    return this.publicAccount(account);', start);
  assert.ok(start >= startMarker.length && end > start);
  const context = vm.createContext({ id: 'remote', holder, DisconnectReason });
  const detailsStart = source.indexOf('function disconnectDetails(');
  vm.runInContext(source.slice(detailsStart, source.indexOf('export class WhatsAppManager', detailsStart)), context);
  const onUpdate = vm.runInContext('(async function({ connection, lastDisconnect, qr }) {' + source.slice(start, end) + '\n})', context);
  await onUpdate.call(manager, { connection: 'close', lastDisconnect: { error: { output: { statusCode: 401 } } } });
  assert.equal(manager.accounts.find(a => a.id === 'remote').status, 'logged_out');
  assert.equal(await exists('remote'), true, '3.4.5 retains remote-logout auth files until reset/manual cleanup');
  console.log('PASS: exact 3.4.5 session-source parity, manual Logout cleanup, remote Logout legacy behavior and account/application-data isolation');
} finally {
  manager.shutdown();
  await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
