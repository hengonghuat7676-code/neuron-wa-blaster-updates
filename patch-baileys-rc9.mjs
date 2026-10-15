import fs from "node:fs";

const target = new URL("../node_modules/@whiskeysockets/baileys/lib/Utils/process-message.js", import.meta.url);
if (!fs.existsSync(target)) process.exit(0);

let source = fs.readFileSync(target, "utf8");
if (source.includes("dropping spoofed self-only protocolMessage")) process.exit(0);

const marker = "    if (protocolMsg) {\n        switch (protocolMsg.type) {";
const guard = `    if (protocolMsg) {
        const SELF_ONLY_TYPES = new Set([
            proto.Message.ProtocolMessage.Type.HISTORY_SYNC_NOTIFICATION,
            proto.Message.ProtocolMessage.Type.APP_STATE_SYNC_KEY_SHARE,
            proto.Message.ProtocolMessage.Type.LID_MIGRATION_MAPPING_SYNC,
            proto.Message.ProtocolMessage.Type.PEER_DATA_OPERATION_REQUEST_RESPONSE_MESSAGE
        ]);
        if (protocolMsg.type !== null &&
            protocolMsg.type !== undefined &&
            SELF_ONLY_TYPES.has(protocolMsg.type) &&
            !message.key.fromMe) {
            logger?.warn({ msgId: message.key.id, type: protocolMsg.type, from: message.key.participant || message.key.remoteJid }, 'dropping spoofed self-only protocolMessage from non-self origin');
            return;
        }
        switch (protocolMsg.type) {`;

if (!source.includes(marker)) throw new Error("Unsupported Baileys process-message layout; security guard was not applied.");
source = source.replace(marker, guard);
fs.writeFileSync(target, source);
console.log("Applied the Baileys rc9 self-only protocol-message security guard.");
