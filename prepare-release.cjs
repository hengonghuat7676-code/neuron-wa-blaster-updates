const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '..');
const version = require('../package.json').version;
const input = path.resolve(root, process.argv[2] || `dist/Neuron-WA-Blaster-${version}.exe`);
const output = path.join(root, 'release-assets', `v${version}`);
if (!fs.existsSync(input)) throw new Error(`Build the ${version} portable EXE first: ${input}`);
const info = fs.statSync(input);
if (process.platform === 'win32') {
  const { execFileSync } = require('node:child_process');
  const shell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const actualVersion = execFileSync(shell, ['-NoProfile', '-NonInteractive', '-Command', '(Get-Item -LiteralPath $env:NEURON_RELEASE_EXE).VersionInfo.ProductVersion'], {
    encoding: 'utf8', windowsHide: true, env: { ...process.env, NEURON_RELEASE_EXE: input }
  }).trim();
  if (actualVersion !== version) throw new Error(`EXE version ${actualVersion} does not match source version ${version}. Rebuild first.`);
}
if (info.mtimeMs < fs.statSync(path.join(root, 'app/main.mjs')).mtimeMs) {
  throw new Error('EXE predates updater source changes. Rebuild before preparing a release.');
}
const filename = `Neuron-WA-Blaster-${version}.exe`;
fs.mkdirSync(output, { recursive: true });
const destination = path.join(output, filename);
fs.copyFileSync(input, destination);
const hash = crypto.createHash('sha256').update(fs.readFileSync(destination)).digest('hex');
const checksum = `${hash} *${filename}\n`;
fs.writeFileSync(path.join(output, `${filename}.sha256`), checksum);
fs.writeFileSync(path.join(output, 'SHA256SUMS.txt'), checksum);
console.log(`Release ${version} prepared in ${output}. Upload only the EXE and these matching checksums to tag v${version}.`);
