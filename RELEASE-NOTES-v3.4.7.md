# Neuron WA Blaster 3.4.7

- Restore the complete WhatsApp Account/session manager to the exact 3.4.5 implementation (source commit 6022460), without introducing new sending or session mechanisms.
- Revert the 3.4.6 authentication-write queue, account lifecycle locks, connection teardown/callback guards, reconnect changes, remote-logout cleanup, 403 handling and startup handling of logged-out accounts.
- Retain the 3.4.6 in-app confirmation/rename dialogs, input-focus recovery, QR-dialog tracking cleanup and protection of Warming numeric drafts.
- Keep the library versions, sending/CTA payloads, sending delays and portable updater installation/replacement/restart transaction unchanged.
- Verify exact 3.4.5 session-source parity in the regression suite, alongside manual logout/account isolation and the retained UI/updater tests.

Behavior note: session handling is now the same as 3.4.5, including no automatic authentication-folder deletion after remote WhatsApp logout. Manual Logout retains its original 3.4.5 cleanup behavior.

This rollback addresses a suspected regression; it does not establish why WhatsApp restricted an account, remove existing restrictions or guarantee against restrictions/bans. Real-account behavior still requires validation by the user.

The portable EXE and matching SHA-256 files are provided below. No installed/local EXE is replaced by publishing this release.
