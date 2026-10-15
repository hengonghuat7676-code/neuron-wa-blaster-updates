# Neuron WA Blaster 2.0

Desktop campaign manager with isolated WhatsApp Multi-Device sessions. It supports multiple QR-linked accounts, background connections, contact import, per-account queues, media messages, and an experimental native CTA URL button.

## Development

```powershell
npm.cmd install
npm.cmd run check
npm.cmd run test:qr
npm.cmd start
```

## Build portable EXE

```powershell
npm.cmd run build:portable
```

Campaign data is stored locally in Electron local storage. Linked-device credentials are stored separately in the application's user-data directory. CTA messages use an unofficial WhatsApp internal message format and may require maintenance when WhatsApp changes its protocol. Only message recipients who have opted in.
