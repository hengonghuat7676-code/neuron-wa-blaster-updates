const port = Number(process.argv[2] || 9335);
let targets;
for (let attempt = 0; attempt < 40; attempt += 1) {
  try {
    targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
    if (targets.some((item) => item.type === "page")) break;
  } catch {}
  await new Promise((resolve) => setTimeout(resolve, 500));
}
const target = targets?.find((item) => item.type === "page" && item.title === "Neuron WA Blaster");
if (!target) throw new Error(`Neuron WA Blaster debug page was not found on port ${port}`);

const socket = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { socket.addEventListener("open", resolve, { once: true }); socket.addEventListener("error", reject, { once: true }); });
let commandId = 0;
const pending = new Map();
socket.addEventListener("message", (event) => {
  const message = JSON.parse(event.data);
  if (!message.id || !pending.has(message.id)) return;
  const request = pending.get(message.id);
  pending.delete(message.id);
  if (message.error) request.reject(new Error(message.error.message)); else request.resolve(message.result);
});
function command(method, params = {}) {
  const id = ++commandId;
  socket.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}
await command("Runtime.enable");
const expression = `(async()=>{ const info=await window.neuron.checkForUpdates(true); if(!info.available) throw new Error('Expected an available update, received '+JSON.stringify(info)); const downloaded=await window.neuron.downloadUpdate(info); await window.neuron.installUpdate(); return {currentVersion:info.currentVersion,latestVersion:info.latestVersion,downloaded}; })()`;
const response = await command("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text);
console.log("Packaged updater started:", JSON.stringify(response.result.value));
socket.close();
