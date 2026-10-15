import fs from "node:fs";

const source = fs.readFileSync(new URL("../app/wa-manager.mjs", import.meta.url), "utf8");
const required = [
  'return `${digits}@s.whatsapp.net`',
  "generateMessageID()",
  'title: "\\u200e "',
  "messageSecret: crypto.randomBytes(32)",
  'sendPresenceUpdate("available", jid)',
  'sendPresenceUpdate("composing", jid)',
  "socket.relayMessage(jid, message, { messageId, additionalNodes: [bizNode] })"
];
const missing = required.filter((item) => !source.includes(item));
if (missing.length) throw new Error(`Hero CTA contract missing: ${missing.join(", ")}`);
if (source.includes("socket.onWhatsApp(digits)")) throw new Error("Hero CTA contract must not resolve new recipients through onWhatsApp().");
console.log("Hero CTA contract OK: direct PN-JID, legacy message ID, media secret, presence sequence, and relay payload verified.");
