import fs from "node:fs/promises";
import path from "node:path";
import { WhatsAppManager } from "../app/wa-manager.mjs";

const dataDir = path.resolve(".qr-smoke-profile");
let settled = false;
const manager = new WhatsAppManager({
  dataDir,
  emit(channel, payload) {
    if (channel === "account:qr" && payload.dataUrl && !settled) {
      settled = true;
      console.log(`QR_READY ${payload.dataUrl.slice(0, 30)}`);
    }
  }
});

try {
  await manager.initialize();
  await manager.add("QR Smoke Test");
  const deadline = Date.now() + 45_000;
  while (!settled && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 250));
  if (!settled) throw new Error("QR was not generated within 45 seconds");
} finally {
  manager.shutdown();
  await new Promise((resolve) => setTimeout(resolve, 500));
  await fs.rm(dataDir, { recursive: true, force: true });
}
