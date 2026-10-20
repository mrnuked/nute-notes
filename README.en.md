<p align="center"><img src="public/assets/nute-logo.png" width="128" alt="Nute Notes"></p>

# Nute Notes

**Your notes. Your server. Your control.**

A free, self-hosted alternative to Apple Notes for people who want to keep their personal notes on their own server. Write in the browser or an installed client, edit offline in supported clients, and synchronize devices through your own instance.

[Русский](README.md) · [Server installation (RU)](docs/INSTALL.md) · [User guide (RU)](docs/USER-GUIDE.md) · [Desktop builds (RU)](docs/DESKTOP.md) · [Android builds (RU)](docs/ANDROID.md)

## Features

- Notes, folders, search, pinning, and trash.
- Rich text, headings, lists, checklists, and tables.
- Autosave and synchronization of edits and deletions, with conflict copies.
- An encrypted local outbox for offline editing in installed clients.
- Client-side encryption, TOTP authentication, recovery codes, and **180-day device trust**.
- An optional four-digit note PIN, encrypted export, and import.
- Source code for Windows, Ubuntu, and Android clients.

**One installation has one owner.** For another person, deploy an independent instance with a new database and keys. There is no public signup, collaborative editing, attachment support, or iOS client in this release.

## Deploy

Use a fresh Ubuntu 24.04/26.04 VPS with systemd, root access, a domain, and publicly reachable TCP ports 80 and 443. At least 2 GB RAM is recommended. After configuring DNS:

```bash
sudo apt update
sudo apt install git
git clone https://github.com/mrnuked/nute-notes.git
cd nute-notes
sudo bash installer/install.sh --domain notes.example.org --email admin@example.org --check
sudo bash installer/install.sh --domain notes.example.org --email admin@example.org
```

Replace the example domain and email. Read the one-time token with `sudo cat /srv/nute/private/first-owner.txt`, then visit `https://notes.example.org/?setup` to create the owner.

Read the [full installation guide](docs/INSTALL.md) before running the root installer. It installs Nginx, PHP-FPM, MySQL, TLS, and local backups. It refuses to overwrite an existing installation; it is not an upgrade or migration tool.

## Release status and control

[Release 0.5.0](https://github.com/mrnuked/nute-notes/releases/tag/v0.5.0) includes a server archive and an Ubuntu x86-64 `.deb`. Windows and Android are provided as source; no EXE/APK is published in this release. Desktop clients let you choose an HTTPS server and keep per-domain profiles separate. Android builds target a specified server.

The Ubuntu package was built, installed, and runtime-tested on Ubuntu 24.04 in WSL with Xvfb and GNOME Keyring, including background delivery after closing the window. Full GNOME desktop, Wayland, and Ubuntu 26.04 were not separately tested. Android debug assembly and unit tests passed, without physical-device validation. The new Windows installer was not built.

You control the server, domain, backups, and updates. The MIT license permits free use, modification, and redistribution, including commercial use, provided that its notice is retained.

Client-side encryption is not a guarantee against a compromised device or a server that serves malicious JavaScript. Weak master passwords remain vulnerable to offline guessing. There is no idle auto-lock, and a four-digit PIN is not a substitute for a password manager. Read [SECURITY.md](SECURITY.md) for the security model and recovery limits.

## Development

Use Node.js 24, npm, and PHP 8.3+ with PDO SQLite for local tests:

```bash
npm ci
npm test
npm run test:http
npm run build
npm run dev
```

The local preview listens on `http://127.0.0.1:4173`; its setup token is saved to `private/local-setup-token.txt`. Use disposable test data. Never publish `private/` or include it in release archives.

[Contributing](CONTRIBUTING.md) · [MIT license](LICENSE) · [Third-party notices](THIRD_PARTY_NOTICES.md)

Nute Notes is independent of Apple and is not affiliated with or endorsed by Apple. Apple Notes is referenced to explain the project's purpose; feature parity or iCloud interoperability is not promised.
