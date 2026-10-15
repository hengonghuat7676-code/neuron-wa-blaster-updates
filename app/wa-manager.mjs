import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import pino from "pino";
import QRCode from "qrcode";
import makeWASocket, {
  Browsers,
  DisconnectReason,
  fetchLatestBaileysVersion,
  generateMessageID,
  prepareWAMessageMedia,
  proto,
  useMultiFileAuthState
} from "@whiskeysockets/baileys";

const logger = pino({ level: "silent" });
const SERVER_ACK = proto.WebMessageInfo.Status.SERVER_ACK;
const ACK_TIMEOUT_MS = 20_000;
const WARMING_ACK_TIMEOUT_MS = 8_000;
const RECONNECT_BASE_MS = 3_000;
const RECONNECT_MAX_MS = 60_000;

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function disconnectDetails(lastDisconnect) {
  const error = lastDisconnect?.error;
  const code = Number(error?.output?.statusCode || error?.statusCode || error?.data?.statusCode || 0) || null;
  const message = String(error?.output?.payload?.message || error?.message || lastDisconnect?.date || "Connection closed");
  const labels = new Map([
    [DisconnectReason.badSession, "Bad session"],
    [DisconnectReason.connectionClosed, "Connection closed"],
    [DisconnectReason.connectionLost, "Connection lost"],
    [DisconnectReason.connectionReplaced, "Connection replaced by another session"],
    [DisconnectReason.loggedOut, "Logged out by WhatsApp"],
    [DisconnectReason.restartRequired, "WhatsApp requested a restart"],
    [DisconnectReason.timedOut, "Connection timed out"],
    [DisconnectReason.forbidden, "Connection forbidden"]
  ]);
  return { code, reason: labels.get(code) || message };
}

export class WhatsAppManager {
  constructor({ dataDir, emit }) {
    this.dataDir = dataDir;
    this.accountsFile = path.join(dataDir, "accounts.json");
    this.emit = emit;
    this.accounts = [];
    this.connections = new Map();
    this.reconnectAttempts = new Map();
    this.closing = false;
  }

  async initialize() {
    this.closing = false;
    await fs.mkdir(this.dataDir, { recursive: true });
    try { this.accounts = JSON.parse(await fs.readFile(this.accountsFile, "utf8")); } catch { this.accounts = []; }
    for (const account of this.accounts) {
      account.status = "connecting";
      this.connect(account.id).catch(() => this.setStatus(account.id, "disconnected"));
    }
  }

  async persist() {
    await fs.writeFile(this.accountsFile, JSON.stringify(this.accounts, null, 2), "utf8");
  }

  publicAccount(account) {
    return {
      id: account.id,
      name: account.name,
      phone: account.phone || "",
      status: account.status || "disconnected",
      createdAt: account.createdAt,
      lastConnectedAt: account.lastConnectedAt || null,
      lastDisconnectReason: account.lastDisconnectReason || "",
      lastDisconnectCode: account.lastDisconnectCode ?? null,
      reconnectAttempt: Number(account.reconnectAttempt || 0),
      nextReconnectAt: account.nextReconnectAt || null
    };
  }

  list() { return this.accounts.map((account) => this.publicAccount(account)); }

  notify(account) { this.emit("account:update", this.publicAccount(account)); }

  async setStatus(id, status, extra = {}) {
    const account = this.accounts.find((item) => item.id === id);
    if (!account) return;
    Object.assign(account, { status, ...extra });
    await this.persist();
    this.notify(account);
  }

  async add(name) {
    const account = {
      id: crypto.randomUUID(),
      name: String(name || "WhatsApp Account").trim().slice(0, 50) || "WhatsApp Account",
      phone: "",
      status: "connecting",
      createdAt: Date.now()
    };
    this.accounts.push(account);
    await this.persist();
    this.notify(account);
    this.connect(account.id, true).catch(() => this.setStatus(account.id, "disconnected"));
    return this.publicAccount(account);
  }

