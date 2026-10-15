const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { pipeline } = require('node:stream/promises');

async function main() {
  const source = fs.readFileSync(path.join(__dirname, '../app/main.mjs'), 'utf8');
  const context = vm.createContext({
    Buffer, pipeline, setTimeout, https: http, createWriteStream: fs.createWriteStream,
    existsSync: fs.existsSync, statSync: fs.statSync,
    activeDownload: null, checkedUpdate: null,
    app: { getVersion: () => '3.4.0' },
    readUpdateState: async () => ({}), writeUpdateState: async () => {},
    UPDATE_API: 'unused', UPDATE_INTERVAL_MS: 86400000,
    githubRequest: async () => context.releaseResponse
  });
  for (const [start, end] of [
    ['function versionParts(', 'function githubRequest('],
    ['async function checkForUpdate(', 'function downloadToFile('],
    ['function downloadToFile(', 'async function downloadUpdate(']
  ]) vm.runInContext(source.slice(source.indexOf(start), source.indexOf(end)), context);
  const hash = 'a'.repeat(64);
  assert.equal(context.checksumForFile(`${hash}  old.exe`, 'new.exe'), '');
  assert.equal(context.checksumForFile(`${hash} *new.exe`, 'new.exe'), hash);
  assert.equal(context.checksumForFile(hash, 'new.exe'), hash);
  context.releaseResponse = { status: 404 };
  assert.match((await context.checkForUpdate(true)).error, /404/);
  const asset = (name) => ({ name, browser_download_url: name });
  context.releaseResponse = { status: 200, body: Buffer.from(JSON.stringify({
    tag_name: 'v3.4.1', assets: [asset('SHA256SUMS.txt'), asset('Neuron-WA-Blaster-3.4.1.exe'), asset('Neuron-WA-Blaster-3.4.1.exe.sha256')]
  })) };
  assert.equal((await context.checkForUpdate(true)).checksumUrl, 'Neuron-WA-Blaster-3.4.1.exe.sha256');
  context.releaseResponse = { status: 200, body: Buffer.from(JSON.stringify({ tag_name: 'v3.4.1', assets: [] })) };
  assert.match((await context.checkForUpdate(true)).error, /missing/);
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'neuron-update-test-'));
  if (process.platform === 'win32') {
    const { spawn, execFileSync } = require('node:child_process');
    const crypto = require('node:crypto');
    const helperSource = source.match(/await writeFile\(script, (\[[\s\S]*?\]\.join\("\\r\\n"\)), "utf8"\);/);
    assert.ok(helperSource, 'Portable helper source must be present');
    const script = path.join(folder, 'apply update.ps1');
    const helperText = vm.runInNewContext(helperSource[1]);
    assert.match(helperText, /NEURON_UPDATE_STARTUP_MARKER/);
    assert.match(helperText, /Updated application main window is ready/);
    assert.match(helperText, /did not show its main window/);
    fs.writeFileSync(script, helperText);
    const powershell = path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe');
    execFileSync(powershell, ['-NoProfile', '-NonInteractive', '-Command', '$e=$null; $t=$null; [void][System.Management.Automation.Language.Parser]::ParseFile($env:NEURON_TEST_SCRIPT,[ref]$t,[ref]$e); if($e.Count){$e | Out-String | Write-Error; exit 1}'], {
      windowsHide: true, env: { ...process.env, NEURON_TEST_SCRIPT: script }
    });
    const payload = path.join(folder, 'source file.download');
    fs.writeFileSync(payload, 'test payload');
    const ready = path.join(folder, 'ready.txt');
    const helper = spawn(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script,
      '-OldPid', String(process.pid), '-Source', payload, '-Target', path.join(folder, 'unused.exe'),
      '-Version', '3.4.1', '-LogFile', path.join(folder, 'helper.log'), '-MarkerFile', path.join(folder, 'result.json'),
      '-ReadyFile', ready, '-ExpectedHash', crypto.createHash('sha256').update('test payload').digest('hex')], {
      windowsHide: true, stdio: 'ignore'
    });
    try {
      const deadline = Date.now() + 10000;
      while (!fs.existsSync(ready) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100));
      assert.ok(fs.existsSync(ready), 'PowerShell helper must signal readiness before application exit');
      assert.ok(!fs.existsSync(path.join(folder, 'unused.exe')), 'Readiness must not replace an executable while the old process is alive');
    } finally {
      const exited = new Promise(resolve => helper.once('exit', resolve));
      helper.kill();
      await exited;
    }
  }
  let interrupted = false;
  const payload = Buffer.from('resumable update payload');
  const server = http.createServer((req, res) => {
    if (req.url === '/resume') {
      const offset = Number((req.headers.range || '').match(/^bytes=(\d+)-$/)?.[1] || 0);
      if (!interrupted) {
        interrupted = true;
        res.writeHead(200, { 'Content-Length': payload.length });
        res.write(payload.subarray(0, 8));
        setTimeout(() => res.destroy(), 20);
        return;
      }
      res.writeHead(206, { 'Content-Length': payload.length - offset, 'Content-Range': `bytes ${offset}-${payload.length - 1}/${payload.length}` });
      res.end(payload.subarray(offset));
      return;
    }
    if (req.url === '/broken') {
      res.writeHead(200, { 'Content-Length': 100 });
      res.write('partial');
      setTimeout(() => res.destroy(), 20);
    } else { res.end('complete'); }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const dest = path.join(folder, 'download');
    await context.downloadToFile(`${base}/ok`, dest, () => {});
    assert.equal(fs.readFileSync(dest, 'utf8'), 'complete');
    const resumable = path.join(folder, 'resumable-download');
    await context.downloadToFile(`${base}/resume`, resumable, () => {});
    assert.equal(fs.readFileSync(resumable).toString(), payload.toString());
    assert.equal(interrupted, true, 'A transient connection reset must be retried');
    await assert.rejects(context.downloadToFile(`${base}/broken`, dest, () => {}));
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(folder, { recursive: true, force: true });
  }
  console.log('PASS: checksum matching, release validation, download interruptions, PowerShell parsing and readiness handshake');
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
