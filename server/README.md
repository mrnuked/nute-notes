# Nute Notes server

The server uses PHP, PDO MySQL, and MySQL. It has no Composer dependencies. The fresh-install path provisions Nginx and an isolated PHP-FPM pool on Ubuntu 24.04/26.04; see [installation](../docs/INSTALL.md). SQLite is used by disposable local development and test fixtures.

Serve only `public/`. Keep `server/`, `database/`, `scripts/`, `private/`, backups, and client signing material outside every served document root. Production requires HTTPS.

`scripts/init.php` creates a new schema, application key, private configuration, and one-time owner token. It refuses an existing owner/configuration. It is not an upgrade or recovery tool. One installation supports one owner.

The client encrypts note payloads before synchronization. The server handles authentication, TOTP, trusted devices, encrypted persistence, synchronization revisions, and online note-PIN checks. Mutations require the configured origin and CSRF protection. Client code is public by design; server secrets must never be embedded in it.

Read [SECURITY.md](../SECURITY.md) for cryptographic boundaries, metadata visibility, 180-day trust, PIN limits, recovery constraints, and reporting. See [CONTRIBUTING.md](../CONTRIBUTING.md) for test commands. Treat implementation and tests as the API reference; preserve durable queued edits and compatibility when changing request contracts.
