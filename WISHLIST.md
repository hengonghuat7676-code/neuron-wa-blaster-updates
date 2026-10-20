# Neuron WA Blaster Wishlist

## 3.4.8 - Contacts pagination and Export All TXT (2026-10-20)

- [x] Show up to 1000 contacts per page with Previous/Next, page count and visible range. Reset to page 1 on search/view changes and clamp the page after data shrinks.
- [x] Preserve selections across pages; the table-header checkbox selects available contacts on the current page. Number to select remains cross-page.
- [x] Export All Contacts (TXT): every stored contact number, including assigned contacts, one per line, regardless of search, selection or page. Do not remove/change contacts.
- [x] Add isolated regression coverage using 3712/5000 synthetic contacts. No changes to Account/session, Sending, CTA, delays or updater installation code.

## 3.4.7 - Restore the 3.4.5 Account/session implementation (2026-10-19)

- [x] Restore the entire `app/wa-manager.mjs` exactly to 3.4.5 commit `6022460`; no new sending/session mechanisms. This reverts items 5-11 discussed with the user, including queued authentication writes, lifecycle locks, socket cleanup/callback guards, reconnect changes, automatic remote-logout cleanup, 403 handling and startup handling of logged-out accounts.
- [x] Retain the 3.4.6 input/dialog focus, QR-dialog tracking and Warming numeric-draft UI fixes. Keep the updater installation transaction unchanged.
- [x] Adjust session regression tests to enforce exact 3.4.5 source parity and the restored manual-logout behavior rather than requiring the reverted 3.4.6 mechanisms.
- [ ] Validate behavior on the user's real installation. This rollback does not prove the cause of WhatsApp restrictions or guarantee against restrictions/bans.

## Implemented in 3.4.6 - Input focus and dialog reliability

Implementation authorized on 2026-10-18. Automated regression results are recorded below; real-user Windows validation remains separate.

- [x] Replace all native confirm/prompt dialogs with asynchronous in-app dialogs and restore content focus after close without stealing OS activation.
- [x] Preserve all eight Warming numeric drafts during render/account-status updates.
- [x] Clear QR tracking on close/cancel/Escape and ignore stale close events after reopening.
- [x] Add isolated regression tests: 26 editable fields across four phases, all eight numeric drafts, campaign delete/cancel, QR close and Escape.
- [ ] Verify the originally reported freeze with physical Windows keyboard input after Delete Campaign, logout, QR scan/close and native file pickers on the user's updated installation; automated CDP tests alone do not certify these paths.

## Historical: 3.4.6 session changes - reverted in 3.4.7

The items below describe 3.4.6 only. They are not the behavior of 3.4.7; automatic remote-logout cleanup is deferred again as part of the authorized full session rollback.

- [x] Clean the affected account's session after manual Logout and confirmed WhatsApp logout/unlink (401).
- [x] Serialize lifecycle operations, drain pending authentication writes, cancel reconnects and invalidate stale socket callbacks before reset/new pairing.
- [x] Preserve account entries, other sessions and application data. Keep authentication on temporary disconnects and access-denied responses that do not prove logout.
- [x] Add synthetic regression tests for manual/remote logout, pending writes, stale callbacks, retry cancellation, account isolation and restart.
- [ ] Verify real phone unlink and fresh QR pairing using an authorized test account; synthetic tests do not perform a live WhatsApp login.

## Updater fixes in 3.4.1

- [x] Reject checksums naming a different EXE and prefer version-specific release assets.
- [x] Fail interrupted downloads and prevent concurrent update downloads.
- [x] Start PowerShell using its absolute Windows path and capture helper diagnostics.
- [x] Require a helper readiness signal before closing the existing application.
- [x] Recheck SHA-256 before replacement and avoid restoring an incomplete backup.
- [x] Add regression coverage for download interruptions and the real PowerShell readiness signal.
- [x] Add versioned release preparation and a manually triggered Windows build workflow.
- [ ] Publish 3.4.1 after granting repository write access.
- [ ] Verify replacement and restart between two packaged versions on a spare Windows computer.

