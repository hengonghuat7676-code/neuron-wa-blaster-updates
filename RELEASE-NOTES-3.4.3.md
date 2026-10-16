# Neuron WA Blaster v3.4.3

- Fix portable updater helper exiting silently before installation on Windows.
- Launch hidden PowerShell through an independent CMD START launcher.
- Keep the current app open until the update helper confirms it is ready.
- Capture helper startup errors and prevent overlapping installation launches.
- Allow up to 90 seconds for the updated app to confirm its version and window.
- Preserve the v3.4.2 release validation, download recovery and checksum checks.

Important for existing v3.4.2 users: if auto-update fails, download and run
`Neuron-WA-Blaster-3.4.3.exe` manually once. Keep existing user data. Older EXEs
still use their existing updater to perform that first upgrade.

Customers need only the EXE. The checksum assets are used by auto-update.
