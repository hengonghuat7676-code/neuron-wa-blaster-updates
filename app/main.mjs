import { app, BrowserWindow, clipboard, dialog, ipcMain, nativeTheme, safeStorage } from "electron";
import { mkdir, readFile, writeFile, rename, rm } from "node:fs/promises";
import { createWriteStream, existsSync, statSync, unlinkSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomUUID } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { hostname } from "node:os";
import https from "node:https";
import { pipeline } from "node:stream/promises";
import { WhatsAppManager } from "./wa-manager.mjs";

app.disableHardwareAcceleration();

const here = path.dirname(fileURLToPath(import.meta.url));
if (process.env.NEURON_USER_DATA_DIR) app.setPath("userData", path.resolve(process.env.NEURON_USER_DATA_DIR));
let mainWindow;
let waManager;
let waInitialized = false;
let waInitializePromise = null;
let licenseValid = false;
let licenseMessage = "License has not been checked.";
let licenseExpires = "";
let machineIdCache = "";
let updateBusy = false;
let updateInstalling = false;
let activeDownload = null;
let downloadedUpdate = null;
let updateDownloading = false;
let checkedUpdate = null;
const LICENSE_OFFLINE_GRACE_MS = 72 * 60 * 60 * 1000;
const LICENSE_SERVER_URL = "https://script.google.com/macros/s/AKfycby617kyk7nh2vS0X71UkU3P_ojpOChh0Md5aDhwDtizDPVLA6GU98JDasRMUIxgslPixg/exec";
const UPDATE_REPOSITORY = "hengonghuat7676-code/neuron-wa-blaster-updates";
const UPDATE_API = `https://api.github.com/repos/${UPDATE_REPOSITORY}/releases/latest`;
const UPDATE_INTERVAL_MS = 24 * 60 * 60 * 1000;

function rememberedLicensePath() { return path.join(app.getPath("userData"), "neuron-wa-license.bin"); }
function updateStatePath() { return path.join(app.getPath("userData"), "update-state.json"); }
function updateFolder() { return path.join(app.getPath("userData"), "updates"); }

async function readUpdateState() {
  try { return JSON.parse(await readFile(updateStatePath(), "utf8")); }
  catch { return {}; }
}

