# Security

Nute Notes is a personal, single-owner application. This document describes its intended boundaries, not an independent security certification. Release 0.5.0 includes source code, a server archive, and an Ubuntu package; Windows and Android binaries are not published. Build and runtime checks do not establish exhaustive security coverage.

## Reporting a vulnerability

Do not put credentials, private notes, database dumps, live access tokens, or exploit details for an unpatched issue in a public issue.

Use [GitHub's private vulnerability reporting page](https://github.com/mrnuked/nute-notes/security/advisories/new) if the repository offers it. Its availability depends on repository settings. If it is unavailable, open a public issue asking the maintainer to enable a private reporting channel **without including the vulnerability or sensitive data**. No response-time guarantee or bug bounty is offered.

Include the affected commit/version, component, prerequisites, minimal reproduction using disposable data, expected versus actual result, and impact. Never test a server without its owner's authorization.

## Encryption and authentication

- The client derives key material from the master password using PBKDF2-HMAC-SHA256 with 600,000 iterations and a random salt. HKDF separates authentication and wrapping keys; AES-256-GCM protects vault keys and note data.
- The server stores encrypted note payloads and authentication-related metadata. Email, timestamps, network metadata, and synchronization identifiers are not all hidden by content encryption.
- The server validates a password-derived authentication proof, TOTP or a recovery code, and trusted-device state. The master password is not an account-recovery mechanism the administrator can reset while retaining access to the notes.
- Device trust lasts an absolute 180 days and does not renew on every login. It bypasses the second factor, not the password check. Revoking trust does not automatically close every already-unlocked session.
- The email-first login step reveals whether an email matches the owner. Rate limiting limits attempts but does not eliminate that disclosure.
- TOTP secrets require server-side verification and are protected with the server's application key. Protect the private configuration as well as the database.

## What encryption does not protect

A stolen encrypted database can be used for offline password guessing. Use a long, unique master password; the minimum length is not a strength guarantee.

A compromised web server can send modified JavaScript to the browser and steal plaintext or keys during a later login. A malicious client build, browser extension, operating system, or person with access to an unlocked session can also read data. Self-hosting gives you operational control, not immunity to compromise.

Native clients use operating-system facilities for local secrets: Windows DPAPI and a protected Linux keyring backend. Linux refuses the unprotected `basic_text` backend. These mechanisms do not defend against malware running as the same user or an already-unlocked operating system.

There is **no idle auto-lock**. Use the explicit lock action before leaving a device. Restoring a browser tab can preserve enough session state to resume it; closing a window is not the same as locking.

## Four-digit note PIN

The PIN hides a note's content inside an otherwise unlocked collection; its title remains visible. Online verification requires the authenticated owner and is rate-limited. Opening or removing the PIN requires network access in the normal client.

Four digits have only 10,000 possible values. If an attacker can bypass the online checks or obtain the relevant decrypted outer vault, the PIN cannot resist offline enumeration. Old backups can retain a note's pre-PIN contents. This feature is not a substitute for a strong master password or a dedicated password manager.

## Recovery, backups, and deployment

There is no email reset that recovers a forgotten master password or PIN. Recovery codes replace TOTP only.

Serve **only `public/`**, with valid HTTPS. Keep `private/`, server sources, backups, database files, signing material, and development fixtures outside all served roots. A public JavaScript asset is expected; its accessibility alone is not a vulnerability. Secrets must never be embedded in that asset.

Local backup archives contain the database and private configuration. Although note contents are encrypted, the whole archive is not separately encrypted and its configuration contains secrets. Store protected off-server copies and test restoration. Do not reinitialize an existing database or replace its application key as an attempted repair.

Keep the operating system and dependencies updated. Check dependencies and license notices before distributing builds. Prefer narrowly scoped, staged changes with backups. Never clear a device's local profile while it has unsynchronized edits.

## Maintenance scope

The latest public source is the maintenance target. There is no promise of long-term support for older versions, automatic security updates, exhaustive vulnerability coverage, or independent audit certification. Report regressions with the exact revision and platform.
