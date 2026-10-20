# Contributing

Thank you for helping improve Nute Notes. Small, focused changes are easiest to review.

## Before changing code

Read [SECURITY.md](SECURITY.md). Use synthetic accounts, notes, domains, and keys. Do not include production configuration, private device profiles, signing keys, logs containing secrets, or another person's data in issues, pull requests, screenshots, or archives.

For substantial changes, open an issue describing the problem and proposed behavior first. Security reports use the private process in `SECURITY.md`.

## Local checks

Use Node.js 24, npm, and PHP 8.3+ with OpenSSL, mbstring, PDO, and PDO SQLite. The server installer targets MySQL; SQLite is for disposable development/test fixtures.

```bash
npm ci
npm test
npm run test:http
npm run test:installer
npm run build
php tests/backend.php
```

Installer tests need Bash. On Windows, set `NUTE_TEST_BASH` and `NUTE_TEST_PHP` to your installed Bash and PHP executables; the private local tool directory is not distributed. HTTP tests accept `PHP_BINARY` if PHP is not on PATH, start local servers, and need an available loopback port.

For desktop changes:

```bash
cd apps/windows
npm ci
npm test
```

The shared Electron implementation lives under `apps/windows/src`; the Linux preparation script copies it into its build. Do not edit generated `apps/linux/src`, UI copies, `node_modules`, or binary release output as the source of a fix. Build platform-specific packages on the corresponding operating system and exercise the installed application with disposable profiles.

Run `npm run package:server` from the repository root to create a server-source distribution. Inspect its contents before sharing it. The release must not include private state, credentials, development databases, or dependency caches.

## Pull requests

Describe the user-visible change, the failure or requirement it addresses, and the checks you actually ran. Include material limitations. Add a regression test for a behavioral or security fix when practical.

Preserve encrypted queued edits, synchronization conflict handling, existing database contents, and 180-day device trust unless the change explicitly and safely revises their contracts. Schema changes need a migration and recovery plan; reinstalling over real data is not a migration.

Keep third-party notices intact. Contributions are distributed under the repository's [MIT license](LICENSE); only contribute material you have the right to share.
