# Neuron WA Blaster 3.4.8

## Contacts only

- Add Previous/Next pagination with up to 1,000 contacts per page, page count and visible range.
- Keep selections when changing pages. The table-header checkbox selects available contacts on the current page; Number to select still works across pages.
- Reset pagination when search/view changes and adjust the current page after contacts are removed or assigned.
- Add Export All Contacts (TXT): all contact numbers, including assigned contacts, one number per line, independent of current page, search or selection. Export does not delete or change contacts.

The Account/session manager remains exactly the restored 3.4.5 implementation used in 3.4.7. Sending/CTA payloads, delays, library versions, Warming engine and updater installation/replacement/restart code are unchanged.

Validation includes 3,712-contact pagination and exact 5,000-number TXT Blob export tests, input/dialog regressions, session-source parity, CTA/Warming contracts and packaged updater tests. No local customer EXE is replaced by publishing this release.
