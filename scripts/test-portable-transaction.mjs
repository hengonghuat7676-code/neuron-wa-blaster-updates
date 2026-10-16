import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { spawn, execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';

// Exercise the real helper replacing a disposable portable EXE, restarting the
// actual packaged app and checking its version/window marker. Never use live data.
const source = await fsp.readFile(new URL('../app/main.mjs', import.meta.url), 'utf8');
const install = source.slice(source.indexOf('async function installDownloadedUpdate()'), source.indexOf('async function machineId()'));
const version = JSON.parse(await fsp.readFile(new URL('../package.json', import.meta.url), 'utf8')).version;
if (process.argv[2] === '--child') {
  const folder = process.argv[3];
  const payload = path.join(folder, 'update.download');
  const context = {
    ...fsp, existsSync: fs.existsSync, path, Buffer, createHash, randomUUID,
    setTimeout, setInterval, clearInterval, spawn,
    updateBusy: false, updateInstalling: false,
    process: { pid: process.pid, env: { ...process.env, PORTABLE_EXECUTABLE_FILE: path.join(folder, 'Portable Test.exe') } },
    app: { isPackaged: true, quit() { process.exit(0); } },
    downloadedUpdate: { path: payload, version, hash: createHash('sha256').update(await fsp.readFile(payload)).digest('hex') },
    updateFolder: () => folder, sendToRenderer() {}
  };
  vm.createContext(context);
  await vm.runInContext(install + '\ninstallDownloadedUpdate()', context);
} else {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const asar = (await import('@electron/asar')).default;
  const archive = path.join(root, 'dist/win-unpacked/resources/app.asar');
  assert.equal(JSON.parse(asar.extractFile(archive, 'package.json').toString()).version, version);
  assert.equal(asar.extractFile(archive, 'app/main.mjs').toString(), source);
  const folder = await fsp.mkdtemp(path.join(os.tmpdir(), "neuron portable's test-"));
  let appPid;
  let launcherPid;
  try {
    const built = path.join(root, `dist/Neuron-WA-Blaster-${version}.exe`);
    const old = process.argv[2] ? path.resolve(process.argv[2]) : built;
    const target = path.join(folder, 'Portable Test.exe');
    await fsp.copyFile(old, target);
    await fsp.copyFile(built, path.join(folder, 'update.download'));
    const testEnvironment = { ...process.env, NEURON_USER_DATA_DIR: path.join(folder, 'isolated-data') };
    // Coding/test shells may force Electron into Node-only mode. Customers
    // launching the portable normally do not have this development variable.
    delete testEnvironment.ELECTRON_RUN_AS_NODE;
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--child', folder], {
      stdio: 'inherit', windowsHide: true,
      env: testEnvironment
    });
    await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', code => code === 0 ? resolve() : reject(new Error(`Test parent exit ${code}`)));
    });
    const resultPath = path.join(folder, 'portable-update-result.json');
    const deadline = Date.now() + 110_000;
    while (!fs.existsSync(resultPath) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 250));
    assert.equal(fs.existsSync(resultPath), true, 'Helper must complete after parent exit');
    const result = JSON.parse((await fsp.readFile(resultPath, 'utf8')).replace(/^\uFEFF/, ''));
    launcherPid = result.pid;
    const marker = (await fsp.readdir(folder)).find(name => name.startsWith('app-started-'));
    const started = marker ? JSON.parse(await fsp.readFile(path.join(folder, marker), 'utf8')) : {};
    appPid = started.pid;
    console.log(await fsp.readFile(path.join(folder, 'portable-update.log'), 'utf8'));
    assert.equal(result.status, 'success', result.message);
    assert.equal(result.version, version);
    assert.equal(started.version, version);
    assert.ok(appPid);
    process.kill(appPid, 0);
    const hash = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    assert.equal(hash(target), hash(built), 'Installed portable must match the new build');
    console.log(`PASS: actual portable replaced, ${version} main window confirmed, updated process alive, checksum matched`);
  } finally {
    for (const pid of [appPid, launcherPid].filter(Boolean)) {
      try { execFileSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); } catch {}
    }
    await fsp.rm(folder, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
  }
}
