import assert from "node:assert/strict";
import { WhatsAppManager } from "../app/wa-manager.mjs";

const calls = { reads: [], presence: [], sends: [] };
let sendStatus = 999;
const incoming = { key: { id: "incoming-1", remoteJid: "group-1@g.us", fromMe: false }, message: { conversation: "Hello" } };
const socket = {
  groupFetchAllParticipating: async () => ({
    "group-1@g.us": { id: "group-1@g.us", subject: "QA Group", participants: [{}, {}] }
  }),
  groupMetadata: async (jid) => ({ id: jid, subject: "QA Group" }),
  readMessages: async (keys) => calls.reads.push(keys),
  sendPresenceUpdate: async (type, jid) => calls.presence.push({ type, jid }),
  sendMessage: async (jid, content, options) => {
    calls.sends.push({ jid, content, options });
    return { key: { id: `sent-${calls.sends.length}` }, status: sendStatus };
  }
};

const manager = new WhatsAppManager({ dataDir: ".", emit: () => {} });
manager.accounts = [{ id: "account-1", name: "QA Account", phone: "60123456789", status: "connected", createdAt: Date.now() }];
manager.connections.set("account-1", {
  socket,
  pendingAcks: new Map(),
  ackStatuses: new Map(),
  delayedWarmingAcks: new Map(),
  recentGroupMessages: new Map([["group-1@g.us", [incoming]]])
});

const groups = await manager.listGroups(["account-1"]);
assert.equal(groups[0].groups[0].name, "QA Group");
assert.equal(groups[0].groups[0].participants, 2);

const read = await manager.readGroup({ accountId: "account-1", groupId: "group-1@g.us" });
assert.equal(read.read, true);

const sent = await manager.sendWarmingMessage({ accountId: "account-1", groupId: "group-1@g.us", text: "Test message", replyChance: 1, readChance: 1, typingMs: 1 });
assert.equal(sent.mode, "reply");
assert.equal(sent.status, "server_acknowledged");
assert.equal(calls.sends[0].options.quoted.key.id, "incoming-1");
assert.deepEqual(calls.presence.map((item) => item.type), ["composing", "paused"]);
assert.equal(calls.reads.length, 2);

sendStatus = 0;
const delayed = await manager.sendWarmingMessage({ accountId: "account-1", groupId: "group-1@g.us", text: "Delayed ACK test", replyChance: 0, readChance: 0, typingMs: 1, ackTimeoutMs: 5 });
assert.equal(delayed.status, "ack_delayed");
assert.ok(delayed.messageId);
assert.equal(manager.connections.get("account-1").delayedWarmingAcks.has(delayed.messageId), true);
for (const item of manager.connections.get("account-1").delayedWarmingAcks.values()) clearTimeout(item.timer);

console.log("Warming engine OK: groups, read, typing, reply, server acknowledgement, and delayed ACK fallback verified.");
