# Neuron WA Blaster 3.4.6

- Replace blocking native confirm/prompt dialogs with asynchronous in-app confirmation and rename dialogs to avoid the Windows keyboard-focus failure after campaign deletion, logout and similar actions.
- Restore content focus after dialogs close without activating Neuron over another application. Keep confirmation/cancel safeguards and recheck campaign/filter activity before destructive actions.
- Clear QR tracking on close, cancel and Escape; ignore stale close events after a new QR dialog opens.
- Preserve all eight Warming numeric settings while they are actively being edited during account/status refreshes.
- Remove the affected account's authentication/session files after confirmed WhatsApp logout/unlink as well as manual Logout. Retain the account entry for fresh QR pairing.
- Serialize session lifecycle operations, drain credential writes, cancel reconnect timers and ignore stale socket callbacks before resetting sessions.
- Preserve authentication on temporary network failures and on access-denied responses that alone do not prove logout. Contacts, campaigns, progress, history, licensing and other accounts are not reset.
- Add isolated input/dialog and session-cleanup regression suites to the Windows release workflow.

The portable download/install/replacement/restart updater transaction is unchanged. Sending payloads, CTA transport and delay limits are unchanged.

Validation includes automated Chromium input tests, not a physical-keyboard guarantee on every Windows installation. Verify the previously affected actions after updating; no Alt+Tab should be needed for the replaced native confirmation paths.