  async connect(id, forceQr = false) {
    const account = this.accounts.find((item) => item.id === id);
    if (!account) throw new Error("Account not found");
    const existing = this.connections.get(id);
    if (existing?.socket && account.status === "connected") return this.publicAccount(account);
    if (existing?.connecting) return this.publicAccount(account);

    const authDir = path.join(this.dataDir, id);
    if (forceQr) {
      try { existing?.socket?.end?.(new Error("Session reset")); } catch {}
      this.connections.delete(id);
      await fs.rm(authDir, { recursive: true, force: true });
      account.phone = "";
    }

    await fs.mkdir(authDir, { recursive: true });
    const holder = {
      socket: null,
      connecting: true,
      reconnectTimer: null,
      pendingAcks: new Map(),
      ackStatuses: new Map(),
      delayedWarmingAcks: new Map(),
      recentGroupMessages: new Map()
    };
    this.connections.set(id, holder);
    await this.setStatus(id, "connecting");

    const { state, saveCreds } = await useMultiFileAuthState(authDir);
    let protocolVersion;
    try { protocolVersion = (await fetchLatestBaileysVersion()).version; } catch {}
    const socket = makeWASocket({
      auth: state,
      browser: Browsers.windows("Chrome"),
      logger,
      ...(protocolVersion ? { version: protocolVersion } : {}),
      markOnlineOnConnect: false,
      syncFullHistory: false,
      shouldSyncHistoryMessage: () => false,
      generateHighQualityLinkPreview: false,
      connectTimeoutMs: 90_000,
      defaultQueryTimeoutMs: 90_000,
      keepAliveIntervalMs: 20_000,
      retryRequestDelayMs: 2_000,
      qrTimeout: 120_000,
      transactionOpts: { maxCommitRetries: 15, delayBetweenTriesMs: 5_000 }
    });
    holder.socket = socket;
    holder.connecting = false;
    socket.ev.on("creds.update", saveCreds);
    socket.ev.on("messages.update", (updates) => {
      for (const { key, update } of updates || []) {
        const messageId = key?.id;
        const status = Number(update?.status);
        if (!messageId || !Number.isFinite(status)) continue;
        holder.ackStatuses.set(messageId, status);
        const pending = holder.pendingAcks.get(messageId);
        if (pending && status >= SERVER_ACK) {
          clearTimeout(pending.timer);
          holder.pendingAcks.delete(messageId);
          pending.resolve(status);
        }
        const delayed = holder.delayedWarmingAcks.get(messageId);
        if (delayed && status >= SERVER_ACK) {
          clearTimeout(delayed.timer);
          holder.delayedWarmingAcks.delete(messageId);
          this.emit("warming:ack", { accountId: id, messageId, status: "server_acknowledged", statusCode: status });
        }
        setTimeout(() => holder.ackStatuses.delete(messageId), 60_000).unref?.();
      }
    });
    socket.ev.on("messages.upsert", ({ messages }) => {
      for (const message of messages || []) {
        const jid = message?.key?.remoteJid;
        if (!jid?.endsWith("@g.us") || message.key.fromMe || !message.message) continue;
        const recent = holder.recentGroupMessages.get(jid) || [];
        recent.push(message);
        if (recent.length > 50) recent.splice(0, recent.length - 50);
        holder.recentGroupMessages.set(jid, recent);
      }
    });
    socket.ev.on("connection.update", async ({ connection, lastDisconnect, qr }) => {
      if (qr) {
        const dataUrl = await QRCode.toDataURL(qr, { width: 360, margin: 2, color: { dark: "#071a33", light: "#ffffff" } });
        await this.setStatus(id, "qr");
        this.emit("account:qr", { id, dataUrl });
      }
      if (connection === "open") {
        const phone = String(socket.user?.id || "").split(":")[0].split("@")[0];
        this.reconnectAttempts.delete(id);
        await this.setStatus(id, "connected", {
          phone,
          lastConnectedAt: Date.now(),
          reconnectAttempt: 0,
          nextReconnectAt: null,
          lastDisconnectReason: "",
          lastDisconnectCode: null
        });
        this.emit("account:qr", { id, dataUrl: null });
      }
      if (connection === "close" && !this.closing) {
        if (this.connections.get(id) !== holder) return;
        this.rejectPendingAcks(holder, "WhatsApp disconnected before confirming the message");
        const { code, reason } = disconnectDetails(lastDisconnect);
        const loggedOut = [DisconnectReason.loggedOut, DisconnectReason.forbidden, 401, 403].includes(code);
        this.connections.delete(id);
        await this.setStatus(id, loggedOut ? "logged_out" : "reconnecting", {
          lastDisconnectReason: reason,
          lastDisconnectCode: code,
          nextReconnectAt: null
        });
        if (!loggedOut && this.accounts.some((item) => item.id === id)) {
          this.scheduleReconnect(id, reason);
        }
      }
    });
    return this.publicAccount(account);
  }

