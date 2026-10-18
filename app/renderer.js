const defaultWarming = () => ({ status: "ready", groupId: "", groupName: "", accountIds: [], messages: "", messageIndex: 0, initialMessageCount: 0, maxMessages: 20, delayMin: 1, delayMax: 5, cooldownMin: 35, cooldownMax: 50, replyChance: 38, readChance: 75, idleRead: 9, accountProgress: {}, delayedAcks: {}, nextActivityAt: 0, nextIdleReadAt: 0, pauseReason: "", logs: [] });
const defaultNumberFilter = () => ({ items: [], accountIds: [], accountProgress: {}, status: "ready", cursor: 0, pauseReason: "" });
const initial = { contacts: [], campaigns: [], queue: [], history: [], warming: defaultWarming(), numberFilter: defaultNumberFilter(), theme: "light", compact: false, importStats: { invalid: 0, duplicates: 0 } };
let state = loadState();
let accounts = [];
let qrAccountId = null;
let licenseState = { valid: false, status: "checking", message: "Checking license…", machineId: "", deviceName: "", expires: "" };
const campaignRunners = new Set();
let warmingRunner = false;
let numberFilterRunner = false;
let warmingGroups = [];
let availableUpdate = null;
let updateAfterProcess = false;
let updateDownloading = false;
let updateCheckTimer = null;
let updateCheckInFlight = false;
let lastUpdateBusy = null;

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const pageText = {
  dashboard: ["Dashboard", "Campaign and account overview"],
  accounts: ["Accounts", "Connect and manage background WhatsApp sessions"],
  contacts: ["Contacts", "Prepare and assign recipients to campaigns"],
  filter: ["WA Filter", "Check numbers before adding registered recipients to Contacts"],
  queue: ["Queue", "Create campaigns and monitor persistent progress"],
  sending: ["Sending", "Compose messages and run selected campaigns"],
  warming: ["Account Warming", "Controlled multi-account activity inside a WhatsApp group"],
  history: ["History", "Results from all processed campaigns"],
  license: ["License", "Activate and review this computer's license"],
  settings: ["Settings", "Configure appearance and local data"]
};

