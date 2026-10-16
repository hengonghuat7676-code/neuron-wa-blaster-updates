import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import vm from 'node:vm';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';

// Exercise the real generated PowerShell and handshake without closing Neuron
// or replacing any installed EXE. The helper waits for this test's live PID.
const source = await fsp.readFile(new URL('../app/main.mjs', import.meta.url), 'utf8');
const install = source.slice(source.indexOf('async function installDownloadedUpdate()'), source.indexOf('async function machineId()'));
if (process.argv[2] === '--survival-child') {
  const testDir = process.argv[3];
  const download = path.join(testDir, 'update.download');
  const context = {
    ...fsp, existsSync: fs.existsSync, openSync: fs.openSync, closeSync: fs.closeSync,
    path, Buffer, createHash, randomUUID, setTimeout, setInterval, clearInterval,
    updateBusy: false, updateInstalling: false,
    app: { isPackaged: true, quit() { process.exit(0); } },
    process: { pid: process.pid, env: { ...process.env, PORTABLE_EXECUTABLE_FILE: path.join(testDir, 'target.exe') } },
    downloadedUpdate: { path: download, version: '3.4.2', hash: createHash('sha256').update(await fsp.readFile(download)).digest('hex') },
    updateFolder: () => testDir, sendToRenderer() {}, spawn
  };
  vm.createContext(context);
  await vm.runInContext(install + '\ninstallDownloadedUpdate()', context);
} else {
const folder = await fsp.mkdtemp(path.join(os.tmpdir(), 'neuron-updater-test-'));
try {
  for (const failure of [false, true]) {
    const testDir = path.join(folder, failure ? 'failure' : 'ready');
    await fsp.mkdir(testDir);
    const download = path.join(testDir, 'update.download');
    await fsp.writeFile(download, 'isolated updater fixture');
    let quitCalls = 0;
    let helper;
    const statuses = [];
    const context = {
      ...fsp, existsSync: fs.existsSync, openSync: fs.openSync, closeSync: fs.closeSync,
      path, Buffer, createHash, randomUUID, setTimeout, setInterval, clearInterval,
      updateBusy: false, updateInstalling: false,
      app: { isPackaged: true, quit() { quitCalls++; } },
      process: { pid: process.pid, env: { ...process.env, PORTABLE_EXECUTABLE_FILE: path.join(testDir, 'target.exe') } },
      downloadedUpdate: { path: download, version: '3.4.2', hash: createHash('sha256').update(await fsp.readFile(download)).digest('hex') },
      updateFolder: () => testDir,
      sendToRenderer: (channel, value) => statuses.push(value),
      spawn: (file, args, options) => {
        if (failure) {
          const script = path.join(testDir, 'apply-portable-update.ps1');
          fs.writeFileSync(script, fs.readFileSync(script, 'utf8').replace("if ((Get-FileHash", "$ExpectedHash = 'wrong'; if ((Get-FileHash"));
        }
        helper = spawn(file, args, options);
        return helper;
      }
    };
    vm.createContext(context);
    try {
      const result = vm.runInContext(install + '\ninstallDownloadedUpdate()', context);
      if (failure) {
        await assert.rejects(result, /helper did not become ready/);
        assert.equal(quitCalls, 0, 'App must stay open when helper fails');
        assert.equal(statuses.at(-1).stage, 'error');
        assert.match(await fsp.readFile(path.join(testDir, 'portable-update.log'), 'utf8'), /checksum changed/);
      } else {
        assert.equal(await result, true);
        await new Promise(resolve => setTimeout(resolve, 700));
        assert.equal(quitCalls, 1);
        assert.match(await fsp.readFile(path.join(testDir, 'portable-update.log'), 'utf8'), /Starting update to 3.4.2/);
        assert.equal(fs.existsSync(path.join(testDir, 'target.exe')), false);
      }
      console.log(failure ? 'PASS: helper failure logged; application stays open' : 'PASS: real PowerShell ready before application quits');
    } catch (error) {
      for (const name of ['portable-update-helper.log', 'portable-update.log']) {
        console.error(name, await fsp.readFile(path.join(testDir, name), 'utf8').catch(() => '(missing)'));
      }
      throw error;
    } finally {
      const log = await fsp.readFile(path.join(testDir, 'portable-update.log'), 'utf8').catch(() => '');
      const helperPid = log.match(/Helper PID (\d+)/)?.[1];
      if (helperPid) { try { process.kill(Number(helperPid)); } catch {} }
      if (helper && helper.exitCode === null) {
        helper.ref();
        await new Promise(resolve => { helper.once('exit', resolve); helper.kill(); });
      }
    }
  }
  const survivorDir = path.join(folder, 'parent-exit');
  await fsp.mkdir(survivorDir);
  await fsp.writeFile(path.join(survivorDir, 'target.exe'), 'original disposable fixture');
  await fsp.writeFile(path.join(survivorDir, 'update.download'), 'invalid executable exercises rollback');
  const child = spawn(process.execPath, [new URL(import.meta.url).pathname.replace(/^\//, '').replace(/%20/g, ' '), '--survival-child', survivorDir], { stdio: 'inherit', windowsHide: true });
  await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', code => code === 0 ? resolve() : reject(new Error(`Test parent failed: ${code}`))); });
  const resultFile = path.join(survivorDir, 'portable-update-result.json');
  const deadline = Date.now() + 20_000;
  while (!fs.existsSync(resultFile) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 200));
  assert.equal(fs.existsSync(resultFile), true, 'Helper must survive parent exit and finish transaction');
  const transaction = JSON.parse((await fsp.readFile(resultFile, 'utf8')).replace(/^\uFEFF/, ''));
  assert.equal(transaction.status, 'failed');
  const log = await fsp.readFile(path.join(survivorDir, 'portable-update.log'), 'utf8');
  assert.match(log, /Replacement complete/);
  assert.match(log, /Previous version restored/);
  assert.equal(await fsp.readFile(path.join(survivorDir, 'target.exe'), 'utf8'), 'original disposable fixture');
  console.log('PASS: helper survives parent exit, replaces disposable file, and restores it after failed launch');
} finally {
  await fsp.rm(folder, { recursive: true, force: true });
}
}
