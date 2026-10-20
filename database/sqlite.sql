-- Local automated tests only. Production requires MySQL.
CREATE TABLE IF NOT EXISTS nute_owner (
  id INTEGER PRIMARY KEY CHECK (id = 1), email TEXT NOT NULL,
  salt TEXT NOT NULL, auth_hash TEXT NOT NULL, wrapped_key TEXT NOT NULL,
  vault TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1,
  totp_secret TEXT NOT NULL, last_totp_step INTEGER NOT NULL DEFAULT -1,
  recovery_codes TEXT NOT NULL, created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS nute_rate_limits (
  bucket TEXT PRIMARY KEY, attempts INTEGER NOT NULL, expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS nute_rate_expiry ON nute_rate_limits (expires_at);

CREATE TABLE IF NOT EXISTS nute_trusted_devices (
  id TEXT PRIMARY KEY, owner_id INTEGER NOT NULL REFERENCES nute_owner (id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL, label TEXT NOT NULL, created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL, last_used_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS nute_device_expiry ON nute_trusted_devices (expires_at);

CREATE TABLE IF NOT EXISTS nute_note_pins (
  id TEXT PRIMARY KEY, owner_id INTEGER NOT NULL REFERENCES nute_owner (id) ON DELETE CASCADE,
  proof_hash TEXT NOT NULL, created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS nute_sync_state (
  owner_id INTEGER PRIMARY KEY REFERENCES nute_owner (id) ON DELETE CASCADE,
  baseline_cursor INTEGER NOT NULL, baseline_vault TEXT NOT NULL, head INTEGER NOT NULL, bytes_used INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS nute_sync_receipts (
  owner_id INTEGER NOT NULL REFERENCES nute_owner (id) ON DELETE CASCADE,
  id TEXT NOT NULL, seq INTEGER NOT NULL, data_hash TEXT NOT NULL, created_at INTEGER NOT NULL,
  PRIMARY KEY (owner_id, id), UNIQUE (owner_id, seq)
);

CREATE TABLE IF NOT EXISTS nute_sync_changes (
  owner_id INTEGER NOT NULL REFERENCES nute_owner (id) ON DELETE CASCADE,
  seq INTEGER NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, byte_size INTEGER NOT NULL,
  PRIMARY KEY (owner_id, seq)
);