function newId() { return crypto.randomUUID(); }
function cleanPhone(value) { return String(value || "").replace(/\D/g, "").replace(/^0/, "62"); }
function escapeHtml(value) { return String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char])); }
function errorMessage(error) { return error?.message || String(error || "Unknown error"); }
function toast(message) { const el = $("#toast"); el.textContent = message; el.classList.add("show"); clearTimeout(toast.timer); toast.timer = setTimeout(() => el.classList.remove("show"), 3400); }
function restoreInputFocus(target) {
  requestAnimationFrame(async () => {
    // A different dialog or another field may have taken focus in the meantime.
    if (document.querySelector('dialog[open]')) return;
    await window.neuron.restoreInputFocus().catch(() => {});
    if (document.querySelector('dialog[open]')) return;
    const active = document.activeElement;
    if (active && active !== document.body && active !== target && active.matches('input, textarea, select')) return;
    if (target?.isConnected && !target.disabled && target.getClientRects().length) target.focus({ preventScroll: true });
  });
}
let actionDialogBusy = false;
function askAction(message, value) {
  if (actionDialogBusy) return Promise.resolve(value === undefined ? false : null);
  actionDialogBusy = true;
  const dialog = $("#actionDialog");
  const input = $("#actionInput");
  const editing = value !== undefined;
  $("#actionTitle").textContent = editing ? "Rename" : "Confirm action";
  $("#actionMessage").textContent = message;
  $("#actionInputLabel").hidden = !editing;
  // The existing `dialog label` CSS overrides the browser's [hidden] rule.
  $("#actionInputLabel").style.display = editing ? "block" : "none";
  input.disabled = !editing;
  input.value = editing ? value : "";
  $("#actionAccept").textContent = editing ? "Save" : "Confirm";
  dialog.returnValue = "cancel";
  return new Promise((resolve) => {
    dialog.addEventListener("close", () => {
      actionDialogBusy = false;
      resolve(dialog.returnValue === "ok" ? (editing ? input.value : true) : (editing ? null : false));
    }, { once: true });
    dialog.showModal();
    if (editing) { input.focus(); input.select(); }
    else dialog.querySelector('button[value="cancel"]').focus();
  });
}
function formatBytes(value) { const bytes = Number(value) || 0; if (bytes < 1024) return `${bytes} B`; if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`; return `${(bytes / 1024 / 1024).toFixed(1)} MB`; }
function humanizeSeconds(value) { const seconds = Math.max(0, Number(value) || 0); if (seconds < 60) return `${Math.round(seconds)} sec`; const hours = Math.floor(seconds / 3600); const minutes = Math.round((seconds % 3600) / 60); return hours ? `${hours} hr${minutes ? ` ${minutes} min` : ""}` : `${minutes} min`; }
function hasRunningProcess() { return state.campaigns.some((campaign) => campaign.status === "running" && campaignCounts(campaign.id).remaining > 0) || state.warming.status === "running" || state.numberFilter.status === "running"; }
function syncUpdateBusy() {
  const busy = hasRunningProcess();
  if (busy === lastUpdateBusy) return;
  lastUpdateBusy = busy;
  window.neuron.setUpdateBusy(busy).catch(() => {});
  if (availableUpdate && !updateDownloading && $("#updateDialog").open) showUpdateDialog(availableUpdate);
  if (!busy && updateAfterProcess && availableUpdate && !updateDownloading) {
    updateAfterProcess = false;
    showUpdateDialog(availableUpdate);
  }
}

function closeUpdateDialog() {
  if (updateDownloading) return;
  updateAfterProcess = false;
  $("#updateDialog").close();
}

function remindUpdateAfterProcess() {
  if (!availableUpdate || updateDownloading) return;
  if (!hasRunningProcess()) { showUpdateDialog(availableUpdate); return; }
  updateAfterProcess = true;
  $("#updateDialog").close();
  toast("The update reminder will appear after all active processes finish or pause.");
}

function showUpdateDialog(info) {
  availableUpdate = info;
  const busy = hasRunningProcess();
  $("#updateTitle").textContent = "Update Available";
  $("#updateMessage").textContent = busy ? "A process is currently running. You can be reminded after all active processes finish or pause." : "A new version of Neuron WA Blaster is ready to download.";
  $("#updateDetails").innerHTML = `<div><span>Current</span><strong>${escapeHtml(info.currentVersion || "—")}</strong></div><div><span>Latest</span><strong>${escapeHtml(info.latestVersion || "—")}</strong></div><div><span>Size</span><strong>${escapeHtml(formatBytes(info.size))}</strong></div>`;
  $("#updateNotes").textContent = info.notes || "No release notes provided.";
  $("#updateProgressWrap").classList.add("hidden");
  $("#updateNow").classList.toggle("hidden", busy);
  $("#updateAfter").classList.toggle("hidden", !busy);
  $("#updateNow").disabled = false;
  $("#updateLater").disabled = false;
  $("#updateLater").textContent = "Update Later";
  if (!$("#updateDialog").open) $("#updateDialog").showModal();
}

async function checkForUpdates(manual = false) {
  if (updateCheckInFlight || updateDownloading) return;
  updateCheckInFlight = true;
  if (manual) { $("#checkUpdates").disabled = true; $("#updateSettingsStatus").textContent = "Checking GitHub for updates…"; }
  try {
    const info = await window.neuron.checkForUpdates(manual);
    if (info.available) { $("#updateSettingsStatus").textContent = `Version ${info.latestVersion} is available.`; showUpdateDialog(info); return; }
    if (info.error) { if (manual) { $("#updateSettingsStatus").textContent = `Unable to check: ${info.error}`; toast("Unable to check for updates"); } return; }
    if (manual) { $("#updateSettingsStatus").textContent = "You are using the latest available version."; toast("No updates available"); }
  } catch (error) {
    if (manual) { $("#updateSettingsStatus").textContent = `Unable to check: ${errorMessage(error)}`; toast("Unable to check for updates"); }
  } finally { updateCheckInFlight = false; if (manual) $("#checkUpdates").disabled = false; }
}

async function beginUpdate() {
  if (!availableUpdate) return;
  if (hasRunningProcess()) { showUpdateDialog(availableUpdate); return; }
  updateAfterProcess = false;
  updateDownloading = true;
  $("#updateProgressWrap").classList.remove("hidden");
  $("#updateProgressLabel").textContent = "Downloading update…";
  $("#updateProgressPercent").textContent = "0%";
  $("#updateProgress").value = 0;
  $("#updateNow").disabled = true;
  $("#updateAfter").classList.add("hidden");
  $("#updateLater").disabled = true;
  try {
    await window.neuron.downloadUpdate(availableUpdate);
    $("#updateTitle").textContent = "Update Ready";
    $("#updateMessage").textContent = "The verified update will replace this portable EXE and restart the application.";
    await window.neuron.installUpdate();
  } catch (error) {
    updateDownloading = false;
    $("#updateTitle").textContent = "Update Failed";
    $("#updateMessage").textContent = errorMessage(error);
    $("#updateNow").disabled = false;
    $("#updateLater").disabled = false;
    $("#updateLater").textContent = "Close";
  }
}

function startUpdateChecks() {
  if (updateCheckTimer !== null) return;
  updateCheckTimer = setTimeout(() => checkForUpdates(false), 1_800);
}
function campaignById(id) { return state.campaigns.find((item) => item.id === id); }
function accountById(id) { return accounts.find((item) => item.id === id); }
function connectedAccounts() { return accounts.filter((item) => item.status === "connected"); }
function campaignContacts(id) { return state.contacts.filter((contact) => contact.campaignId === id); }
function campaignJobs(id) { return state.queue.filter((job) => job.campaignId === id); }
function defaultConfig() { return { type: "text", text: "", mediaPath: "", footer: "", buttonText: "JOIN NOW", buttonUrl: "", linkFallback: true, min: 15, max: 30 }; }

function normalizeState(value) {
  value.campaigns = Array.isArray(value.campaigns) ? value.campaigns : [];
  value.queue = Array.isArray(value.queue) ? value.queue : [];
  value.history = Array.isArray(value.history) ? value.history : [];
  value.importStats = { ...initial.importStats, ...(value.importStats || {}) };
  value.warming = { ...defaultWarming(), ...(value.warming || {}) };
  value.numberFilter = { ...defaultNumberFilter(), ...(value.numberFilter || {}) };
  value.numberFilter.items = Array.isArray(value.numberFilter.items) ? value.numberFilter.items.map((item) => ({ ...item, selected: Boolean(item.selected), status: ["unchecked", "checking", "registered", "not_registered", "failed"].includes(item.status) ? item.status : "unchecked" })) : [];
  value.numberFilter.accountIds = Array.isArray(value.numberFilter.accountIds) ? value.numberFilter.accountIds : [];
  value.numberFilter.accountProgress = value.numberFilter.accountProgress && typeof value.numberFilter.accountProgress === "object" ? value.numberFilter.accountProgress : {};
  if (value.numberFilter.status === "running") {
    value.numberFilter.status = "paused";
    value.numberFilter.pauseReason = "The application was reopened. Press Resume Filter to continue.";
    value.numberFilter.items.forEach((item) => { if (item.status === "checking") item.status = "unchecked"; });
  }
  const legacyMessageIndex = Math.max(0, Math.floor(Number(value.warming.messageIndex) || 0));
  if (legacyMessageIndex > 0) {
    const legacyMessages = String(value.warming.messages || "").split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
    value.warming.initialMessageCount = Math.max(Number(value.warming.initialMessageCount) || 0, legacyMessages.length);
    value.warming.messages = legacyMessages.slice(legacyMessageIndex).join("\n");
    value.warming.messageIndex = 0;
  }
  value.warming.accountIds = Array.isArray(value.warming.accountIds) ? value.warming.accountIds : [];
  value.warming.accountProgress = value.warming.accountProgress && typeof value.warming.accountProgress === "object" ? value.warming.accountProgress : {};
  value.warming.delayedAcks = value.warming.delayedAcks && typeof value.warming.delayedAcks === "object" ? value.warming.delayedAcks : {};
  value.warming.logs = Array.isArray(value.warming.logs) ? value.warming.logs.slice(-250) : [];
  if (value.warming.status === "running") {
    value.warming.status = "paused";
    value.warming.pauseReason = "The application was reopened. Review the session and press Resume.";
    value.warming.nextActivityAt = 0;
  }
  value.contacts = (value.contacts || []).map((contact) => ({ ...contact, selected: Boolean(contact.selected), campaignId: contact.campaignId || null, deliveryStatus: contact.deliveryStatus || (contact.campaignId ? "waiting" : "available") }));
  const legacy = new Map();
  for (const job of value.queue) {
    if (!job.campaignId) {
      const name = job.campaign || "Imported Campaign";
      let campaign = legacy.get(name) || value.campaigns.find((item) => item.name === name);
      if (!campaign) {
        campaign = { id: newId(), name, status: "paused", createdAt: Date.now(), updatedAt: Date.now(), accountId: job.accountId || null, config: { ...defaultConfig(), ...(job.payload || {}), min: job.min || 15, max: job.max || 30 }, pauseReason: "Imported from version 2.x" };
        value.campaigns.push(campaign); legacy.set(name, campaign);
      }
      let contact = value.contacts.find((item) => item.phone === job.phone);
      if (!contact) {
        contact = { id: newId(), name: job.name || "", phone: job.phone, var1: "", var2: "", selected: false, campaignId: campaign.id, deliveryStatus: "waiting" };
        value.contacts.push(contact);
      }
      if (!contact.campaignId) contact.campaignId = campaign.id;
      job.campaignId = campaign.id;
      job.contactId = contact.id;
    }
    if (job.status === "sending") job.status = "unconfirmed";
    const contact = value.contacts.find((item) => item.id === job.contactId || item.phone === job.phone);
    if (contact && contact.campaignId === job.campaignId) contact.deliveryStatus = job.status === "sent" ? "sent" : job.status === "failed" ? "failed" : job.status === "unconfirmed" ? "unconfirmed" : "waiting";
  }
  value.campaigns = value.campaigns.map((campaign) => ({ ...campaign, status: campaign.status || "ready", config: { ...defaultConfig(), ...(campaign.config || {}) }, pauseReason: campaign.pauseReason || "" }));
  return value;
}

function loadState() {
  try { return normalizeState({ ...structuredClone(initial), ...JSON.parse(localStorage.getItem("neuron-v2-state")) }); }
  catch { return structuredClone(initial); }
}
function persist() { localStorage.setItem("neuron-v2-state", JSON.stringify(state)); }
function save() { persist(); renderAll(); }

function go(page) {
  if (!licenseState.valid && page !== "license") { toast("Activate the license to unlock this feature"); page = "license"; }
  $$(".page").forEach((el) => el.classList.remove("active"));
  $$(".nav-item").forEach((el) => el.classList.remove("active"));
  $("#page-" + page)?.classList.add("active");
  $(`.nav-item[data-page="${page}"]`)?.classList.add("active");
  $("#pageTitle").textContent = pageText[page][0];
  $("#pageSubtitle").textContent = pageText[page][1];
}
function applyLicenseState(result) {
  licenseState = { ...licenseState, ...(result || {}) };
  const valid = Boolean(licenseState.valid);
  $("#licensePanelStatus").textContent = licenseState.message || (valid ? "License active." : "License inactive.");
  $("#licensePanelStatus").className = `license-status ${valid ? "valid" : "invalid"}`;
  $("#licenseStateTag").textContent = valid ? "Active" : "Inactive";
  $("#licenseStateTag").className = `license-chip ${valid ? "active" : "inactive"}`;
  $("#licenseBadge").textContent = valid ? "✓" : "!";
  $("#licenseDeviceName").textContent = licenseState.deviceName || "—";
  $("#licenseMachineId").textContent = licenseState.machineId ? `${licenseState.machineId.slice(0, 14)}…${licenseState.machineId.slice(-10)}` : "—";
  $("#licenseMachineId").title = licenseState.machineId || "";
  $("#licenseExpires").textContent = licenseState.expires || "No expiry supplied";
  $("#activateLicenseButton").disabled = valid;
  $("#licenseKeyInput").disabled = valid;
  $$(".nav-item").forEach((button) => { if (button.dataset.page !== "license") { button.classList.toggle("locked", !valid); button.setAttribute("aria-disabled", String(!valid)); } });
  if (!valid) {
    accounts = [];
    $("#globalDot").classList.remove("connected");
    $("#globalStatus").textContent = "License required";
  }
}
async function loadLicensedAccounts() { accounts = await window.neuron.listAccounts(); renderAll(); }
function setTheme(theme) {
  state.theme = theme;
  document.body.classList.toggle("dark", theme === "dark");
  $("#themeToggle").textContent = theme === "dark" ? "☀" : "☾";
  $("#themeSelect").value = theme;
  window.neuron.setTheme(theme);
  persist();
}
function statusLabel(status) { return ({ qr: "Scan QR", connected: "Connected", connecting: "Connecting", reconnecting: "Reconnecting", disconnected: "Disconnected", logged_out: "Logged out" })[status] || status; }
function formatPhone(phone) { const digits = String(phone || ""); return digits.length > 8 ? `+${digits.slice(0, 4)}••••${digits.slice(-4)}` : digits || "Number unavailable"; }

function campaignCounts(id) {
  const contacts = campaignContacts(id);
  const count = (status) => contacts.filter((item) => item.deliveryStatus === status).length;
  const waiting = count("waiting");
  const sending = count("sending");
  const unconfirmed = count("unconfirmed");
  const sent = count("sent");
  const failed = count("failed");
  const skipped = count("skipped");
  return { total: contacts.length, waiting, sending, unconfirmed, sent, failed, skipped, remaining: waiting + sending + unconfirmed };
}
function accountCampaign(accountId, excludeId = null) {
  return state.campaigns.find((campaign) => campaign.id !== excludeId && campaign.accountId === accountId && ["running", "paused"].includes(campaign.status) && campaignCounts(campaign.id).remaining > 0);
}
function accountWarming(accountId) {
  return ["running", "paused"].includes(state.warming.status) && state.warming.accountIds.includes(accountId);
}
function accountFiltering(accountId) {
  return ["running", "paused"].includes(state.numberFilter.status)
    && state.numberFilter.accountIds.includes(accountId)
    && state.numberFilter.items.some((item) => ["unchecked", "checking", "failed"].includes(item.status));
}

function renderAccounts() {
  $("#accountsGrid").innerHTML = accounts.map((account) => {
    const work = accountCampaign(account.id);
    const warming = accountWarming(account.id);
    const filtering = accountFiltering(account.id);
    const reconnecting = account.status === "reconnecting" || account.status === "connecting";
    const diagnostic = account.lastDisconnectReason ? `<div class="connection-diagnostic"><strong>${escapeHtml(account.lastDisconnectReason)}</strong>${account.lastDisconnectCode ? `<span>Code ${escapeHtml(account.lastDisconnectCode)}</span>` : ""}${reconnecting && account.reconnectAttempt ? `<span>Retry ${account.reconnectAttempt}${account.nextReconnectAt ? ` in ${formatCountdown(account.nextReconnectAt)}` : ""}</span>` : ""}</div>` : "";
    return `<article class="account-card" data-id="${account.id}"><div class="account-top"><div class="account-avatar">${escapeHtml(account.name.slice(0, 1).toUpperCase())}</div><div class="account-name"><strong>${escapeHtml(account.name)}</strong><small>${escapeHtml(account.phone || "Waiting for login")}</small></div><span class="status-pill ${account.status}">${statusLabel(account.status)}</span></div><div class="account-meta"><span>${work ? escapeHtml(work.name) : warming ? "Account Warming" : filtering ? "WA Number Filter" : "Account usage"}</span><strong>${work ? `${campaignCounts(work.id).remaining} remaining` : warming ? `${state.warming.accountProgress[account.id]?.sent || 0}/${state.warming.maxMessages} sent` : filtering ? `${state.numberFilter.accountProgress[account.id]?.checked || 0} checked` : reconnecting ? "Recovering connection" : "Available"}</strong></div>${diagnostic}<div class="account-actions">${!reconnecting && account.status !== "connected" ? `<button class="primary" data-account-action="connect">${account.status === "qr" ? "Show QR" : "Connect / Scan QR"}</button>` : ""}<button class="secondary" data-account-action="rename">Rename</button>${account.status === "connected" ? `<button class="secondary" data-account-action="logout">Logout</button>` : ""}<button class="danger-text" data-account-action="delete">Delete</button></div></article>`;
  }).join("");
  $("#accountsEmpty").style.display = accounts.length ? "none" : "block";
  const count = connectedAccounts().length;
  $("#accountBadge").textContent = count;
  $("#globalDot").classList.toggle("connected", count > 0);
  $("#globalStatus").textContent = count ? `${count} account${count > 1 ? "s" : ""} connected` : "No account connected";
}

function visibleContacts() {
  const query = $("#contactSearch").value.toLowerCase();
  const view = $("#contactView").value;
  return state.contacts.filter((contact) => (view === "all" || !contact.campaignId) && `${contact.name} ${contact.phone}`.toLowerCase().includes(query));
}
function readBatchQuantity() {
  const raw = $("#batchQuantity").value.trim();
  if (!raw) return null;
  const quantity = Math.floor(Number(raw));
  return Number.isFinite(quantity) && quantity >= 1 ? quantity : null;
}
function updateBatchButton() {
  const quantity = readBatchQuantity();
  $("#selectBatch").textContent = quantity ? `Select ${quantity.toLocaleString()} Contacts` : "Enter Number to Select";
  $("#selectBatch").disabled = !quantity;
}
function renderContacts() {
  const allRows = visibleContacts();
  const rows = allRows.slice(0, 1000);
  $("#contactsBody").innerHTML = rows.map((contact) => {
    const campaign = campaignById(contact.campaignId);
    const available = !contact.campaignId;
    return `<tr><td><input class="contact-check" type="checkbox" data-id="${contact.id}" ${contact.selected ? "checked" : ""} ${available ? "" : "disabled"}></td><td>${escapeHtml(contact.name || "Unnamed")}</td><td>${escapeHtml(contact.phone)}</td><td>${escapeHtml(campaign?.name || "—")}</td><td><span class="badge ${contact.deliveryStatus}">${escapeHtml(contact.deliveryStatus)}</span></td><td>${available ? `<button class="danger-text delete-contact" data-id="${contact.id}">Delete</button>` : "Assigned"}</td></tr>`;
  }).join("");
  $("#contactsEmpty").style.display = allRows.length ? "none" : "block";
  $("#contactsEmpty").textContent = allRows.length > rows.length ? `Showing the first ${rows.length.toLocaleString()} of ${allRows.length.toLocaleString()} matching contacts. Use search to narrow the list.` : "No contacts in this view.";
  $("#contactsEmpty").style.display = allRows.length > rows.length || !allRows.length ? "block" : "none";
  const available = state.contacts.filter((item) => !item.campaignId);
  const selected = available.filter((item) => item.selected);
  $("#contactTotal").textContent = state.contacts.length.toLocaleString();
  $("#contactAvailable").textContent = available.length.toLocaleString();
  $("#contactAssigned").textContent = (state.contacts.length - available.length).toLocaleString();
  $("#contactInvalid").textContent = state.importStats.invalid.toLocaleString();
  $("#contactDuplicates").textContent = state.importStats.duplicates.toLocaleString();
  $("#contactSelected").textContent = selected.length.toLocaleString();
  $("#selectionCount").textContent = `${selected.length.toLocaleString()} selected`;
  const selectable = rows.filter((item) => !item.campaignId);
  $("#selectAll").checked = Boolean(selectable.length) && selectable.every((item) => item.selected);
  $("#selectAll").indeterminate = selectable.some((item) => item.selected) && !selectable.every((item) => item.selected);
  updateBatchButton();
}

function filterCounts() {
  const items = state.numberFilter.items;
  const count = (status) => items.filter((item) => item.status === status).length;
  return { total: items.length, unchecked: count("unchecked"), checking: count("checking"), registered: count("registered"), notRegistered: count("not_registered"), failed: count("failed"), selected: items.filter((item) => item.selected && item.status === "registered").length };
}
function visibleFilterItems() {
  const query = $("#filterSearch").value.trim().toLowerCase();
  const view = $("#filterView").value;
  return state.numberFilter.items.filter((item) => (view === "all" || item.status === view) && `${item.name || ""} ${item.phone}`.toLowerCase().includes(query));
}
function renderFilterAccounts() {
  const filter = state.numberFilter;
  const locked = filter.status === "running";
  $("#filterAccounts").innerHTML = accounts.map((account) => {
    const selected = filter.accountIds.includes(account.id);
    const campaign = accountCampaign(account.id);
    const warming = accountWarming(account.id);
    const unavailable = account.status !== "connected" || Boolean(campaign) || warming;
    const disabled = locked || (unavailable && !selected);
    const progress = filter.accountProgress[account.id] || {};
    const note = campaign ? `Busy: ${campaign.name}` : warming ? "Busy: Account Warming" : account.status !== "connected" ? statusLabel(account.status) : `${progress.checked || 0} checked`;
    return `<label class="warming-account-option ${disabled && !selected ? "busy" : ""}"><input class="filter-account-check" type="checkbox" data-id="${account.id}" ${selected ? "checked" : ""} ${disabled ? "disabled" : ""}><div><strong>${escapeHtml(account.name)}</strong><small>${escapeHtml(formatPhone(account.phone))}</small></div><span>${escapeHtml(note)}</span></label>`;
  }).join("") || `<div class="empty">Connect a WhatsApp account first.</div>`;
}
function renderFilterSummary() {
  const filter = state.numberFilter;
  const counts = filterCounts();
  $("#filterTotal").textContent = counts.total.toLocaleString();
  $("#filterUnchecked").textContent = counts.unchecked.toLocaleString();
  $("#filterRegistered").textContent = counts.registered.toLocaleString();
  $("#filterNotRegistered").textContent = counts.notRegistered.toLocaleString();
  $("#filterFailed").textContent = counts.failed.toLocaleString();
  $("#filterSelected").textContent = counts.selected.toLocaleString();
  $("#filterSelectionCount").textContent = `${counts.selected.toLocaleString()} selected`;
  $("#filterBadge").textContent = counts.total.toLocaleString();
  const processed = counts.registered + counts.notRegistered + counts.failed;
  $("#filterProgress").innerHTML = `<div><span>Status</span><strong>${escapeHtml(filter.status)}</strong></div><div><span>Processed</span><strong>${processed.toLocaleString()} / ${counts.total.toLocaleString()}</strong></div><div><span>Registered</span><strong>${counts.registered.toLocaleString()}</strong></div><div><span>Remaining</span><strong>${(counts.unchecked + counts.checking).toLocaleString()}</strong></div>`;
  $("#filterPauseReason").textContent = filter.pauseReason || "";
  $("#filterPauseReason").classList.toggle("hidden", !filter.pauseReason);
  $("#startFilter").textContent = filter.status === "paused" ? "Resume Filter" : "Start Filter";
  $("#startFilter").disabled = filter.status === "running" || !counts.unchecked;
  $("#pauseFilter").disabled = filter.status !== "running";
  $("#stopFilter").disabled = !["running", "paused"].includes(filter.status);
}
function renderFilterTable() {
  const allRows = visibleFilterItems();
  const rows = allRows.slice(0, 1000);
  $("#filterBody").innerHTML = rows.map((item) => {
    const account = accountById(item.checkedBy);
    const canSelect = item.status === "registered";
    return `<tr><td><input class="filter-check" type="checkbox" data-id="${item.id}" ${item.selected ? "checked" : ""} ${canSelect ? "" : "disabled"}></td><td>${escapeHtml(item.name || "Unnamed")}</td><td>${escapeHtml(item.phone)}</td><td><span class="badge ${item.status}">${escapeHtml(item.status.replace("_", " "))}</span>${item.error ? `<small class="filter-error">${escapeHtml(item.error)}</small>` : ""}</td><td>${escapeHtml(account?.name || "—")}</td><td><button class="danger-text delete-filter-item" data-id="${item.id}">Delete</button></td></tr>`;
  }).join("");
  $("#filterEmpty").textContent = allRows.length > rows.length ? `Showing the first ${rows.length.toLocaleString()} of ${allRows.length.toLocaleString()} matching numbers. Use search or status filters to narrow the list.` : "No numbers in the filter staging list.";
  $("#filterEmpty").style.display = allRows.length > rows.length || !allRows.length ? "block" : "none";
  const selectable = allRows.filter((item) => item.status === "registered");
  $("#selectAllFiltered").checked = Boolean(selectable.length) && selectable.every((item) => item.selected);
  $("#selectAllFiltered").indeterminate = selectable.some((item) => item.selected) && !selectable.every((item) => item.selected);
}
function renderFilter() { renderFilterAccounts(); renderFilterSummary(); renderFilterTable(); }

function campaignOptions(includeEmpty = true) {
  const items = includeEmpty ? state.campaigns : state.campaigns.filter((campaign) => campaignCounts(campaign.id).total > 0);
  return items.map((campaign) => `<option value="${campaign.id}">${escapeHtml(campaign.name)} — ${campaignCounts(campaign.id).remaining} remaining</option>`).join("");
}
function renderCampaignSelectors() {
  const assigned = $("#assignCampaign").value;
  $("#assignCampaign").innerHTML = state.campaigns.length ? campaignOptions(true) : `<option value="">Create a campaign first</option>`;
  if (state.campaigns.some((item) => item.id === assigned)) $("#assignCampaign").value = assigned;
  const selected = $("#sendingCampaign").value;
  $("#sendingCampaign").innerHTML = state.campaigns.length ? campaignOptions(true) : `<option value="">No campaign available</option>`;
  if (state.campaigns.some((item) => item.id === selected)) $("#sendingCampaign").value = selected;
  else if (state.campaigns[0]) $("#sendingCampaign").value = state.campaigns[0].id;
}
function renderCampaigns() {
  $("#campaignGrid").innerHTML = state.campaigns.map((campaign) => {
    const c = campaignCounts(campaign.id);
    const account = accountById(campaign.accountId);
    return `<article class="campaign-card" data-id="${campaign.id}"><div class="campaign-card-head"><div><span class="badge ${campaign.status}">${escapeHtml(campaign.status)}</span><h3>${escapeHtml(campaign.name)}</h3></div><strong>${c.remaining} remaining</strong></div><div class="campaign-metrics"><span>Total<b>${c.total}</b></span><span>Sent<b>${c.sent}</b></span><span>Failed<b>${c.failed}</b></span><span>Skipped<b>${c.skipped}</b></span><span>Unconfirmed<b>${c.unconfirmed}</b></span></div><p>${account ? `${escapeHtml(formatPhone(account.phone))} · ${escapeHtml(account.name)}` : "No account assigned"}</p>${campaign.pauseReason ? `<div class="pause-reason">${escapeHtml(campaign.pauseReason)}</div>` : ""}<div class="account-actions"><button class="primary" data-campaign-action="send">Open Sending</button><button class="secondary" data-campaign-action="rename">Rename</button><button class="danger-text" data-campaign-action="delete">Delete</button></div></article>`;
  }).join("");
  $("#campaignEmpty").style.display = state.campaigns.length ? "none" : "block";
  $("#campaignBadge").textContent = state.campaigns.length;
}

function renderHistory() {
  $("#historyBody").innerHTML = state.history.slice(-1000).reverse().map((item) => `<tr><td>${new Date(item.time).toLocaleString()}</td><td>${escapeHtml(item.campaign)}</td><td>${escapeHtml(item.accountName)}</td><td>${escapeHtml(item.phone)}</td><td><span class="badge ${item.status}">${escapeHtml(item.status)}</span></td><td>${escapeHtml(item.note || "—")}</td></tr>`).join("");
  $("#historyEmpty").style.display = state.history.length ? "none" : "block";
}
function renderStats() {
  $("#statAccounts").textContent = connectedAccounts().length;
  $("#statContacts").textContent = state.contacts.filter((item) => !item.campaignId).length.toLocaleString();
  $("#statCampaigns").textContent = state.campaigns.length;
  $("#statSent").textContent = state.history.filter((item) => item.status === "sent").length.toLocaleString();
  $("#statFailed").textContent = state.history.filter((item) => item.status === "failed").length.toLocaleString();
  const recent = state.history.slice(-5).reverse();
  $("#recentActivity").innerHTML = recent.length ? recent.map((item) => `<div class="activity-row"><strong>${escapeHtml(item.campaign)}</strong> · ${escapeHtml(item.accountName)} → ${escapeHtml(item.phone)} <span class="badge ${item.status}">${escapeHtml(item.status)}</span></div>`).join("") : "No activity yet.";
}
function renderActiveProcesses() {
  const processes = [];
  for (const campaign of state.campaigns.filter((item) => ["running", "paused"].includes(item.status) && campaignCounts(item.id).remaining > 0)) {
    const counts = campaignCounts(campaign.id);
    const account = accountById(campaign.accountId);
    const finished = counts.sent + counts.failed + counts.skipped;
    const percent = counts.total ? Math.min(100, Math.round(finished / counts.total * 100)) : 0;
    processes.push({
      type: "campaign", id: campaign.id, status: campaign.status, icon: "C", title: campaign.name,
      subtitle: account ? `${account.name} · ${formatPhone(account.phone)}` : "No sending account assigned",
      progress: percent, left: `${counts.remaining} remaining`, detail: `${finished}/${counts.total} processed`
    });
  }
  const filterCountsValue = filterCounts();
  if (["running", "paused"].includes(state.numberFilter.status) && (filterCountsValue.unchecked + filterCountsValue.checking + filterCountsValue.failed)) {
    const processed = filterCountsValue.registered + filterCountsValue.notRegistered + filterCountsValue.failed;
    const percent = filterCountsValue.total ? Math.min(100, Math.round(processed / filterCountsValue.total * 100)) : 0;
    processes.push({
      type: "filter", id: "filter", status: state.numberFilter.status, icon: "F", title: "WhatsApp Number Filter",
      subtitle: `${state.numberFilter.accountIds.length} session${state.numberFilter.accountIds.length === 1 ? "" : "s"} selected`, progress: percent,
      left: `${filterCountsValue.unchecked + filterCountsValue.checking} remaining`, detail: `${processed}/${filterCountsValue.total} checked`
    });
  }
  const warming = state.warming;
  if (["running", "paused"].includes(warming.status) && warming.accountIds.length) {
    const messages = warmingMessages();
    const total = Math.max(Number(warming.initialMessageCount) || 0, messages.length);
    const processed = Math.max(0, total - messages.length);
    const percent = total ? Math.min(100, Math.round(processed / total * 100)) : 0;
    processes.push({
      type: "warming", id: "warming", status: warming.status, icon: "W", title: warming.groupName || "Account Warming",
      subtitle: `${warming.accountIds.length} account${warming.accountIds.length === 1 ? "" : "s"} selected`, progress: percent,
      left: warming.status === "running" && warming.nextActivityAt ? `Next in ${formatCountdown(warming.nextActivityAt)}` : `${messages.length} messages left`,
      detail: `${processed}/${total} processed`
    });
  }
  $("#activeProcesses").innerHTML = processes.map((process) => `<article class="process-card"><div class="process-icon">${process.icon}</div><div class="process-copy"><div class="process-title"><strong>${escapeHtml(process.title)}</strong><span class="badge ${process.status}">${escapeHtml(process.status)}</span></div><small>${escapeHtml(process.subtitle)}</small><progress class="process-progress" max="100" value="${process.progress}">${process.progress}%</progress><div class="process-meta"><span>${escapeHtml(process.detail)}</span><span>${escapeHtml(process.left)}</span></div></div><button class="secondary process-open" data-process-type="${process.type}" data-process-id="${process.id}">Open</button></article>`).join("");
  $("#activeProcessesEmpty").style.display = processes.length ? "none" : "block";
  const running = processes.filter((item) => item.status === "running").length;
  const paused = processes.length - running;
  $("#activeProcessCount").textContent = processes.length ? `${running} running${paused ? ` · ${paused} paused` : ""}` : "0 active";
  $("#activeProcessCount").classList.toggle("running", running > 0);
  syncUpdateBusy();
}

function renderSendingPanel() {
  const campaign = campaignById($("#sendingCampaign").value);
  const previous = $("#sendingAccount").value || campaign?.accountId || "";
  if (!campaign) {
    $("#sendingAccount").innerHTML = `<option value="">No connected account</option>`;
    $("#campaignProgress").innerHTML = `<div><span>Status</span><strong>No campaign selected</strong></div>`;
    return;
  }
  const options = connectedAccounts().map((account) => {
    const busy = accountCampaign(account.id, campaign.id);
    const warming = accountWarming(account.id);
    const filtering = accountFiltering(account.id);
    return `<option value="${account.id}" ${busy || warming || filtering ? "disabled" : ""}>${escapeHtml(formatPhone(account.phone))} · ${escapeHtml(account.name)}${busy ? ` — ${escapeHtml(busy.name)} (${campaignCounts(busy.id).remaining} remaining)` : warming ? " — Account Warming" : filtering ? " — WA Filter" : " — available"}</option>`;
  }).join("");
  $("#sendingAccount").innerHTML = options || `<option value="">No connected account</option>`;
  if (connectedAccounts().some((item) => item.id === previous && !accountCampaign(item.id, campaign.id) && !accountWarming(item.id) && !accountFiltering(item.id))) $("#sendingAccount").value = previous;
  const c = campaignCounts(campaign.id);
  const selectedAccount = accountById($("#sendingAccount").value);
  $("#accountAvailability").textContent = selectedAccount ? `${selectedAccount.name} · ${formatPhone(selectedAccount.phone)}` : "Connect or free an account before starting.";
  $("#campaignProgress").innerHTML = `<div><span>Status</span><strong>${escapeHtml(campaign.status)}</strong></div><div><span>Waiting</span><strong>${c.waiting}</strong></div><div><span>Sent</span><strong>${c.sent}</strong></div><div><span>Remaining</span><strong>${c.remaining}</strong></div><div><span>Failed</span><strong>${c.failed}</strong></div><div><span>Skipped</span><strong>${c.skipped}</strong></div><div><span>Unconfirmed</span><strong>${c.unconfirmed}</strong></div>`;
  $("#pauseReason").textContent = campaign.pauseReason || "";
  $("#pauseReason").classList.toggle("hidden", !campaign.pauseReason);
  $("#unconfirmedActions").classList.toggle("hidden", c.unconfirmed === 0);
  $$("#unconfirmedActions button").forEach((button) => { button.disabled = campaignRunners.has(campaign.id); });
  $("#startCampaign").textContent = campaign.status === "paused" || campaign.status === "stopped" ? `Resume ${c.waiting} Remaining` : `Start ${c.waiting} Messages`;
  $("#pauseCampaign").disabled = campaign.status !== "running";
}
function warmingMessages() { return String(state.warming.messages || "").split(/\r?\n/).map((item) => item.trim()).filter(Boolean); }
function consumeFirstWarmingMessage(messages = warmingMessages()) { const sent = messages[0] || ""; state.warming.messages = messages.slice(1).join("\n"); state.warming.messageIndex = 0; return sent; }
function warmingGroupForAccount(accountId) { return warmingGroups.find((group) => group.id === state.warming.groupId)?.accountIds?.includes(accountId) || false; }
function formatCountdown(timestamp) {
  const seconds = Math.max(0, Math.ceil((Number(timestamp) - Date.now()) / 1000));
  if (!seconds) return "—";
  const minutes = Math.floor(seconds / 60);
  return minutes ? `${minutes}m ${seconds % 60}s` : `${seconds}s`;
}
function renderWarming() {
  const warming = state.warming;
  const messages = warmingMessages();
  const currentGroup = warmingGroups.find((item) => item.id === warming.groupId);
  const options = warmingGroups.map((group) => `<option value="${group.id}">${escapeHtml(group.name)} — ${group.accountIds.length} account${group.accountIds.length === 1 ? "" : "s"}</option>`).join("");
  $("#warmingGroup").innerHTML = options || (warming.groupId ? `<option value="${warming.groupId}">${escapeHtml(warming.groupName || warming.groupId)} — refresh to verify</option>` : `<option value="">Refresh groups to begin</option>`);
  $("#warmingGroup").value = warming.groupId || "";
  $("#warmingGroupInfo").textContent = currentGroup ? `${currentGroup.participants || 0} participants · available to ${currentGroup.accountIds.length} selected/connected account(s)` : "Refresh groups to verify access for each account.";
  if (document.activeElement !== $("#warmingMessages")) $("#warmingMessages").value = warming.messages;
  $("#warmingMessageCount").textContent = `${messages.length.toLocaleString()} messages`;
  const numericSettings = { warmingMaxMessages: warming.maxMessages, warmingDelayMin: warming.delayMin, warmingDelayMax: warming.delayMax, warmingCooldownMin: warming.cooldownMin, warmingCooldownMax: warming.cooldownMax, warmingReplyChance: warming.replyChance, warmingReadChance: warming.readChance, warmingIdleRead: warming.idleRead };
  for (const [id, value] of Object.entries(numericSettings)) {
    const input = document.getElementById(id);
    if (document.activeElement !== input) input.value = value;
  }
  $("#warmingAccounts").innerHTML = accounts.map((account) => {
    const campaign = accountCampaign(account.id);
    const checked = warming.accountIds.includes(account.id);
    const unavailable = account.status !== "connected" || Boolean(campaign) || accountFiltering(account.id);
    const disabled = warming.status === "running" || (unavailable && !checked);
    const note = campaign ? `Busy: ${campaign.name}` : accountFiltering(account.id) ? "Busy: WA Filter" : account.status !== "connected" ? statusLabel(account.status) : warmingGroups.length && warming.groupId && !warmingGroupForAccount(account.id) ? "Not in group" : "Available";
    return `<label class="warming-account-option ${disabled && !checked ? "busy" : ""}"><input class="warming-account-check" type="checkbox" data-id="${account.id}" ${checked ? "checked" : ""} ${disabled ? "disabled" : ""}><div><strong>${escapeHtml(account.name)}</strong><small>${escapeHtml(formatPhone(account.phone))}</small></div><span>${escapeHtml(note)}</span></label>`;
  }).join("") || `<div class="empty">Connect a WhatsApp account first.</div>`;
  const selected = warming.accountIds.map(accountById).filter(Boolean);
  $("#warmingProgressBody").innerHTML = selected.map((account) => {
    const progress = warming.accountProgress[account.id] || { sent: 0, cooldownUntil: 0, status: "ready" };
    const access = warmingGroups.length ? warmingGroupForAccount(account.id) : null;
    let status = progress.status || "ready";
    if (account.status !== "connected") status = "offline";
    else if ((progress.sent || 0) >= warming.maxMessages) status = "completed";
    else if ((progress.cooldownUntil || 0) > Date.now()) status = "cooldown";
    return `<tr><td>${escapeHtml(account.name)}</td><td>${escapeHtml(formatPhone(account.phone))}</td><td>${access === null ? "Not checked" : access ? "Yes" : "No"}</td><td>${progress.sent || 0} / ${warming.maxMessages}</td><td><span class="badge ${status}">${escapeHtml(status)}</span></td><td>${formatCountdown(progress.cooldownUntil)}</td></tr>`;
  }).join("");
  const sent = Object.values(warming.accountProgress).reduce((total, item) => total + (Number(item.sent) || 0), 0);
  $("#warmingStatus").textContent = warming.status[0].toUpperCase() + warming.status.slice(1);
  $("#warmingSelectedCount").textContent = selected.length;
  $("#warmingSentCount").textContent = sent.toLocaleString();
  $("#warmingRemainingCount").textContent = messages.length.toLocaleString();
  $("#warmingNextActivity").textContent = warming.status === "running" ? formatCountdown(warming.nextActivityAt) : "—";
  $("#warmingPauseReason").textContent = warming.pauseReason || "";
  $("#warmingPauseReason").classList.toggle("hidden", !warming.pauseReason);
  $("#warmingActivity").innerHTML = warming.logs.length ? warming.logs.slice().reverse().map((log) => `<div class="warming-log-row ${escapeHtml(log.level)}"><time>${new Date(log.time).toLocaleTimeString()}</time><b>${escapeHtml(log.level.toUpperCase())}</b><span>${escapeHtml(log.message)}</span></div>`).join("") : "No warming activity yet.";
  $("#startWarming").textContent = warming.status === "paused" ? "Resume Warming" : "Start Warming";
  $("#startWarming").disabled = warming.status === "running";
  $("#pauseWarming").disabled = warming.status !== "running";
  $("#stopWarming").disabled = !["running", "paused", "completed"].includes(warming.status);
  const locked = warming.status === "running";
  ["#warmingGroup", "#warmingMessages", "#importWarmingMessages", "#warmingMaxMessages", "#warmingDelayMin", "#warmingDelayMax", "#warmingCooldownMin", "#warmingCooldownMax", "#warmingReplyChance", "#warmingReadChance", "#warmingIdleRead", "#refreshWarmingGroups"].forEach((selector) => { $(selector).disabled = locked; });
}
function renderAll() {
  renderAccounts(); renderContacts(); renderFilter(); renderCampaignSelectors(); renderCampaigns(); renderHistory(); renderStats(); renderActiveProcesses(); renderSendingPanel(); renderWarming();
  $("#compactMode").checked = state.compact;
  document.body.classList.toggle("compact", state.compact);
}
function saveOperational() {
  persist();
  renderAccounts(); renderCampaignSelectors(); renderCampaigns(); renderHistory(); renderStats(); renderActiveProcesses(); renderSendingPanel();
}

function personalized(template, contact) { return String(template || "").replaceAll("{name}", contact.name || "").replaceAll("{nama}", contact.name || "").replaceAll("{phone}", contact.phone).replaceAll("{nomor}", contact.phone).replaceAll("{var1}", contact.var1 || "").replaceAll("{var2}", contact.var2 || ""); }
function resolveSpintax(template, random = Math.random) {
  let result = String(template || ""); const patterns = [/\[\[([^\[\]]*\|[^\[\]]*)\]\]/g, /\{([^{}]*\|[^{}]*)\}/g];
  for (const pattern of patterns) for (let depth = 0; depth < 20 && pattern.test(result); depth++) { pattern.lastIndex = 0; result = result.replace(pattern, (_, value) => { const choices = value.split("|"); return choices[Math.floor(random() * choices.length)]; }); pattern.lastIndex = 0; }
  return result;
}
function readConfig() { return { type: $("#messageType").value, text: $("#messageText").value, mediaPath: $("#mediaPath").value, footer: $("#messageFooter").value, buttonText: $("#buttonText").value.trim() || "JOIN NOW", buttonUrl: $("#buttonUrl").value.trim(), linkFallback: $("#linkFallback").checked, min: Math.max(5, +$("#delayMin").value || 15), max: Math.max(5, +$("#delayMax").value || 30) }; }
function writeConfig(config) { const c = { ...defaultConfig(), ...(config || {}) }; $("#messageType").value = c.type; $("#messageText").value = c.text; $("#mediaPath").value = c.mediaPath; $("#messageFooter").value = c.footer; $("#buttonText").value = c.buttonText; $("#buttonUrl").value = c.buttonUrl; $("#linkFallback").checked = c.linkFallback; $("#delayMin").value = c.min; $("#delayMax").value = c.max; updateComposer(); }
function saveDraft() { const campaign = campaignById($("#sendingCampaign").value); if (!campaign) return; campaign.config = readConfig(); persist(); }
function updateDelayExplanation() { const min = Math.max(5, Number($("#delayMin").value) || 15); const max = Math.max(min, Number($("#delayMax").value) || 30); $("#delayExplanation").textContent = `Random interval: ${humanizeSeconds(min)} to ${humanizeSeconds(max)} between recipients.`; }
function updateComposer() { const type = $("#messageType").value; const hasMedia = ["image", "video", "document", "cta"].includes(type); $("#mediaFields").classList.toggle("hidden", !hasMedia); $("#ctaFields").classList.toggle("hidden", type !== "cta"); $("#previewMedia").style.display = hasMedia ? "grid" : "none"; $("#previewMedia").textContent = type === "document" ? "DOCUMENT" : type.toUpperCase(); $("#previewText").textContent = resolveSpintax($("#messageText").value, () => 0) || "Your message preview will appear here."; $("#previewFooter").textContent = type === "cta" ? resolveSpintax($("#messageFooter").value, () => 0) : ""; $("#previewButton").textContent = `↗ ${resolveSpintax($("#buttonText").value, () => 0) || "JOIN NOW"}`; $("#previewButton").classList.toggle("hidden", type !== "cta"); updateDelayExplanation(); }
function payloadFor(config, contact) { let text = resolveSpintax(personalized(config.text, contact)); const buttonUrl = personalized(config.buttonUrl, contact); if (config.type === "cta" && config.linkFallback && buttonUrl && !text.includes(buttonUrl)) text += `\n\n${buttonUrl}`; return { type: config.type, text, mediaPath: config.mediaPath, footer: resolveSpintax(personalized(config.footer, contact)), buttonText: resolveSpintax(config.buttonText), buttonUrl }; }

function openCampaignDialog() { $("#newCampaignName").value = `Campaign ${state.campaigns.length + 1}`; $("#campaignDialog").showModal(); }
function createCampaign(name) { const campaign = { id: newId(), name: String(name).trim().slice(0, 80), status: "ready", createdAt: Date.now(), updatedAt: Date.now(), accountId: null, config: defaultConfig(), pauseReason: "" }; state.campaigns.push(campaign); save(); return campaign; }
function addContactsFromText(text) {
  let added = 0, invalid = 0, duplicates = 0;
  for (const raw of String(text || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean)) {
    const fields = raw.split(/[,;\t]/).map((value) => value.trim());
    const firstIsPhone = /^\+?[\d\s()-]{8,}$/.test(fields[0] || "");
    const phone = cleanPhone(firstIsPhone ? fields[0] : fields[1]);
    if (phone.length < 8) { invalid++; continue; }
    if (state.contacts.some((item) => item.phone === phone)) { duplicates++; continue; }
    state.contacts.push({ id: newId(), name: firstIsPhone ? "" : fields[0], phone, var1: firstIsPhone ? fields[1] || "" : fields[2] || "", var2: firstIsPhone ? fields[2] || "" : fields[3] || "", selected: false, campaignId: null, deliveryStatus: "available" }); added++;
  }
  state.importStats.invalid += invalid; state.importStats.duplicates += duplicates; save();
  return { added, invalid, duplicates };
}

function addFilterNumbersFromText(text) {
  let added = 0, invalid = 0, duplicates = 0;
  const existing = new Set([...state.numberFilter.items.map((item) => item.phone), ...state.contacts.map((item) => item.phone)]);
  for (const raw of String(text || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean)) {
    const fields = raw.split(/[,;\t]/).map((value) => value.trim());
    const firstIsPhone = /^\+?[\d\s()-]{8,}$/.test(fields[0] || "");
    const phone = cleanPhone(firstIsPhone ? fields[0] : fields[1]);
    if (phone.length < 8) { invalid++; continue; }
    if (existing.has(phone)) { duplicates++; continue; }
    existing.add(phone);
    state.numberFilter.items.push({ id: newId(), name: firstIsPhone ? "" : fields[0], phone, var1: firstIsPhone ? fields[1] || "" : fields[2] || "", var2: firstIsPhone ? fields[2] || "" : fields[3] || "", status: "unchecked", selected: false, checkedBy: "", checkedAt: null, error: "" });
    added++;
  }
  if (added && ["completed", "stopped"].includes(state.numberFilter.status)) state.numberFilter.status = "ready";
  persist(); renderFilter();
  return { added, invalid, duplicates };
}

function isFilterRestriction(message) { return /rate|too many|429|forbidden|temporar(?:y|ily) unavailable|logged out/i.test(message); }
async function runNumberFilter() {
  if (numberFilterRunner) return;
  numberFilterRunner = true;
  let sinceTableRender = 0;
  try {
    while (state.numberFilter.status === "running") {
      const filter = state.numberFilter;
      const item = filter.items.find((entry) => entry.status === "unchecked");
      if (!item) {
        filter.status = "completed";
        filter.pauseReason = "Number checking completed.";
        persist(); renderFilter(); renderAccounts(); renderActiveProcesses();
        return;
      }
      const candidates = filter.accountIds.map(accountById).filter((account) => account?.status === "connected" && !accountCampaign(account.id) && !accountWarming(account.id));
      if (!candidates.length) {
        filter.status = "paused";
        filter.pauseReason = "No selected filter session is currently connected and available.";
        persist(); renderFilter(); renderAccounts(); renderActiveProcesses();
        return;
      }
      const account = candidates[filter.cursor % candidates.length];
      filter.cursor = (filter.cursor + 1) % Math.max(1, candidates.length);
      filter.accountProgress[account.id] ||= { checked: 0, registered: 0, failed: 0 };
      item.status = "checking"; item.checkedBy = account.id; item.error = "";
      persist(); renderFilterSummary();
      try {
        const result = await window.neuron.checkNumber({ accountId: account.id, phone: item.phone });
        item.status = result.registered ? "registered" : "not_registered";
        item.checkedAt = Date.now();
        filter.accountProgress[account.id].checked++;
        if (result.registered) filter.accountProgress[account.id].registered++;
      } catch (error) {
        const message = errorMessage(error);
        item.status = "failed"; item.error = message; item.checkedAt = Date.now();
        filter.accountProgress[account.id].failed++;
        if (isFilterRestriction(message)) {
          filter.status = "paused";
          filter.pauseReason = `${account.name}: ${message}. Filtering was paused for review.`;
        }
      }
      persist(); renderFilterSummary(); renderFilterAccounts(); renderAccounts(); renderActiveProcesses();
      sinceTableRender++;
      if (sinceTableRender >= 10 || state.numberFilter.status !== "running") { renderFilterTable(); sinceTableRender = 0; }
      if (state.numberFilter.status !== "running") return;
      await wait(750 + Math.floor(Math.random() * 501));
    }
  } finally {
    numberFilterRunner = false;
    persist(); renderFilter(); renderAccounts(); renderActiveProcesses(); renderSendingPanel(); renderWarming();
  }
}

function isAccountFailure(message) { return /disconnect|not connected|logged out|connection|acknowledge|closed|timed? out/i.test(message); }
function isAcknowledgementDelay(message) { return /acknowledge(?:ment)? is delayed|server acknowledgement/i.test(message); }
function handleCampaignSendFailure({ campaign, job, contact, account, message }) {
  if (!isAccountFailure(message)) {
    job.status = "failed";
    if (contact) contact.deliveryStatus = "failed";
    state.history.push({ time: Date.now(), campaign: campaign.name, campaignId: campaign.id, accountName: account.name, phone: job.phone, status: "failed", note: message });
    return { stop: false, outcome: "failed" };
  }
  job.status = "skipped";
  if (contact) contact.deliveryStatus = "skipped";
  state.history.push({ time: Date.now(), campaign: campaign.name, campaignId: campaign.id, accountName: account.name, phone: job.phone, status: "skipped", note: `Auto-skipped after an unconfirmed send. It was not retried to prevent a duplicate. ${message}` });
  if (isAcknowledgementDelay(message)) {
    campaign.pauseReason = "";
    return { stop: false, outcome: "skipped" };
  }
  campaign.status = "paused";
  campaign.autoResumeOnReconnect = true;
  campaign.pauseReason = `${account.name} interrupted. The uncertain message to ${job.phone} was auto-skipped. Waiting for this account to reconnect, then the campaign will continue automatically.`;
  return { stop: true, outcome: "skipped" };
}
async function runCampaign(campaignId) {
  if (campaignRunners.has(campaignId)) return;
  campaignRunners.add(campaignId);
  try {
    while (true) {
      const campaign = campaignById(campaignId);
      if (!campaign || campaign.status !== "running") return;
      const job = campaignJobs(campaignId).find((item) => item.status === "waiting");
      if (!job) {
        const c = campaignCounts(campaignId);
        if (!c.waiting && !c.sending && !c.unconfirmed) { campaign.status = "completed"; campaign.pauseReason = ""; saveOperational(); }
        return;
      }
      const account = accountById(campaign.accountId);
      if (!account || account.status !== "connected") { campaign.status = "paused"; campaign.autoResumeOnReconnect = Boolean(account && ["connecting", "reconnecting", "disconnected"].includes(account.status)); campaign.pauseReason = account?.lastDisconnectReason ? `${account.name}: ${account.lastDisconnectReason}. Waiting for recovery.` : "The sending account disconnected. Waiting for recovery or select a replacement account."; saveOperational(); return; }
      const contact = state.contacts.find((item) => item.id === job.contactId);
      job.status = "sending"; if (contact) contact.deliveryStatus = "sending"; saveOperational();
      try {
        const result = await window.neuron.sendMessage({ accountId: campaign.accountId, phone: job.phone, payload: job.payload });
        job.status = "sent"; if (contact) contact.deliveryStatus = "sent";
        state.history.push({ time: Date.now(), campaign: campaign.name, campaignId, accountName: account.name, phone: job.phone, status: "sent", note: `${job.payload.type.toUpperCase()} acknowledged (${result.messageId})` });
      } catch (error) {
        const message = errorMessage(error);
        const outcome = handleCampaignSendFailure({ campaign, job, contact, account, message });
        if (outcome.stop) { saveOperational(); return; }
      }
      saveOperational();
      const delay = Math.max(5, job.min + Math.random() * Math.max(0, job.max - job.min));
      const end = Date.now() + delay * 1000;
      while (Date.now() < end) { if (campaignById(campaignId)?.status !== "running") return; await wait(Math.min(500, end - Date.now())); }
    }
  } finally { campaignRunners.delete(campaignId); renderAccounts(); renderCampaigns(); renderHistory(); renderStats(); renderActiveProcesses(); renderSendingPanel(); }
}
function prepareCampaignJobs(campaign, account) {
  const config = campaign.config;
  for (const contact of campaignContacts(campaign.id).filter((item) => item.deliveryStatus === "waiting")) {
    let job = state.queue.find((item) => item.campaignId === campaign.id && item.contactId === contact.id && ["waiting", "sending"].includes(item.status));
    const values = { accountId: account.id, accountName: account.name, campaignId: campaign.id, campaign: campaign.name, contactId: contact.id, name: contact.name, phone: contact.phone, min: config.min, max: config.max, payload: payloadFor(config, contact) };
    if (job) Object.assign(job, values, { status: "waiting" }); else state.queue.push({ id: newId(), ...values, status: "waiting" });
  }
}

function warmingLog(level, message) {
  state.warming.logs.push({ time: Date.now(), level, message });
  if (state.warming.logs.length > 250) state.warming.logs.splice(0, state.warming.logs.length - 250);
}
function readWarmingForm() {
  const warming = state.warming;
  warming.messages = $("#warmingMessages").value;
  warming.maxMessages = Math.max(1, Math.floor(Number($("#warmingMaxMessages").value) || 20));
  warming.delayMin = Math.max(0, Number($("#warmingDelayMin").value) || 0);
  warming.delayMax = Math.max(warming.delayMin, Number($("#warmingDelayMax").value) || warming.delayMin);
  warming.cooldownMin = Math.max(0, Number($("#warmingCooldownMin").value) || 0);
  warming.cooldownMax = Math.max(warming.cooldownMin, Number($("#warmingCooldownMax").value) || warming.cooldownMin);
  warming.replyChance = Math.max(0, Math.min(100, Number($("#warmingReplyChance").value) || 0));
  warming.readChance = Math.max(0, Math.min(100, Number($("#warmingReadChance").value) || 0));
  warming.idleRead = Math.max(1, Number($("#warmingIdleRead").value) || 9);
}
function randomBetween(min, max) { return min + Math.random() * Math.max(0, max - min); }
async function refreshWarmingGroups(showToast = true) {
  const ids = connectedAccounts().map((account) => account.id);
  if (!ids.length) { if (showToast) toast("Connect a WhatsApp account first"); return; }
  $("#refreshWarmingGroups").disabled = true;
  $("#refreshWarmingGroups").textContent = "Loading…";
  try {
    const results = await window.neuron.listGroups(ids);
    const aggregate = new Map();
    for (const result of results) for (const group of result.groups || []) {
      const item = aggregate.get(group.id) || { ...group, accountIds: [] };
      item.accountIds.push(result.accountId);
      item.participants = Math.max(item.participants || 0, group.participants || 0);
      aggregate.set(group.id, item);
    }
    warmingGroups = [...aggregate.values()].sort((a, b) => a.name.localeCompare(b.name));
    if (state.warming.groupId && !warmingGroups.some((item) => item.id === state.warming.groupId)) {
      state.warming.pauseReason = "The selected group is not available on any connected account.";
    }
    persist(); renderWarming();
    if (showToast) toast(`${warmingGroups.length} group${warmingGroups.length === 1 ? "" : "s"} loaded`);
  } catch (error) { toast(`Unable to load groups: ${errorMessage(error)}`); }
  finally { $("#refreshWarmingGroups").disabled = false; $("#refreshWarmingGroups").textContent = "Refresh Groups"; }
}
async function warmingIdleRead() {
  const warming = state.warming;
  if (warming.status !== "running" || Date.now() < (warming.nextIdleReadAt || 0)) return;
  warming.nextIdleReadAt = Date.now() + warming.idleRead * 60_000;
  const candidates = warming.accountIds.map(accountById).filter((account) => account?.status === "connected" && warmingGroupForAccount(account.id));
  if (!candidates.length) return;
  const account = candidates[Math.floor(Math.random() * candidates.length)];
  try {
    const result = await window.neuron.readWarmingGroup({ accountId: account.id, groupId: warming.groupId });
    if (result.read) warmingLog("info", `${account.name} marked the latest group message as read.`);
  } catch (error) { warmingLog("warning", `${account.name} idle read skipped: ${errorMessage(error)}`); }
  persist(); renderWarming();
}
async function warmingWait(milliseconds) {
  const end = Date.now() + Math.max(0, milliseconds);
  state.warming.nextActivityAt = end;
  persist(); renderWarming();
  while (Date.now() < end) {
    if (state.warming.status !== "running") return false;
    await warmingIdleRead();
    await wait(Math.min(1000, end - Date.now()));
    renderWarming(); renderActiveProcesses();
  }
  state.warming.nextActivityAt = 0;
  return state.warming.status === "running";
}
async function runWarming() {
  if (warmingRunner) return;
  warmingRunner = true;
  try {
    while (state.warming.status === "running") {
      const warming = state.warming;
      const messages = warmingMessages();
      if (!messages.length) {
        warming.status = "completed"; warming.pauseReason = "Message bank completed."; warmingLog("success", "Warming session completed: no messages remaining."); save(); return;
      }
      const eligible = warming.accountIds.map(accountById).filter((account) => {
        const progress = warming.accountProgress[account?.id] || {};
        return account?.status === "connected" && !accountCampaign(account.id) && !accountFiltering(account.id) && warmingGroupForAccount(account.id) && (progress.sent || 0) < warming.maxMessages;
      });
      if (!eligible.length) {
        const reachedLimit = warming.accountIds.length && warming.accountIds.every((id) => (warming.accountProgress[id]?.sent || 0) >= warming.maxMessages);
        if (reachedLimit) {
          warming.status = "completed"; warming.pauseReason = "Every selected account reached its message limit."; warmingLog("success", warming.pauseReason); save(); return;
        }
        warming.status = "paused"; warming.pauseReason = "No selected account is connected, available, and verified in this group."; warmingLog("warning", warming.pauseReason); save(); return;
      }
      const available = eligible.filter((account) => (warming.accountProgress[account.id]?.cooldownUntil || 0) <= Date.now());
      if (!available.length) {
        const next = Math.min(...eligible.map((account) => warming.accountProgress[account.id]?.cooldownUntil || Date.now()));
        warmingLog("info", `All available accounts are cooling down. Next account in ${formatCountdown(next)}.`);
        persist(); renderWarming();
        if (!await warmingWait(Math.max(1000, next - Date.now()))) return;
        continue;
      }
      const minimum = Math.min(...available.map((account) => warming.accountProgress[account.id]?.sent || 0));
      const fair = available.filter((account) => (warming.accountProgress[account.id]?.sent || 0) === minimum);
      const account = fair[Math.floor(Math.random() * fair.length)];
      const progress = warming.accountProgress[account.id] || { sent: 0, cooldownUntil: 0, status: "ready" };
      warming.accountProgress[account.id] = progress;
      progress.status = "sending";
      persist(); renderWarming();
      const text = resolveSpintax(messages[0]);
      try {
        const result = await window.neuron.sendWarmingMessage({ accountId: account.id, groupId: warming.groupId, text, replyChance: warming.replyChance / 100, readChance: warming.readChance / 100, typingMs: randomBetween(2500, 13500) });
        progress.sent = (progress.sent || 0) + 1;
        progress.status = progress.sent >= warming.maxMessages ? "completed" : "cooldown";
        progress.cooldownUntil = Date.now() + randomBetween(warming.cooldownMin, warming.cooldownMax) * 60_000;
        consumeFirstWarmingMessage(messages);
        const sessionSent = Object.values(warming.accountProgress).reduce((total, item) => total + (Number(item.sent) || 0), 0);
        const ackDelayed = result.status === "ack_delayed";
        if (ackDelayed) warming.delayedAcks[result.messageId] = { accountId: account.id, accountName: account.name, messageNumber: sessionSent };
        warmingLog(ackDelayed ? "warning" : "success", `${account.name} sent message ${sessionSent}/${warming.initialMessageCount || sessionSent} in ${result.mode} mode${result.read ? " after reading" : ""}${ackDelayed ? " — ACK delayed, counted once and removed from the bank" : " — removed from the bank"}.`);
      } catch (error) {
        progress.status = "error";
        progress.cooldownUntil = Date.now() + 60_000;
        warmingLog("error", `${account.name}: ${errorMessage(error)}`);
      }
      persist(); renderAll();
      if (warming.status !== "running") return;
      const activityDelay = randomBetween(warming.delayMin, warming.delayMax) * 60_000;
      if (!await warmingWait(activityDelay)) return;
    }
  } finally { warmingRunner = false; state.warming.nextActivityAt = 0; persist(); renderAll(); }
}

$$('.nav-item').forEach((button) => button.onclick = () => go(button.dataset.page));
$$('[data-go]').forEach((button) => button.onclick = () => go(button.dataset.go));
$$('[data-action="add-account"]').forEach((button) => button.onclick = () => $("#addAccount").click());
$$('[data-close]').forEach((button) => button.onclick = () => $("#" + button.dataset.close).close());
$$('dialog').forEach((dialog) => {
  let returnFocus = null;
  dialog.addEventListener("beforetoggle", (event) => {
    if (event.newState === "open") returnFocus = document.activeElement;
    if (event.newState === "closed" && dialog.id === "qrDialog") qrAccountId = null;
  });
  dialog.addEventListener("cancel", () => { if (dialog.id === "qrDialog") qrAccountId = null; });
  dialog.addEventListener("close", () => {
    if (dialog.open) return; // An old close event must not clear a newly opened QR.
    if (dialog.id === "qrDialog") qrAccountId = null;
    restoreInputFocus(returnFocus);
  });
});
$("#activeProcesses").onclick = (event) => {
  const button = event.target.closest("[data-process-type]");
  if (!button) return;
  if (button.dataset.processType === "warming") return go("warming");
  if (button.dataset.processType === "filter") return go("filter");
  const campaign = campaignById(button.dataset.processId);
  if (!campaign) return;
  $("#sendingCampaign").value = campaign.id;
  writeConfig(campaign.config);
  renderSendingPanel();
  go("sending");
};
$("#themeToggle").onclick = () => setTheme(state.theme === "dark" ? "light" : "dark");
$("#themeSelect").onchange = (event) => setTheme(event.target.value);
$("#compactMode").onchange = (event) => { state.compact = event.target.checked; save(); };
$("#checkUpdates").onclick = () => checkForUpdates(true);
$("#updateLater").onclick = closeUpdateDialog;
$("#updateAfter").onclick = remindUpdateAfterProcess;
$("#updateDialog").addEventListener("cancel", (event) => {
  if (updateDownloading) event.preventDefault();
  else updateAfterProcess = false;
});
$("#updateNow").onclick = beginUpdate;
$("#updateDialog").addEventListener("cancel", (event) => { if (updateDownloading) event.preventDefault(); });

$("#activateLicenseButton").onclick = async () => {
  const key = $("#licenseKeyInput").value.trim();
  if (!key) return toast("Enter a license key first");
  $("#activateLicenseButton").disabled = true;
  $("#licensePanelStatus").textContent = "Activating license…";
  try {
    const result = await window.neuron.activateLicense(key);
    applyLicenseState(result);
    if (result.valid) {
      $("#licenseKeyInput").value = "";
      await loadLicensedAccounts();
      toast("License activated on this computer");
      go("dashboard");
    } else go("license");
  } catch (error) { applyLicenseState({ valid: false, status: "error", message: errorMessage(error) }); go("license"); }
  finally { if (!licenseState.valid) $("#activateLicenseButton").disabled = false; }
};
$("#checkLicenseButton").onclick = async () => {
  $("#checkLicenseButton").disabled = true;
  $("#licensePanelStatus").textContent = "Checking license…";
  try {
    const result = await window.neuron.licenseStatus();
    applyLicenseState(result);
    if (result.valid) { await loadLicensedAccounts(); toast("License is active"); }
    else { renderAll(); go("license"); }
  } catch (error) { applyLicenseState({ valid: false, status: "error", message: errorMessage(error) }); renderAll(); go("license"); }
  finally { $("#checkLicenseButton").disabled = false; }
};
$("#copyMachineIdButton").onclick = async () => { if (!licenseState.machineId) return toast("Machine ID is not available yet"); await window.neuron.copyText(licenseState.machineId); toast("Machine ID copied"); };

$("#addAccount").onclick = () => { $("#newAccountName").value = `Account ${accounts.length + 1}`; $("#accountDialog").showModal(); };
$("#saveAccount").onclick = async (event) => { event.preventDefault(); const name = $("#newAccountName").value.trim(); if (!name) return toast("Account name is required"); $("#accountDialog").close(); try { const account = await window.neuron.addAccount(name); upsertAccount(account); showQr(account); } catch (error) { toast(errorMessage(error)); } };
$("#accountsGrid").onclick = async (event) => { const action = event.target.dataset.accountAction; if (!action) return; const id = event.target.closest(".account-card").dataset.id; const account = accountById(id); try { if (action === "connect") { showQr(account); await window.neuron.connectAccount(id); } if (action === "rename") { const name = await askAction("New account name:", account.name); if (name?.trim()) upsertAccount(await window.neuron.renameAccount(id, name)); } if (action === "logout" && await askAction(`Log out ${account.name}?`)) await window.neuron.logoutAccount(id); if (action === "delete" && await askAction(`Delete ${account.name} and its stored session?`)) await window.neuron.deleteAccount(id); } catch (error) { toast(errorMessage(error)); } };
function upsertAccount(account) { const index = accounts.findIndex((item) => item.id === account.id); if (index >= 0) accounts[index] = account; else accounts.push(account); renderAll(); }
function showQr(account) { qrAccountId = account.id; $("#qrTitle").textContent = `Connect ${account.name}`; $("#qrImage").style.display = "none"; $("#qrLoading").style.display = "grid"; $("#qrLoading").textContent = "Generating secure QR code…"; if (!$("#qrDialog").open) $("#qrDialog").showModal(); }

$("#addContact").onclick = () => $("#contactDialog").showModal();
$("#saveContact").onclick = (event) => { event.preventDefault(); const phone = cleanPhone($("#newPhone").value); if (phone.length < 8) return toast("Invalid phone number"); if (state.contacts.some((item) => item.phone === phone)) return toast("This number already exists"); state.contacts.push({ id: newId(), name: $("#newName").value.trim(), phone, var1: $("#newVar1").value.trim(), var2: $("#newVar2").value.trim(), selected: false, campaignId: null, deliveryStatus: "available" }); $("#contactDialog").close(); $("#contactDialog form").reset(); save(); toast("Contact added"); };
$("#processContacts").onclick = () => { const result = addContactsFromText($("#bulkContacts").value); $("#bulkContacts").value = ""; toast(`${result.added} added · ${result.invalid} invalid · ${result.duplicates} duplicates`); };
$("#importCsv").onclick = () => $("#csvInput").click();
$("#csvInput").onchange = async (event) => { const text = await event.target.files[0]?.text(); event.target.value = ""; if (!text) return; const result = addContactsFromText(text); toast(`${result.added} imported · ${result.invalid} invalid · ${result.duplicates} duplicates`); };
$("#contactSearch").oninput = renderContacts; $("#contactView").onchange = renderContacts;
$("#batchQuantity").oninput = updateBatchButton;
$("#batchQuantity").onblur = () => {
  const quantity = readBatchQuantity();
  if (quantity) $("#batchQuantity").value = String(quantity);
  updateBatchButton();
};
$("#contactsBody").onchange = (event) => { if (!event.target.classList.contains("contact-check")) return; const contact = state.contacts.find((item) => item.id === event.target.dataset.id); if (contact && !contact.campaignId) { contact.selected = event.target.checked; save(); } };
$("#contactsBody").onclick = (event) => { if (!event.target.classList.contains("delete-contact")) return; state.contacts = state.contacts.filter((item) => item.id !== event.target.dataset.id); save(); };
$("#selectAll").onchange = (event) => { const ids = new Set(visibleContacts().filter((item) => !item.campaignId).map((item) => item.id)); state.contacts.forEach((item) => { if (ids.has(item.id)) item.selected = event.target.checked; }); save(); };
$("#clearSelection").onclick = () => { state.contacts.forEach((item) => { item.selected = false; }); save(); toast("Selection cleared"); };
$("#selectBatch").onclick = () => { const quantity = readBatchQuantity(); if (!quantity) return toast("Enter a valid number to select"); let pool = state.contacts.filter((item) => !item.campaignId); state.contacts.forEach((item) => { item.selected = false; }); if ($('input[name="selectionOrder"]:checked').value === "random") pool = pool.map((value) => ({ value, sort: Math.random() })).sort((a, b) => a.sort - b.sort).map(({ value }) => value); pool.slice(0, quantity).forEach((item) => { item.selected = true; }); save(); toast(`${Math.min(quantity, pool.length)} contacts selected`); };
$("#assignSelected").onclick = () => { const campaign = campaignById($("#assignCampaign").value); if (!campaign) return toast("Create or select a destination campaign"); const selected = state.contacts.filter((item) => item.selected && !item.campaignId); if (!selected.length) return toast("Select contacts first"); selected.forEach((item) => { item.selected = false; item.campaignId = campaign.id; item.deliveryStatus = "waiting"; }); campaign.updatedAt = Date.now(); if (campaign.status === "completed") campaign.status = "ready"; save(); toast(`${selected.length} contacts moved to ${campaign.name}`); };
$("#clearContacts").onclick = async () => { const available = state.contacts.filter((item) => !item.campaignId).length; if (await askAction(`Delete all ${available} available contacts? Assigned campaign contacts will be kept.`)) { state.contacts = state.contacts.filter((item) => item.campaignId); save(); } };

$("#processFilterNumbers").onclick = () => { const result = addFilterNumbersFromText($("#filterInput").value); $("#filterInput").value = ""; toast(`${result.added} added · ${result.invalid} invalid · ${result.duplicates} duplicates`); };
$("#importFilterFile").onclick = () => $("#filterFileInput").click();
$("#filterFileInput").onchange = async (event) => { const text = await event.target.files[0]?.text(); event.target.value = ""; if (!text) return; const result = addFilterNumbersFromText(text); toast(`${result.added} imported · ${result.invalid} invalid · ${result.duplicates} duplicates`); };
$("#filterSearch").oninput = renderFilterTable;
$("#filterView").onchange = renderFilterTable;
$("#filterAccounts").onchange = (event) => { if (!event.target.classList.contains("filter-account-check") || state.numberFilter.status === "running") return; const id = event.target.dataset.id; if (event.target.checked) { if (!state.numberFilter.accountIds.includes(id)) state.numberFilter.accountIds.push(id); state.numberFilter.accountProgress[id] ||= { checked: 0, registered: 0, failed: 0 }; } else state.numberFilter.accountIds = state.numberFilter.accountIds.filter((item) => item !== id); persist(); renderFilterAccounts(); };
$("#filterBody").onchange = (event) => { if (!event.target.classList.contains("filter-check")) return; const item = state.numberFilter.items.find((entry) => entry.id === event.target.dataset.id); if (item?.status === "registered") { item.selected = event.target.checked; persist(); renderFilterSummary(); } };
$("#filterBody").onclick = (event) => { if (!event.target.classList.contains("delete-filter-item") || state.numberFilter.status === "running") return; state.numberFilter.items = state.numberFilter.items.filter((item) => item.id !== event.target.dataset.id); persist(); renderFilter(); };
$("#selectAllFiltered").onchange = (event) => { const ids = new Set(visibleFilterItems().filter((item) => item.status === "registered").map((item) => item.id)); state.numberFilter.items.forEach((item) => { if (ids.has(item.id)) item.selected = event.target.checked; }); persist(); renderFilter(); };
$("#selectRegistered").onclick = () => { state.numberFilter.items.forEach((item) => { item.selected = item.status === "registered"; }); persist(); renderFilter(); toast(`${filterCounts().selected.toLocaleString()} registered numbers selected`); };
$("#recheckRegistered").onclick = () => { if (state.numberFilter.status === "running") return toast("Pause the filter first"); const items = state.numberFilter.items.filter((item) => item.status === "registered"); if (!items.length) return toast("No registered numbers to recheck"); items.forEach((item) => { item.status = "unchecked"; item.selected = false; item.checkedBy = ""; item.checkedAt = null; item.error = ""; }); state.numberFilter.status = "ready"; state.numberFilter.pauseReason = ""; persist(); renderFilter(); toast(`${items.length.toLocaleString()} registered numbers queued for recheck`); };
$("#retryFailedFilter").onclick = () => { if (state.numberFilter.status === "running") return toast("Pause the filter first"); const items = state.numberFilter.items.filter((item) => item.status === "failed"); if (!items.length) return toast("No failed checks to retry"); items.forEach((item) => { item.status = "unchecked"; item.error = ""; }); state.numberFilter.status = "ready"; state.numberFilter.pauseReason = ""; persist(); renderFilter(); toast(`${items.length.toLocaleString()} failed checks returned to the queue`); };
$("#addFilteredContacts").onclick = () => { if (state.numberFilter.status === "running") return toast("Pause the filter before moving numbers"); const selected = state.numberFilter.items.filter((item) => item.status === "registered" && item.selected); if (!selected.length) return toast("Select registered numbers first"); const existing = new Set(state.contacts.map((item) => item.phone)); let added = 0; for (const item of selected) { if (existing.has(item.phone)) continue; existing.add(item.phone); state.contacts.push({ id: newId(), name: item.name || "", phone: item.phone, var1: item.var1 || "", var2: item.var2 || "", selected: false, campaignId: null, deliveryStatus: "available" }); added++; } const selectedIds = new Set(selected.map((item) => item.id)); state.numberFilter.items = state.numberFilter.items.filter((item) => !selectedIds.has(item.id)); persist(); renderContacts(); renderFilter(); renderStats(); toast(`${added.toLocaleString()} registered numbers added to Contacts and removed from Filter`); };
$("#clearNotRegistered").onclick = async () => { if (state.numberFilter.status === "running") return toast("Pause the filter first"); const count = state.numberFilter.items.filter((item) => item.status === "not_registered").length; if (!count) return toast("No unregistered numbers to clear"); if (await askAction(`Delete ${count.toLocaleString()} not registered number${count === 1 ? "" : "s"} from Filter?`)) { if (state.numberFilter.status === "running") return toast("Pause the filter first"); state.numberFilter.items = state.numberFilter.items.filter((item) => item.status !== "not_registered"); persist(); renderFilter(); } };
$("#clearAllFilter").onclick = async () => { if (state.numberFilter.status === "running") return toast("Pause or stop the filter first"); if (!state.numberFilter.items.length) return toast("Filter list is already empty"); if (await askAction(`Delete all ${state.numberFilter.items.length.toLocaleString()} numbers from Filter?`)) { if (state.numberFilter.status === "running") return toast("Pause or stop the filter first"); state.numberFilter = defaultNumberFilter(); persist(); renderFilter(); renderAccounts(); renderActiveProcesses(); } };
$("#startFilter").onclick = () => { const filter = state.numberFilter; const pending = filter.items.filter((item) => item.status === "unchecked"); if (!pending.length) return toast("No unchecked numbers. Use Retry Failed or Recheck Registered first."); const selected = filter.accountIds.map(accountById).filter((account) => account?.status === "connected" && !accountCampaign(account.id) && !accountWarming(account.id)); if (!selected.length) return toast("Select at least one connected and available WhatsApp session"); filter.accountIds = selected.map((account) => account.id); filter.status = "running"; filter.pauseReason = ""; persist(); renderFilter(); renderAccounts(); renderSendingPanel(); renderWarming(); renderActiveProcesses(); runNumberFilter(); };
$("#pauseFilter").onclick = () => { if (state.numberFilter.status !== "running") return; state.numberFilter.status = "paused"; state.numberFilter.pauseReason = "Paused manually. Press Resume Filter to continue."; persist(); renderFilter(); renderAccounts(); renderActiveProcesses(); };
$("#stopFilter").onclick = () => { if (!["running", "paused"].includes(state.numberFilter.status)) return; state.numberFilter.status = "stopped"; state.numberFilter.pauseReason = "Stopped manually. Unchecked and failed numbers remain in the Filter list."; state.numberFilter.items.forEach((item) => { if (item.status === "checking") item.status = "unchecked"; }); persist(); renderFilter(); renderAccounts(); renderSendingPanel(); renderWarming(); renderActiveProcesses(); };

$("#newCampaign").onclick = openCampaignDialog; $("#createFirstCampaign").onclick = openCampaignDialog; $("#newCampaignFromContacts").onclick = openCampaignDialog;
$("#saveCampaign").onclick = (event) => { event.preventDefault(); const name = $("#newCampaignName").value.trim(); if (!name) return toast("Campaign name is required"); if (state.campaigns.some((item) => item.name.toLowerCase() === name.toLowerCase())) return toast("Campaign name already exists"); const campaign = createCampaign(name); $("#campaignDialog").close(); $("#assignCampaign").value = campaign.id; toast("Campaign created"); };
$("#campaignGrid").onclick = async (event) => { const action = event.target.dataset.campaignAction; if (!action) return; const id = event.target.closest(".campaign-card").dataset.id; const campaign = campaignById(id); if (action === "send") { $("#sendingCampaign").value = id; writeConfig(campaign.config); renderSendingPanel(); go("sending"); } if (action === "rename") { const name = await askAction("New campaign name:", campaign.name); if (name?.trim() && campaignById(id)) { campaign.name = name.trim().slice(0, 80); state.queue.filter((item) => item.campaignId === id).forEach((item) => { item.campaign = campaign.name; }); save(); } } if (action === "delete") { if (campaign.status === "running" || campaignRunners.has(id)) return toast("Pause or stop this campaign before deleting it"); const count = campaignContacts(id).length; if (await askAction(`Delete ${campaign.name} and its ${count.toLocaleString()} contact${count === 1 ? "" : "s"}? Contacts in this campaign will not return to Available.`)) { if (campaign.status === "running" || campaignRunners.has(id)) return toast("Pause or stop this campaign before deleting it"); const contactIds = new Set(campaignContacts(id).map((item) => item.id)); state.contacts = state.contacts.filter((item) => !contactIds.has(item.id)); state.queue = state.queue.filter((item) => item.campaignId !== id); state.campaigns = state.campaigns.filter((item) => item.id !== id); save(); toast(`${campaign.name} and ${count.toLocaleString()} contacts deleted`); } } };

$("#sendingCampaign").onchange = () => { const campaign = campaignById($("#sendingCampaign").value); writeConfig(campaign?.config); renderSendingPanel(); };
$("#sendingAccount").onchange = () => { const campaign = campaignById($("#sendingCampaign").value); if (campaign) { campaign.accountId = $("#sendingAccount").value || null; persist(); renderSendingPanel(); } };
$("#messageType").onchange = () => { $("#mediaPath").value = ""; updateComposer(); saveDraft(); };
["#messageText", "#messageFooter", "#buttonText", "#buttonUrl", "#delayMin", "#delayMax"].forEach((selector) => $(selector).oninput = () => { updateComposer(); saveDraft(); });
$("#linkFallback").onchange = saveDraft;
$$('[data-token]').forEach((button) => button.onclick = () => { const field = $("#messageText"); const start = field.selectionStart; field.value = field.value.slice(0, start) + button.dataset.token + field.value.slice(field.selectionEnd); field.selectionStart = field.selectionEnd = start + button.dataset.token.length; field.focus(); updateComposer(); saveDraft(); });
$("#pickMedia").onclick = async () => { const type = $("#messageType").value; const file = await window.neuron.pickMedia(type === "cta" ? "image" : type); if (file) { $("#mediaPath").value = file; saveDraft(); } };
$("#startCampaign").onclick = () => { const campaign = campaignById($("#sendingCampaign").value); if (!campaign) return toast("Select a campaign first"); const counts = campaignCounts(campaign.id); if (counts.unconfirmed) return toast("Resolve unconfirmed messages before continuing"); if (!counts.waiting) return toast("This campaign has no waiting recipients"); const account = accountById($("#sendingAccount").value); if (!account || account.status !== "connected") return toast("Select a connected WhatsApp account"); const occupied = accountCampaign(account.id, campaign.id); if (occupied) return toast(`This account is already assigned to ${occupied.name}`); if (accountWarming(account.id)) return toast("This account is reserved by Account Warming"); if (accountFiltering(account.id)) return toast("This account is reserved by WA Filter"); const config = readConfig(); if (!config.text.trim()) return toast("Message is required"); if (["image", "video", "document"].includes(config.type) && !config.mediaPath) return toast("Select a media file"); if (config.type === "cta" && !/^https?:\/\//i.test(config.buttonUrl)) return toast("Enter a valid CTA URL"); if (!$("#confirmSend").checked) return toast("Confirm recipient opt-in first"); campaign.config = config; campaign.accountId = account.id; campaign.status = "running"; campaign.pauseReason = ""; prepareCampaignJobs(campaign, account); saveOperational(); runCampaign(campaign.id); };
$("#pauseCampaign").onclick = () => { const campaign = campaignById($("#sendingCampaign").value); if (campaign?.status === "running") { campaign.status = "paused"; campaign.pauseReason = "Paused manually."; saveOperational(); } };
$("#stopCampaign").onclick = () => { const campaign = campaignById($("#sendingCampaign").value); if (!campaign) return; campaign.status = "stopped"; campaign.pauseReason = "Stopped manually. Select an account to resume later."; campaign.accountId = null; campaignJobs(campaign.id).filter((item) => item.status === "sending").forEach((item) => { item.status = "unconfirmed"; const contact = state.contacts.find((entry) => entry.id === item.contactId); if (contact) contact.deliveryStatus = "unconfirmed"; }); saveOperational(); };
$("#retryUnconfirmed").onclick = () => { const campaign = campaignById($("#sendingCampaign").value); if (!campaign) return; campaignContacts(campaign.id).filter((item) => item.deliveryStatus === "unconfirmed").forEach((item) => { item.deliveryStatus = "waiting"; }); campaignJobs(campaign.id).filter((item) => item.status === "unconfirmed").forEach((item) => { item.status = "waiting"; }); campaign.pauseReason = "Unconfirmed messages returned to waiting."; saveOperational(); };
$("#skipUnconfirmed").onclick = () => { const campaign = campaignById($("#sendingCampaign").value); if (!campaign) return; campaignContacts(campaign.id).filter((item) => item.deliveryStatus === "unconfirmed").forEach((item) => { item.deliveryStatus = "failed"; }); campaignJobs(campaign.id).filter((item) => item.status === "unconfirmed").forEach((item) => { item.status = "failed"; state.history.push({ time: Date.now(), campaign: campaign.name, campaignId: campaign.id, accountName: item.accountName, phone: item.phone, status: "failed", note: "Skipped after an unconfirmed interruption" }); }); campaign.pauseReason = "Unconfirmed messages skipped."; saveOperational(); };

$("#refreshWarmingGroups").onclick = () => refreshWarmingGroups(true);
$("#warmingGroup").onchange = (event) => { const group = warmingGroups.find((item) => item.id === event.target.value); state.warming.groupId = event.target.value; state.warming.groupName = group?.name || ""; state.warming.pauseReason = ""; persist(); renderWarming(); };
$("#warmingAccounts").onchange = (event) => { if (!event.target.classList.contains("warming-account-check")) return; const id = event.target.dataset.id; if (event.target.checked) { if (!state.warming.accountIds.includes(id)) state.warming.accountIds.push(id); state.warming.accountProgress[id] ||= { sent: 0, cooldownUntil: 0, status: "ready" }; } else state.warming.accountIds = state.warming.accountIds.filter((item) => item !== id); persist(); renderAll(); };
$("#warmingMessages").oninput = (event) => { state.warming.messages = event.target.value; state.warming.initialMessageCount = 0; persist(); $("#warmingMessageCount").textContent = `${warmingMessages().length.toLocaleString()} messages`; $("#warmingRemainingCount").textContent = warmingMessages().length.toLocaleString(); };
$("#importWarmingMessages").onclick = () => $("#warmingMessageFile").click();
$("#warmingMessageFile").onchange = async (event) => { const text = await event.target.files[0]?.text(); event.target.value = ""; if (!text) return; state.warming.messages = text; state.warming.messageIndex = 0; state.warming.initialMessageCount = 0; persist(); renderWarming(); toast(`${warmingMessages().length} warming messages imported`); };
["#warmingMaxMessages", "#warmingDelayMin", "#warmingDelayMax", "#warmingCooldownMin", "#warmingCooldownMax", "#warmingReplyChance", "#warmingReadChance", "#warmingIdleRead"].forEach((selector) => $(selector).onchange = () => { readWarmingForm(); persist(); renderWarming(); });
$("#startWarming").onclick = async () => {
  readWarmingForm();
  const warming = state.warming;
  if (!warming.groupId) return toast("Select a target WhatsApp group");
  if (!warmingGroups.some((group) => group.id === warming.groupId)) return toast("Refresh groups and verify the selected group first");
  if (!warmingMessages().length) return toast("Add messages or import a new message bank first");
  if (!warming.accountIds.length) return toast("Select at least one warming account");
  const invalid = warming.accountIds.map(accountById).filter((account) => !account || account.status !== "connected" || accountCampaign(account.id) || accountFiltering(account.id) || !warmingGroupForAccount(account.id));
  if (invalid.length) return toast("Every selected account must be connected, available, and a member of the target group");
  warming.accountIds.forEach((id) => { warming.accountProgress[id] ||= { sent: 0, cooldownUntil: 0, status: "ready" }; });
  if (!warming.initialMessageCount) warming.initialMessageCount = warmingMessages().length;
  warming.status = "running"; warming.pauseReason = ""; warming.nextIdleReadAt = Date.now() + warming.idleRead * 60_000;
  warmingLog("info", `Warming started for ${warming.groupName || warming.groupId} with ${warming.accountIds.length} account(s).`);
  save(); runWarming();
};
$("#pauseWarming").onclick = () => { if (state.warming.status !== "running") return; state.warming.status = "paused"; state.warming.pauseReason = "Paused manually. Press Resume Warming to continue."; state.warming.nextActivityAt = 0; warmingLog("warning", "Warming paused manually."); save(); };
$("#stopWarming").onclick = async () => { if (!await askAction("Stop warming and reset its message/account progress? The message bank and settings will be kept.")) return; const keep = { messages: state.warming.messages, groupId: state.warming.groupId, groupName: state.warming.groupName, accountIds: [...state.warming.accountIds], maxMessages: state.warming.maxMessages, delayMin: state.warming.delayMin, delayMax: state.warming.delayMax, cooldownMin: state.warming.cooldownMin, cooldownMax: state.warming.cooldownMax, replyChance: state.warming.replyChance, readChance: state.warming.readChance, idleRead: state.warming.idleRead }; state.warming = { ...defaultWarming(), ...keep }; save(); toast("Warming progress reset"); };
$("#clearWarmingLog").onclick = () => { state.warming.logs = []; persist(); renderWarming(); };

$("#clearHistory").onclick = async () => { if (!state.history.length) return toast("History is already empty"); if (await askAction(`Delete all ${state.history.length} history entries?`)) { state.history = []; save(); toast("History cleared"); } };
$("#exportHistory").onclick = () => { const csv = ["Time,Campaign,Account,Number,Status,Details", ...state.history.map((item) => [new Date(item.time).toISOString(), item.campaign, item.accountName, item.phone, item.status, item.note].map((value) => `"${String(value || "").replaceAll('"', '""')}"`).join(","))].join("\n"); const anchor = document.createElement("a"); anchor.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" })); anchor.download = "neuron-wa-history.csv"; anchor.click(); URL.revokeObjectURL(anchor.href); };
$("#resetCampaignData").onclick = async () => { if (await askAction("Reset all contacts, campaigns, queues, warming progress, history, and display settings? WhatsApp sessions will be kept.")) { state = structuredClone(initial); persist(); setTheme("light"); renderAll(); toast("Local campaign and warming data reset"); } };

window.neuron.onAccountUpdate((account) => {
  upsertAccount(account);
  if (account.status === "connected" && qrAccountId === account.id) { $("#qrDialog").close(); qrAccountId = null; toast(`${account.name} connected successfully`); }
  if (account.status !== "connected") {
    let changed = false;
    state.campaigns.filter((campaign) => campaign.accountId === account.id && campaign.status === "running").forEach((campaign) => {
      campaign.status = "paused";
      campaign.autoResumeOnReconnect = account.status !== "logged_out";
      const reason = account.lastDisconnectReason || statusLabel(account.status);
      const retry = account.reconnectAttempt ? ` Retry ${account.reconnectAttempt} is scheduled.` : "";
      campaign.pauseReason = `${account.name}: ${reason}.${retry}`;
      changed = true;
    });
    if (changed) save();
    return;
  }
  let changed = false;
  state.campaigns.filter((campaign) => campaign.accountId === account.id && campaign.autoResumeOnReconnect).forEach((campaign) => {
    const counts = campaignCounts(campaign.id);
    campaign.autoResumeOnReconnect = false;
    if (counts.unconfirmed) {
      campaign.status = "paused";
      campaign.pauseReason = `${account.name} reconnected. Review the ${counts.unconfirmed} unconfirmed message before resuming.`;
    } else if (counts.waiting) {
      campaign.status = "running";
      campaign.pauseReason = "";
      setTimeout(() => runCampaign(campaign.id), 0);
    }
    changed = true;
  });
  if (changed) save();
});
window.neuron.onAccountRemoved(({ id }) => { accounts = accounts.filter((account) => account.id !== id); state.campaigns.filter((campaign) => campaign.accountId === id && campaignCounts(campaign.id).remaining).forEach((campaign) => { campaign.status = "paused"; campaign.pauseReason = "The assigned account was removed. Select a replacement account."; campaign.accountId = null; }); state.warming.accountIds = state.warming.accountIds.filter((accountId) => accountId !== id); delete state.warming.accountProgress[id]; state.numberFilter.accountIds = state.numberFilter.accountIds.filter((accountId) => accountId !== id); delete state.numberFilter.accountProgress[id]; if (state.warming.status === "running" && !state.warming.accountIds.length) { state.warming.status = "paused"; state.warming.pauseReason = "All warming accounts were removed."; } if (state.numberFilter.status === "running" && !state.numberFilter.accountIds.length) { state.numberFilter.status = "paused"; state.numberFilter.pauseReason = "All filter sessions were removed."; } save(); });
window.neuron.onQr(({ id, dataUrl }) => { if (!dataUrl || id !== qrAccountId) return; $("#qrLoading").style.display = "none"; $("#qrImage").src = dataUrl; $("#qrImage").style.display = "block"; });
window.neuron.onWarmingAck(({ accountId, messageId }) => { const delayed = state.warming.delayedAcks[messageId]; const account = accountById(accountId); warmingLog("success", `${delayed?.accountName || account?.name || "Warming account"}: delayed server ACK received${delayed?.messageNumber ? ` for message ${delayed.messageNumber}` : ""}.`); delete state.warming.delayedAcks[messageId]; persist(); renderWarming(); renderActiveProcesses(); });
window.neuron.onUpdateStatus((status) => {
  const percent = Math.max(0, Math.min(100, Number(status?.percent) || 0));
  $("#updateProgress").value = percent;
  $("#updateProgressPercent").textContent = `${percent}%`;
  if (status?.stage === "verifying") $("#updateProgressLabel").textContent = "Verifying SHA-256 checksum…";
  else if (status?.stage === "installing") $("#updateProgressLabel").textContent = "Installing and restarting…";
  else if (status?.stage === "downloading") $("#updateProgressLabel").textContent = `Downloading ${formatBytes(status.received)} / ${formatBytes(status.total)}`;
});

async function initialize() {
  setTheme(state.theme); renderAll(); updateComposer();
  startUpdateChecks();
  window.neuron.getAppVersion()
    .then((version) => $$('[data-app-version]').forEach((element) => { element.textContent = `${element.dataset.versionPrefix || ""}${version}`; }))
    .catch(() => $$('[data-app-version]').forEach((element) => { element.textContent = "Unavailable"; }));
  try {
    const license = await window.neuron.licenseStatus();
    applyLicenseState(license);
    if (!license.valid) { renderAll(); go("license"); return; }
    await loadLicensedAccounts();
    const campaign = campaignById($("#sendingCampaign").value);
    writeConfig(campaign?.config);
    if (connectedAccounts().length) await refreshWarmingGroups(false);
  } catch (error) { applyLicenseState({ valid: false, status: "error", message: errorMessage(error) }); renderAll(); go("license"); }
}
initialize();
setInterval(() => {
  if (accounts.some((account) => account.status === "reconnecting" && account.nextReconnectAt)) {
    renderAccounts();
    renderSendingPanel();
  }
}, 1000);