## Completed in 3.3.2

- [x] Replace the custom CTA metadata with a minimal native-flow URL button structure.
- [x] Keep image, caption, footer, URL button, and personalized fallback URL support.
- [x] Add keep-alive, longer connection timeouts, request retry delay, and current protocol-version detection.
- [x] Replace the single reconnect attempt with continuous exponential-backoff retries.
- [x] Distinguish temporary interruptions from logged-out and forbidden sessions.
- [x] Keep the assigned account visible while it is reconnecting.
- [x] Show the last disconnect reason, status code, reconnect attempt, and countdown.
- [x] Automatically continue a campaign after the same account reconnects when no message is unconfirmed.
- [x] Preserve duplicate protection by requiring Retry or Skip for an unconfirmed message.
- [x] Explain long sending delays in seconds, minutes, and hours.
- [x] Retry portable EXE replacement when Windows temporarily locks the file.
- [x] Restart the updated EXE with an explicit working directory.
- [x] Record a portable updater log and success/failure marker.
- [x] Verify that the updated process remains alive after launch.
- [x] Restore and reopen the previous EXE when replacement or launch fails.

## Next validation

- [ ] Complete a real two-version packaged update test on a spare Windows computer.
- [x] Complete an isolated local 3.3.2 to 3.3.3 updater test: GitHub download, SHA verification, EXE replacement, restart, process-alive verification, log, and success marker.
- [x] Run a controlled CTA delivery test using a spare WhatsApp account and opted-in recipient (4 successful recipients, no disconnect).
- [ ] Observe a long-idle campaign and a simulated network interruption before publishing broadly.

## Completed in 3.3.3

- [x] Hide the previous disconnect diagnostic after an account reconnects successfully, including stale `Code 515 — WhatsApp requested a restart`.
- [x] Add `Auto Skip & Continue` for unconfirmed messages: never resend the uncertain message automatically, record it as skipped in History, wait for the assigned account to reconnect, and continue with the next recipient without manual monitoring.

## Completed in 3.3.4

- [x] Restore reliable manual typing in Contacts > Number to select without re-rendering the contact table on every keystroke.
- [x] Allow the quantity field to be temporarily empty while editing and validate it only when selecting contacts.

## Completed in 3.3.5

- [x] Match Hero Wasep's Windows/Chrome device identity for CTA delivery while negotiating a current WhatsApp Web protocol version required for new QR pairing.
- [x] Match Hero Wasep's Baileys rc9 sending engine and apply the official self-only protocol-message guard without changing its outgoing CTA transport.
- [x] Match Hero's direct PN-JID recipient addressing, legacy message ID, media header, 32-byte message secret, and full presence sequence before CTA relay.

## Completed in 3.4.0

- [x] Add a persistent WhatsApp Number Filter staging page with CSV/TXT import and local duplicate validation.
- [x] Add selectable multi-session round-robin checking with per-session progress and pause/resume/stop controls.
- [x] Separate Registered, Not Registered, Unchecked, and Check Failed results.
- [x] Add Select All Registered, Recheck Registered, Retry Failed, Add Selected to Contacts, Clear Not Registered, and Clear All Filter actions.
- [x] Remove registered numbers from Filter immediately after they are moved to Contacts.
- [x] Keep Contacts responsive during campaign sending by avoiding full contact-table rebuilds for every delivery update.
- [x] Limit very large Contacts, Filter, and History DOM renders while keeping full data available to search and batch actions.
- [x] Delete a campaign's assigned contacts together with the campaign instead of returning them to Available Contacts.
- [x] Preserve campaign pause, account replacement, and resume behavior when a WhatsApp session disconnects.

## Future ideas

- [ ] Add an in-app connection diagnostic history export.
- [ ] Add optional per-account daily sending limits.
- [ ] Add scheduled campaign start times.