  async scheduleReconnect(id, reason = "Connection closed") {
    if (this.closing || !this.accounts.some((item) => item.id === id)) return;
    const attempt = (this.reconnectAttempts.get(id) || 0) + 1;
    this.reconnectAttempts.set(id, attempt);
    const waitMs = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * (2 ** Math.min(attempt - 1, 5)));
    const nextReconnectAt = Date.now() + waitMs;
    await this.setStatus(id, "reconnecting", { reconnectAttempt: attempt, nextReconnectAt, lastDisconnectReason: reason });
    const timer = setTimeout(async () => {
      if (this.closing || !this.accounts.some((item) => item.id === id)) return;
      try {
        await this.connect(id);
      } catch (error) {
        this.connections.delete(id);
        await this.scheduleReconnect(id, error?.message || reason);
      }
    }, waitMs);
    timer.unref?.();
  }

  async rename(id, name) {
    const account = this.accounts.find((item) => item.id === id);
    if (!account) throw new Error("Account not found");
    account.name = String(name || "").trim().slice(0, 50) || account.name;
    await this.persist();
    this.notify(account);
    return this.publicAccount(account);
  }

  async logout(id) {
    const holder = this.connections.get(id);
    try { await holder?.socket?.logout(); } catch {}
    try { holder?.socket?.end?.(new Error("Logged out")); } catch {}
    this.connections.delete(id);
    await fs.rm(path.join(this.dataDir, id), { recursive: true, force: true });
    await this.setStatus(id, "logged_out", { phone: "" });
    return true;
  }

  async remove(id) {
    const holder = this.connections.get(id);
    try { holder?.socket?.end?.(new Error("Account removed")); } catch {}
    if (holder?.reconnectTimer) clearTimeout(holder.reconnectTimer);
    this.connections.delete(id);
    this.accounts = this.accounts.filter((item) => item.id !== id);
    await this.persist();
    await fs.rm(path.join(this.dataDir, id), { recursive: true, force: true });
    this.emit("account:removed", { id });
    return true;
  }

  socketFor(id) {
    const account = this.accounts.find((item) => item.id === id);
    const holder = this.connections.get(id);
    const socket = holder?.socket;
    if (!account || account.status !== "connected" || !socket) throw new Error("Selected WhatsApp account is not connected");
    return { socket, holder };
  }

  rejectPendingAcks(holder, message) {
    for (const pending of holder?.pendingAcks?.values?.() || []) {
      clearTimeout(pending.timer);
      pending.reject(new Error(message));
    }
    holder?.pendingAcks?.clear?.();
  }

  waitForServerAck(holder, messageId, initialStatus, timeoutMs = ACK_TIMEOUT_MS) {
    if (!messageId) throw new Error("WhatsApp did not return a message ID");
    const knownStatus = Math.max(Number(initialStatus) || 0, Number(holder.ackStatuses.get(messageId)) || 0);
    if (knownStatus >= SERVER_ACK) return Promise.resolve(knownStatus);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        holder.pendingAcks.delete(messageId);
        const error = new Error("WhatsApp server acknowledgement is delayed.");
        error.code = "ACK_TIMEOUT";
        reject(error);
      }, timeoutMs);
      holder.pendingAcks.set(messageId, { resolve, reject, timer });
    });
  }

  async resolveJid(socket, phone) {
    const digits = String(phone || "").replace(/\D/g, "").replace(/^0/, "62");
    if (digits.length < 8) throw new Error("Invalid recipient number");
    return `${digits}@s.whatsapp.net`;
  }

  async checkNumber({ accountId, phone }) {
    const { socket } = this.socketFor(accountId);
    const digits = String(phone || "").replace(/\D/g, "").replace(/^0/, "62");
    if (digits.length < 8) throw new Error("Invalid phone number");
    const jid = `${digits}@s.whatsapp.net`;
    const result = await socket.onWhatsApp(jid);
    const match = Array.isArray(result) ? result[0] : result;
    return {
      ok: true,
      phone: digits,
      registered: Boolean(match?.exists),
      jid: match?.jid || jid
    };
  }

  async send({ accountId, phone, payload }) {
    const { socket, holder } = this.socketFor(accountId);
    const jid = await this.resolveJid(socket, phone);
    const type = payload?.type || "text";
    const text = String(payload?.text || "");
    const mediaPath = payload?.mediaPath ? path.resolve(payload.mediaPath) : "";

    let sent;
    if (type === "cta") {
      sent = await this.sendCta(socket, jid, payload);
    } else if (type === "image") {
      if (!mediaPath) throw new Error("Image file is required");
      sent = await socket.sendMessage(jid, { image: { url: mediaPath }, caption: text });
    } else if (type === "video") {
      if (!mediaPath) throw new Error("Video file is required");
      sent = await socket.sendMessage(jid, { video: { url: mediaPath }, caption: text });
    } else if (type === "document") {
      if (!mediaPath) throw new Error("Document file is required");
      sent = await socket.sendMessage(jid, { document: { url: mediaPath }, fileName: path.basename(mediaPath), mimetype: "application/octet-stream", caption: text });
    } else {
      sent = await socket.sendMessage(jid, { text });
    }
    const messageId = sent?.key?.id;
    const status = await this.waitForServerAck(holder, messageId, sent?.status);
    return { ok: true, jid, messageId, status: "server_acknowledged", statusCode: status };
  }

  async sendCta(socket, jid, payload) {
    const url = String(payload.buttonUrl || "").trim();
    if (!/^https?:\/\//i.test(url)) throw new Error("Button URL must start with http:// or https://");
    const label = String(payload.buttonText || "OPEN LINK").trim().slice(0, 25) || "OPEN LINK";
    let media = {};
    if (payload.mediaPath) {
      media = await prepareWAMessageMedia({ image: { url: path.resolve(payload.mediaPath) } }, { upload: socket.waUploadToServer });
    }
    const interactive = proto.Message.InteractiveMessage.create({
      ...(media.imageMessage ? {
        header: proto.Message.InteractiveMessage.Body.create({
          title: "\u200e ",
          imageMessage: media.imageMessage,
          hasMediaAttachment: true
        })
      } : {}),
      body: proto.Message.InteractiveMessage.Body.create({ text: String(payload.text || "") }),
      footer: proto.Message.InteractiveMessage.Footer.create({ text: String(payload.footer || "") }),
      nativeFlowMessage: proto.Message.InteractiveMessage.NativeFlowMessage.create({
        buttons: [{ name: "cta_url", buttonParamsJson: JSON.stringify({ fix: true, display_text: label, url, merchant_url: url, id: "url-button-0" }) }]
      })
    });
    const message = {
      interactiveMessage: interactive,
      ...(media.imageMessage ? { messageContextInfo: { messageSecret: crypto.randomBytes(32) } } : {})
    };
    const messageId = generateMessageID();
    const bizNode = {
      tag: "biz",
      attrs: {},
      content: [
        { tag: "interactive", attrs: { type: "native_flow", v: "1" }, content: [{ tag: "native_flow", attrs: { v: "2", name: "mixed" }, content: [] }] }
      ]
    };
    await socket.presenceSubscribe(jid).catch(() => {});
    await delay(150 + Math.floor(Math.random() * 151));
    await socket.sendPresenceUpdate("available", jid).catch(() => {});
    await delay(200 + Math.floor(Math.random() * 301));
    await socket.sendPresenceUpdate("paused", jid).catch(() => {});
    await delay(300 + Math.floor(Math.random() * 301));
    await socket.sendPresenceUpdate("composing", jid).catch(() => {});
    await delay(200 + Math.floor(Math.random() * 301));
    await socket.sendPresenceUpdate("paused", jid).catch(() => {});
    await delay(50);
    try {
      await socket.relayMessage(jid, message, { messageId, additionalNodes: [bizNode] });
    } finally {
      await socket.sendPresenceUpdate("paused", jid).catch(() => {});
    }
    return { key: { id: messageId }, message, status: null };
  }

  async listGroups(accountIds = []) {
    const requested = new Set(Array.isArray(accountIds) ? accountIds : []);
    const selected = this.accounts.filter((account) => !requested.size || requested.has(account.id));
    const results = [];
    for (const account of selected) {
      if (account.status !== "connected") {
        results.push({ accountId: account.id, accountName: account.name, groups: [], error: "Account is not connected" });
        continue;
      }
      try {
        const { socket } = this.socketFor(account.id);
        const groups = Object.values(await socket.groupFetchAllParticipating()).map((group) => ({
          id: group.id,
          name: group.subject || group.id,
          participants: group.participants?.length || 0
        })).sort((a, b) => a.name.localeCompare(b.name));
        results.push({ accountId: account.id, accountName: account.name, groups });
      } catch (error) {
        results.push({ accountId: account.id, accountName: account.name, groups: [], error: error?.message || String(error) });
      }
    }
    return results;
  }

  latestIncomingGroupMessage(holder, groupId) {
    const recent = holder.recentGroupMessages.get(groupId) || [];
    return recent.length ? recent[recent.length - 1] : null;
  }

  async readGroup({ accountId, groupId }) {
    if (!String(groupId || "").endsWith("@g.us")) throw new Error("Select a valid WhatsApp group");
    const { socket, holder } = this.socketFor(accountId);
    const latest = this.latestIncomingGroupMessage(holder, groupId);
    if (!latest?.key) return { ok: true, read: false, reason: "No recent incoming message is cached yet" };
    await socket.readMessages([latest.key]);
    return { ok: true, read: true };
  }

  async sendWarmingMessage({ accountId, groupId, text, replyChance = 0, readChance = 0, typingMs = 3000, ackTimeoutMs = WARMING_ACK_TIMEOUT_MS }) {
    if (!String(groupId || "").endsWith("@g.us")) throw new Error("Select a valid WhatsApp group");
    const body = String(text || "").trim();
    if (!body) throw new Error("Warming message is empty");
    const { socket, holder } = this.socketFor(accountId);
    await socket.groupMetadata(groupId);
    const latest = this.latestIncomingGroupMessage(holder, groupId);
    let read = false;
    if (latest?.key && Math.random() < Math.max(0, Math.min(1, Number(readChance) || 0))) {
      await socket.readMessages([latest.key]);
      read = true;
    }
    await socket.sendPresenceUpdate("composing", groupId);
    await new Promise((resolve) => setTimeout(resolve, Math.max(500, Math.min(15_000, Number(typingMs) || 3000))));
    const reply = Boolean(latest && Math.random() < Math.max(0, Math.min(1, Number(replyChance) || 0)));
    let sent;
    try {
      sent = await socket.sendMessage(groupId, { text: body }, reply ? { quoted: latest } : {});
    } finally {
      await socket.sendPresenceUpdate("paused", groupId).catch(() => {});
    }
    const messageId = sent?.key?.id;
    try {
      const status = await this.waitForServerAck(holder, messageId, sent?.status, ackTimeoutMs);
      return { ok: true, messageId, mode: reply ? "reply" : "normal", read, status: "server_acknowledged", statusCode: status };
    } catch (error) {
      if (error?.code !== "ACK_TIMEOUT" || !messageId) throw error;
      const lateStatus = Number(holder.ackStatuses.get(messageId)) || 0;
      if (lateStatus >= SERVER_ACK) {
        return { ok: true, messageId, mode: reply ? "reply" : "normal", read, status: "server_acknowledged", statusCode: lateStatus };
      }
      const timer = setTimeout(() => holder.delayedWarmingAcks.delete(messageId), 10 * 60_000);
      timer.unref?.();
      holder.delayedWarmingAcks.set(messageId, { timer, createdAt: Date.now() });
      return { ok: true, messageId, mode: reply ? "reply" : "normal", read, status: "ack_delayed", statusCode: null };
    }
  }

  shutdown() {
    this.closing = true;
    for (const holder of this.connections.values()) {
      if (holder.reconnectTimer) clearTimeout(holder.reconnectTimer);
      this.rejectPendingAcks(holder, "Application closed before WhatsApp confirmed the message");
      for (const delayed of holder.delayedWarmingAcks?.values?.() || []) clearTimeout(delayed.timer);
      try { holder.socket?.end?.(new Error("Application closed")); } catch {}
    }
    this.connections.clear();
    this.reconnectAttempts.clear();
  }
}
