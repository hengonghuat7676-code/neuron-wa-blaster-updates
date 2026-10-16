# Portable release updates

Source version: 3.4.4. Always build a fresh EXE from the matching source commit.

## Build and publish 3.4.4

Use a Windows environment with Node.js and npm installed. From this directory:

```powershell
npm run check
npm run test:updater-regression
npm run test:updater-helper
npm run build:portable
node scripts/test-portable-transaction.mjs
npm run release:prepare
```

Create a published, stable GitHub release tagged `v3.4.4` in
`hengonghuat7676-code/neuron-wa-blaster-updates`. Upload the EXE,
its `.exe.sha256` file and `SHA256SUMS.txt` from `release-assets/v3.4.4`.
Both checksum files must refer to the same EXE. Do not mix assets from other versions.
The preparation script rejects EXEs older than the updater source edits.

Run the existing portable application, pause running tasks, and select
Settings > Check for Updates. The updater works with the portable EXE, not
`win-unpacked`, development mode or an NSIS installation.

If the old executable cannot complete the update, download the new portable
EXE manually, close the old application, and launch the new EXE using the
same Windows account. Keep the existing application user-data folder.

Inspect `updates/portable-update.log` and `updates/portable-update-result.json`
inside the application user-data directory for replacement/restart failures.
`updates/portable-update-helper.log` captures PowerShell startup errors. The
previous application stays open until the helper is ready. The helper only
reports success after the updated application's main window is ready to show.

## GitHub build workflow

Upload the source files, assets, scripts, package files, and `.github` directory
to the repository. Do not upload user-data directories, WhatsApp sessions,
`node_modules`, or old build outputs. Run **Build portable EXE** from Actions.
With `publish` disabled it produces a downloadable release artifact. Enable
`publish` to create a new stable release. Existing releases are never overwritten.

## 3.4.3 launcher repair

Launching PowerShell directly with Node's `detached: true` can exit silently
before executing the update script. The updater now uses an independent CMD
START launcher with hidden PowerShell, encoded arguments and a unique readiness
marker. A launcher exit code of zero alone is not treated as helper readiness.
The old application stays open if readiness fails; diagnostic errors are saved.
Startup confirmation allows 90 seconds for portable extraction and launch.

Existing 3.4.2 clients still run their old launcher when trying to install a new
release. If that update fails, download and run the 3.4.3 portable EXE manually
once, under the same Windows account. Preserve the application user-data folder.
Publishing 3.4.3 does not retroactively change the updater inside older EXEs.

## Existing 3.4.0 release

The root `release-assets` directory includes the existing 3.4.0 EXE and matching
checksums. This repairs the local release inputs for older clients updating to
3.4.0; it does not insert the source fixes into that EXE. Use a separate release
tag for each version. Older 3.3.x assets are retained for reference.
