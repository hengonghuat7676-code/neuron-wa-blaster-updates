import fs from "node:fs";

const html = fs.readFileSync(new URL("../app/index.html", import.meta.url), "utf8");
const renderer = fs.readFileSync(new URL("../app/renderer.js", import.meta.url), "utf8");
const preload = fs.readFileSync(new URL("../app/preload.cjs", import.meta.url), "utf8");
const main = fs.readFileSync(new URL("../app/main.mjs", import.meta.url), "utf8");
const manager = fs.readFileSync(new URL("../app/wa-manager.mjs", import.meta.url), "utf8");
const ids = [...html.matchAll(/id="([^"]+)"/g)].map((match) => match[1]);
const duplicates = ids.filter((id, index) => ids.indexOf(id) !== index);
if (duplicates.length) throw new Error(`Duplicate IDs: ${duplicates.join(", ")}`);
const references = [...renderer.matchAll(/\$\("#([A-Za-z0-9_-]+)/g)].map((match) => match[1]);
const missing = [...new Set(references.filter((id) => id !== "page-" && !ids.includes(id)))];
if (missing.length) throw new Error(`Missing DOM IDs: ${missing.join(", ")}`);
for (const required of ["page-filter", "filterAccounts", "startFilter", "addFilteredContacts", "clearNotRegistered", "recheckRegistered"]) {
  if (!ids.includes(required)) throw new Error(`Missing WA Filter control: ${required}`);
}
if (!preload.includes('ipcRenderer.invoke("wa:check-number"') || !main.includes('ipcMain.handle("wa:check-number"') || !manager.includes("async checkNumber") || !manager.includes("socket.onWhatsApp")) throw new Error("WA Filter IPC contract is incomplete");
console.log(`UI contract OK: ${ids.length} unique IDs and ${references.length} references checked.`);