async function writeUpdateState(value) {
  await mkdir(path.dirname(updateStatePath()), { recursive: true });
  const temporary = `${updateStatePath()}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(value, null, 2), "utf8");
    await rename(temporary, updateStatePath());
  } finally { await rm(temporary, { force: true }).catch(() => {}); }
}

function versionParts(value) {
  return String(value || "0").replace(/^v/i, "").split(".").map((part) => Number.parseInt(part, 10) || 0);
}

function isNewerVersion(latest, current) {
  const a = versionParts(latest); const b = versionParts(current);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    if ((a[index] || 0) > (b[index] || 0)) return true;
    if ((a[index] || 0) < (b[index] || 0)) return false;
  }
  return false;
}

function githubRequest(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    const request = https.get(url, { headers: { "User-Agent": "Neuron-WA-Blaster", Accept: "application/vnd.github+json" } }, (response) => {
      if ([301, 302, 303, 307, 308].includes(response.statusCode) && response.headers.location && redirects < 6) {
        response.resume(); resolve(githubRequest(response.headers.location, redirects + 1)); return;
      }
      const chunks = [];
      response.on("error", reject);
      response.on("aborted", () => reject(new Error("Update response was interrupted. Please retry.")));
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks) }));
    });
    request.setTimeout(20_000, () => request.destroy(new Error("Update request timed out")));
    request.on("error", reject);
  });
}

async function checkForUpdate(manual = false) {
  const currentVersion = app.getVersion();
  const previous = await readUpdateState();
  const checkedAt = Number(previous.lastCheckedAt || 0);
  if (!manual && checkedAt && Date.now() - checkedAt < UPDATE_INTERVAL_MS) {
    return { available: false, skipped: true, currentVersion, nextCheckAt: checkedAt + UPDATE_INTERVAL_MS };
  }
  try {
    const response = await githubRequest(UPDATE_API);
    if (response.status === 404) {
      throw new Error("GitHub update repository or published release is unavailable (HTTP 404).");
    }
    if (response.status !== 200) throw new Error(`GitHub returned HTTP ${response.status}`);
    const release = JSON.parse(response.body.toString("utf8"));
    const latestVersion = String(release.tag_name || "").replace(/^v/i, "");
    if (!/^\d+\.\d+\.\d+$/.test(latestVersion)) throw new Error("Release tag must use a stable version such as v3.4.1.");
    const assets = release.assets || [];
    const executable = assets.find((asset) => asset.name === `Neuron-WA-Blaster-${latestVersion}.exe`)
      || assets.find((asset) => /^Neuron[- ]WA[- ]Blaster\.exe$/i.test(asset.name));
    const checksum = assets.find((asset) => asset.name === `${executable?.name}.sha256`)
      || assets.find((asset) => /^SHA256SUMS\.txt$/i.test(asset.name));
    if (isNewerVersion(latestVersion, currentVersion) && (!executable || !checksum)) {
      throw new Error(`Release ${latestVersion} is missing its portable EXE or matching SHA-256 checksum.`);
    }
    await writeUpdateState({ ...previous, lastCheckedAt: Date.now(), latestVersion });
    checkedUpdate = {
      available: Boolean(executable) && isNewerVersion(latestVersion, currentVersion),
      currentVersion, latestVersion, notes: release.body || "", publishedAt: release.published_at,
      downloadUrl: executable?.browser_download_url || "", fileName: executable?.name || "", size: executable?.size || 0,
      checksumUrl: checksum?.browser_download_url || "", releaseUrl: release.html_url || ""
    };
    return checkedUpdate;
  } catch (error) {
    return { available: false, currentVersion, error: error.message };
  }
}

function downloadToFile(url, destination, onProgress, redirects = 0, retries = 0) {
  return new Promise((resolve, reject) => {
    let resumeFrom = 0;
    try { if (existsSync(destination)) resumeFrom = statSync(destination).size; }
    catch (error) { reject(error); return; }
    const headers = { "User-Agent": "Neuron-WA-Blaster", Accept: "application/octet-stream" };
    if (resumeFrom) headers.Range = `bytes=${resumeFrom}-`;
    let handled = false;
    const fail = (error, retryable = true) => {
      if (handled) return;
      handled = true;
      activeDownload = null;
      if (retryable && retries < 3) {
        setTimeout(() => resolve(downloadToFile(url, destination, onProgress, redirects, retries + 1)), (retries + 1) * 1000);
      } else reject(error);
    };
    const request = https.get(url, { headers }, (response) => {
      if ([301, 302, 303, 307, 308].includes(response.statusCode) && response.headers.location && redirects < 6) {
        handled = true;
        response.resume(); resolve(downloadToFile(response.headers.location, destination, onProgress, redirects + 1, retries)); return;
      }
      if (response.statusCode === 416 && resumeFrom) {
        const range = String(response.headers["content-range"] || "").match(/^bytes \*\/(\d+)$/i);
        response.resume();
        if (range && Number(range[1]) === resumeFrom) {
          handled = true;
          activeDownload = null;
          onProgress(resumeFrom, resumeFrom);
          resolve(destination);
        } else fail(new Error("The server rejected the resumed update download."));
        return;
      }
      if (response.statusCode !== 200 && response.statusCode !== 206) {
        response.resume();
        const status = response.statusCode;
        fail(new Error(`Download failed with HTTP ${status}`), [408, 429, 500, 502, 503, 504].includes(status));
        return;
      }
      let offset = resumeFrom;
      let total = Number(response.headers["content-length"] || 0);
      if (response.statusCode === 206) {
        const range = String(response.headers["content-range"] || "").match(/^bytes (\d+)-(\d+)\/(\d+|\*)$/i);
        if (!range || Number(range[1]) !== resumeFrom) {
          response.resume();
          fail(new Error("The server returned an invalid range for the update download."), false);
          return;
        }
        total = range[3] === "*" ? offset + total : Number(range[3]);
      } else {
        offset = 0;
        if (resumeFrom) onProgress(0, total);
      }
      if (response.statusCode === 206 && total && response.headers["content-length"]) {
        total = Math.max(total, offset + Number(response.headers["content-length"]));
      }
      let received = offset;
      const output = createWriteStream(destination, { flags: offset ? "a" : "w" });
      activeDownload = request;
      response.on("error", (error) => fail(error));
      response.on("data", (chunk) => { received += chunk.length; onProgress(received, total); });
      pipeline(response, output).then(() => {
        if (total && received !== total) throw new Error("Incomplete update download.");
        if (handled) return;
        handled = true;
        activeDownload = null;
        resolve(destination);
      }).catch((error) => { request.destroy(); fail(error); });
    });
    activeDownload = request;
    request.setTimeout(120_000, () => request.destroy(new Error("Update download timed out")));
    request.on("error", (error) => fail(error));
  });
}

function checksumForFile(contents, fileName) {
  const lines = String(contents || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const escaped = String(fileName || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const matching = lines.find((line) => new RegExp(`^[a-f0-9]{64}\\s+\\*?${escaped}$`, "i").test(line));
  return (matching || lines.find((line) => /^[a-f0-9]{64}$/i.test(line)) || "").match(/^[a-f0-9]{64}/i)?.[0]?.toLowerCase() || "";
}

async function downloadUpdate(info) {
  if (updateDownloading) throw new Error("An update download is already running.");
  if (updateBusy) throw new Error("An active process is running. Choose Update Later and try again after it finishes.");
  if (!app.isPackaged || !process.env.PORTABLE_EXECUTABLE_FILE) throw new Error("Portable updates are available only in the packaged application.");
  if (!info?.downloadUrl || !info?.latestVersion || !info?.checksumUrl) throw new Error("The GitHub release is missing the EXE or SHA-256 checksum.");
  if (!checkedUpdate?.available || info.downloadUrl !== checkedUpdate.downloadUrl || info.latestVersion !== checkedUpdate.latestVersion) throw new Error("Check for updates again before downloading.");
  info = checkedUpdate;
  updateDownloading = true;
  downloadedUpdate = null;
  const destination = path.join(updateFolder(), `Neuron-WA-Blaster-${info.latestVersion}.exe.download`);
  try {
    await mkdir(updateFolder(), { recursive: true });
    sendToRenderer("update:status", { stage: "downloading", percent: 0, received: 0, total: info.size || 0 });
    await downloadToFile(info.downloadUrl, destination, (received, total) => sendToRenderer("update:status", { stage: "downloading", percent: total ? Math.round(received * 100 / total) : 0, received, total }));
    if (updateBusy) throw new Error("A process started while the update was downloading. Installation was cancelled.");
    sendToRenderer("update:status", { stage: "verifying", percent: 100 });
    const checksumResponse = await githubRequest(info.checksumUrl);
    if (checksumResponse.status !== 200) throw new Error("Unable to download the SHA-256 checksum.");
    const expected = checksumForFile(checksumResponse.body.toString("utf8"), info.fileName);
    if (!expected) throw new Error("The SHA-256 checksum file is invalid.");
    const actual = createHash("sha256").update(await readFile(destination)).digest("hex");
    if (actual !== expected) throw new Error("SHA-256 verification failed. The update was not installed.");
    downloadedUpdate = { path: destination, version: info.latestVersion, hash: actual };
    sendToRenderer("update:status", { stage: "ready", percent: 100 });
    return { ok: true, version: info.latestVersion };
  } catch (error) {
    try { if (existsSync(destination)) unlinkSync(destination); } catch {}
    sendToRenderer("update:status", { stage: "error", message: error.message });
    throw error;
  } finally {
    updateDownloading = false;
  }
}

async function installDownloadedUpdate() {
  if (updateInstalling) throw new Error("Update installation is already running.");
  if (updateBusy) throw new Error("An active process is running. The update cannot be installed now.");
  if (!app.isPackaged || !process.env.PORTABLE_EXECUTABLE_FILE) throw new Error("Portable updates are available only in the packaged application.");
  if (!downloadedUpdate?.path || !existsSync(downloadedUpdate.path)) throw new Error("No verified update is ready.");
  if (createHash("sha256").update(await readFile(downloadedUpdate.path)).digest("hex") !== downloadedUpdate.hash) throw new Error("Update file changed after verification. Download it again.");
  const target = path.resolve(process.env.PORTABLE_EXECUTABLE_FILE);
  const script = path.join(updateFolder(), "apply-portable-update.ps1");
  const logFile = path.join(updateFolder(), "portable-update.log");
  const markerFile = path.join(updateFolder(), "portable-update-result.json");
  const readyFile = path.join(updateFolder(), `helper-ready-${randomUUID()}.txt`);
  const startupFile = path.join(updateFolder(), `app-started-${randomUUID()}.json`);
  const startupTimeoutSeconds = 90;
  const powershell = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  if (!existsSync(powershell)) throw new Error("Windows PowerShell is unavailable. Install the update manually.");
  await writeFile(script, [
    "param([int]$OldPid,[string]$Source,[string]$Target,[string]$Version,[string]$LogFile,[string]$MarkerFile,[string]$ReadyFile,[string]$StartupFile,[int]$StartupTimeoutSeconds,[string]$ExpectedHash)",
    "$ErrorActionPreference = 'Stop'",
    "function Write-UpdateLog([string]$Message) { Add-Content -LiteralPath $LogFile -Value ((Get-Date).ToString('o') + ' ' + $Message) -Encoding UTF8 }",
    "function Copy-WithRetry([string]$From,[string]$To) { for ($Attempt = 1; $Attempt -le 15; $Attempt++) { try { Copy-Item -LiteralPath $From -Destination $To -Force; return } catch { Write-UpdateLog ('Copy attempt ' + $Attempt + ' failed: ' + $_.Exception.Message); Start-Sleep -Milliseconds ([Math]::Min(5000, 400 * $Attempt)) } }; throw 'Unable to replace the executable after 15 attempts.' }",
    "$Backup = $Target + '.backup'",
    "$BackupReady = $false",
    "$Started = $null",
    "$WorkDir = Split-Path -Parent $Target",
    "try {",
    "  if ((Get-FileHash -LiteralPath $Source -Algorithm SHA256).Hash -ne $ExpectedHash) { throw 'Update checksum changed before installation.' }",
    "  Write-UpdateLog ('Starting update to ' + $Version + '. Waiting for PID ' + $OldPid + '. Helper PID ' + $PID)",
    "  Set-Content -LiteralPath $ReadyFile -Value 'ready' -Encoding ASCII",
    "  Wait-Process -Id $OldPid -Timeout 60 -ErrorAction SilentlyContinue",
    "  if (Get-Process -Id $OldPid -ErrorAction SilentlyContinue) { throw 'Original application did not exit within 60 seconds.' }",
    "  Start-Sleep -Milliseconds 1000",
    "  Copy-WithRetry $Target $Backup",
    "  $BackupReady = $true",
    "  Copy-WithRetry $Source $Target",
    "  Remove-Item -LiteralPath $StartupFile -Force -ErrorAction SilentlyContinue",
    "  $env:NEURON_UPDATE_STARTUP_MARKER = $StartupFile",
    "  Write-UpdateLog ('Replacement complete. Starting updated application ' + $Version)",
    "  $Started = Start-Process -FilePath $Target -WorkingDirectory $WorkDir -PassThru -WindowStyle Normal",
    "  $StartupDeadline = (Get-Date).AddSeconds($StartupTimeoutSeconds)",
    "  while (-not (Test-Path -LiteralPath $StartupFile) -and (Get-Date) -lt $StartupDeadline) { Start-Sleep -Milliseconds 250 }",
    "  if (-not (Test-Path -LiteralPath $StartupFile)) { throw ('Updated application did not show its main window within ' + $StartupTimeoutSeconds + ' seconds.') }",
    "  $Startup = Get-Content -LiteralPath $StartupFile -Raw | ConvertFrom-Json",
    "  if ($Startup.version -ne $Version) { throw ('Updated application reported version ' + $Startup.version + ' instead of ' + $Version + '.') }",
    "  Write-UpdateLog ('Updated application main window is ready. PID ' + $Startup.pid)",
    "  @{ status = 'success'; version = $Version; time = (Get-Date).ToString('o'); pid = $Started.Id } | ConvertTo-Json | Set-Content -LiteralPath $MarkerFile -Encoding UTF8",
    "  Write-UpdateLog ('Update succeeded. New PID ' + $Started.Id)",
    "  Remove-Item -LiteralPath $Source -Force -ErrorAction SilentlyContinue",
    "  Remove-Item -LiteralPath $Backup -Force -ErrorAction SilentlyContinue",
    "} catch {",
    "  $Failure = $_.Exception.Message",
    "  Write-UpdateLog ('Update failed: ' + $Failure)",
    "  try {",
    "    if ($BackupReady) {",
    "      if ($Started -and -not $Started.HasExited) { Stop-Process -Id $Started.Id -Force -ErrorAction SilentlyContinue; Start-Sleep -Seconds 1 }",
    "      Copy-WithRetry $Backup $Target; Write-UpdateLog 'Previous version restored.'",
    "      Start-Process -FilePath $Target -WorkingDirectory $WorkDir -WindowStyle Normal",
    "    }",
    "  } catch { Write-UpdateLog ('Recovery failed: ' + $_.Exception.Message); $Failure += '; recovery failed: ' + $_.Exception.Message }",
    "  @{ status = 'failed'; version = $Version; time = (Get-Date).ToString('o'); message = $Failure } | ConvertTo-Json | Set-Content -LiteralPath $MarkerFile -Encoding UTF8",
    "}"
  ].join("\r\n"), "utf8");
  sendToRenderer("update:status", { stage: "installing", percent: 100 });
  updateInstalling = true;
  try {
  const diagnosticFile = path.join(updateFolder(), "portable-update-helper.log");
  const psLiteral = (value) => "'" + String(value).replace(/'/g, "''") + "'";
  const argumentsList = ["-OldPid", String(process.pid), "-Source", downloadedUpdate.path, "-Target", target, "-Version", downloadedUpdate.version, "-LogFile", logFile, "-MarkerFile", markerFile, "-ReadyFile", readyFile, "-StartupFile", startupFile, "-StartupTimeoutSeconds", String(startupTimeoutSeconds), "-ExpectedHash", downloadedUpdate.hash];
  const invocation = "& " + psLiteral(script) + " " + argumentsList.map((value, index) => index % 2 ? psLiteral(value) : value).join(" ") + " *> " + psLiteral(diagnosticFile);
  const encoded = Buffer.from(invocation, "utf16le").toString("base64");
  // cmd START creates an independent, hidden PowerShell console. Directly
  // detaching powershell.exe can exit silently before executing its script.
  const command = 'start "" /min "' + powershell + '" -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -EncodedCommand ' + encoded;
  const helper = spawn(process.env.ComSpec || path.join(process.env.SystemRoot || "C:\\Windows", "System32", "cmd.exe"), ["/d", "/s", "/c", command], { detached: true, stdio: "ignore", windowsHide: true, windowsVerbatimArguments: true });
  await new Promise((resolve, reject) => {
    const deadline = Date.now() + 15_000;
    let settled = false;
    const finish = (error) => { if (settled) return; settled = true; clearInterval(timer); helper.removeListener("exit", onExit); helper.removeListener("error", onError); error ? reject(error) : resolve(); };
    const onError = (error) => finish(error);
    const onExit = (code) => { if (code !== 0) finish(new Error(`Update launcher exited (code ${code}). See portable-update-helper.log.`)); };
    const timer = setInterval(() => {
      if (existsSync(readyFile)) finish();
      else if (Date.now() > deadline) { helper.kill(); finish(new Error("Update helper did not become ready. See portable-update-helper.log.")); }
    }, 100);
    helper.once("error", onError);
    helper.once("exit", onExit);
  });
  await rm(readyFile, { force: true }).catch(() => {});
  helper.unref();
  setTimeout(() => app.quit(), 600);
  return true;
  } catch (error) {
    updateInstalling = false;
    sendToRenderer("update:status", { stage: "error", message: error.message });
    throw error;
  }
}

async function machineId() {
  if (machineIdCache) return machineIdCache;
  let source = "";
  try {
    const { stdout } = await promisify(execFile)("reg.exe", ["query", "HKLM\\SOFTWARE\\Microsoft\\Cryptography", "/v", "MachineGuid"], { windowsHide: true });
    source = stdout.match(/MachineGuid\s+REG_SZ\s+([^\r\n]+)/i)?.[1]?.trim() || "";
  } catch {
    const fallbackPath = path.join(app.getPath("userData"), "machine-seed.txt");
    try { source = (await readFile(fallbackPath, "utf8")).trim(); }
    catch { source = randomUUID(); await mkdir(path.dirname(fallbackPath), { recursive: true }); await writeFile(fallbackPath, source, "utf8"); }
  }
  machineIdCache = createHash("sha256").update(`NEURON-WA|${source}|${process.platform}|${process.arch}`).digest("hex");
  return machineIdCache;
}

async function storedLicense() {
  if (!safeStorage.isEncryptionAvailable()) return null;
  try {
    const encoded = await readFile(rememberedLicensePath(), "utf8");
    const payload = JSON.parse(safeStorage.decryptString(Buffer.from(encoded.trim(), "base64")));
    const key = String(payload.key || "").trim();
    return key ? { ...payload, key } : null;
  } catch { return null; }
}

async function saveLicenseKey(key, details = {}) {
  if (!safeStorage.isEncryptionAvailable()) throw new Error("Windows encryption is not available on this computer.");
  const encrypted = safeStorage.encryptString(JSON.stringify({ key, lastValidatedAt: Number(details.lastValidatedAt || Date.now()), expires: String(details.expires || "") }));
  await mkdir(path.dirname(rememberedLicensePath()), { recursive: true });
  await writeFile(rememberedLicensePath(), encrypted.toString("base64"), "utf8");
}

function cachedLicenseIsUsable(stored) {
  const checkedAt = Number(stored?.lastValidatedAt || 0);
  if (!checkedAt || Date.now() - checkedAt > LICENSE_OFFLINE_GRACE_MS) return false;
  const expiry = Date.parse(String(stored?.expires || ""));
  return !Number.isFinite(expiry) || expiry >= Date.now();
}

async function validateLicense(action = "check", suppliedKey = "") {
  const stored = await storedLicense();
  const key = String(suppliedKey || stored?.key || "").trim();
  if (!key) {
    licenseValid = false; licenseExpires = ""; licenseMessage = "Enter a license key to activate this computer.";
    return { valid: false, status: "activation_required", message: licenseMessage, machineId: await machineId(), deviceName: hostname() };
  }
  try {
    const response = await fetch(LICENSE_SERVER_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, key, machineId: await machineId(), deviceName: hostname(), product: "NEURON WA BLASTER" }),
      signal: AbortSignal.timeout(15_000)
    });
    const result = await response.json();
    licenseValid = result.status === "valid";
    licenseMessage = result.message || (licenseValid ? "License active." : "Invalid license.");
    licenseExpires = result.expires || "";
    if (licenseValid) await saveLicenseKey(key, { lastValidatedAt: Date.now(), expires: licenseExpires });
    return { valid: licenseValid, status: result.status, message: licenseMessage, expires: licenseExpires, machineId: await machineId(), deviceName: hostname() };
  } catch (error) {
    if (!suppliedKey && stored?.key === key && cachedLicenseIsUsable(stored)) {
      licenseValid = true; licenseExpires = String(stored.expires || ""); licenseMessage = "License active (offline verification).";
      return { valid: true, status: "valid_offline", message: licenseMessage, expires: licenseExpires, machineId: await machineId(), deviceName: hostname() };
    }
    licenseValid = false; licenseExpires = ""; licenseMessage = error?.message || "License validation failed.";
    return { valid: false, status: "error", message: licenseMessage, machineId: await machineId(), deviceName: hostname() };
  }
}

function requireLicense() { if (!licenseValid) throw new Error("Activate the license before using Neuron WA Blaster."); }

async function ensureWaInitialized() {
  if (waInitialized) return;
  if (waInitializePromise) return waInitializePromise;
  waInitializePromise = waManager.initialize().then(() => { waInitialized = true; }).finally(() => { waInitializePromise = null; });
  return waInitializePromise;
}

function disableWhatsAppEngine() {
  if (!waInitialized) return;
  waManager.shutdown();
  waInitialized = false;
}

function sendToRenderer(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1460,
    height: 920,
    minWidth: 1120,
    minHeight: 720,
    show: false,
    title: "Neuron WA Blaster",
    icon: path.join(here, "..", "assets", "logo.png"),
    backgroundColor: "#071a33",
    webPreferences: {
      preload: path.join(here, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });
  mainWindow.removeMenu();
  mainWindow.loadFile(path.join(here, "index.html"));
  mainWindow.once("ready-to-show", () => {
    mainWindow.show();
    const startupMarker = process.env.NEURON_UPDATE_STARTUP_MARKER;
    if (startupMarker) {
      writeFile(startupMarker, JSON.stringify({ version: app.getVersion(), pid: process.pid }), "utf8")
        .catch((error) => console.error("Unable to confirm updater startup:", error));
    }
  });
}

function registerIpc() {
  ipcMain.handle("theme:set", (_, theme) => {
    nativeTheme.themeSource = theme === "dark" ? "dark" : "light";
    return nativeTheme.shouldUseDarkColors;
  });
  ipcMain.handle("clipboard:write", (_, value) => { clipboard.writeText(String(value || "")); return true; });
  ipcMain.handle("update:set-busy", (_, busy) => { updateBusy = Boolean(busy); return updateBusy; });
  ipcMain.handle("update:check", (_, manual = false) => checkForUpdate(Boolean(manual)));
  ipcMain.handle("update:download", (_, info) => downloadUpdate(info));
  ipcMain.handle("update:install", () => installDownloadedUpdate());
  ipcMain.handle("license:status", async () => { const result = await validateLicense("check"); if (result.valid) await ensureWaInitialized(); else disableWhatsAppEngine(); return result; });
  ipcMain.handle("license:activate", async (_, key) => { const result = await validateLicense("activate", key); if (result.valid) await ensureWaInitialized(); return result; });
  ipcMain.handle("accounts:list", () => { requireLicense(); return waManager.list(); });
  ipcMain.handle("accounts:add", (_, name) => { requireLicense(); return waManager.add(name); });
  ipcMain.handle("accounts:connect", (_, id) => { requireLicense(); return waManager.connect(id, true); });
  ipcMain.handle("accounts:rename", (_, id, name) => { requireLicense(); return waManager.rename(id, name); });
  ipcMain.handle("accounts:logout", (_, id) => { requireLicense(); return waManager.logout(id); });
  ipcMain.handle("accounts:delete", (_, id) => { requireLicense(); return waManager.remove(id); });
  ipcMain.handle("wa:send", (_, job) => { requireLicense(); return waManager.send(job); });
  ipcMain.handle("wa:check-number", (_, job) => { requireLicense(); return waManager.checkNumber(job); });
  ipcMain.handle("warming:groups", (_, accountIds) => { requireLicense(); return waManager.listGroups(accountIds); });
  ipcMain.handle("warming:send", (_, job) => { requireLicense(); return waManager.sendWarmingMessage(job); });
  ipcMain.handle("warming:read", (_, job) => { requireLicense(); return waManager.readGroup(job); });
  ipcMain.handle("media:pick", async (_, kind) => {
    requireLicense();
    const filters = {
      image: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "webp"] }],
      video: [{ name: "Videos", extensions: ["mp4", "mov", "mkv", "webm"] }],
      document: [{ name: "Documents", extensions: ["pdf", "doc", "docx", "xls", "xlsx", "csv", "txt", "zip"] }]
    };
    const result = await dialog.showOpenDialog(mainWindow, { properties: ["openFile"], filters: filters[kind] || filters.document });
    return result.canceled ? null : result.filePaths[0];
  });
}

app.whenReady().then(async () => {
  createWindow();
  waManager = new WhatsAppManager({
    dataDir: path.join(app.getPath("userData"), "wa-accounts"),
    emit: sendToRenderer
  });
  registerIpc();
  const license = await validateLicense("check");
  if (license.valid) await ensureWaInitialized();
  app.on("activate", () => BrowserWindow.getAllWindows().length === 0 && createWindow());
});

app.on("before-quit", () => waManager?.shutdown());
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
