-- Run once in the dedicated NUTE database (MySQL 5.7+/MariaDB 10.3+).
-- Keep this database separate from other websites and use a dedicated DB user.
CREATE TABLE IF NOT EXISTS nute_owner (
  id TINYINT UNSIGNED NOT NULL PRIMARY KEY,
  email VARCHAR(254) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  salt VARCHAR(24) CHARACTER SET ascii NOT NULL,
  auth_hash VARCHAR(255) CHARACTER SET ascii NOT NULL,
  wrapped_key TEXT NOT NULL,
  vault LONGTEXT NOT NULL,
  revision BIGINT UNSIGNED NOT NULL DEFAULT 1,
  totp_secret TEXT NOT NULL,
  last_totp_step BIGINT NOT NULL DEFAULT -1,
  recovery_codes TEXT NOT NULL,
  created_at BIGINT UNSIGNED NOT NULL,
  updated_at BIGINT UNSIGNED NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE IF NOT EXISTS nute_trusted_devices (
  id CHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
  owner_id TINYINT UNSIGNED NOT NULL,
  token_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  label VARCHAR(120) NOT NULL,
  created_at BIGINT UNSIGNED NOT NULL,
  expires_at BIGINT UNSIGNED NOT NULL,
  last_used_at BIGINT UNSIGNED NOT NULL,
  INDEX nute_device_expiry (expires_at),
  CONSTRAINT nute_device_owner FOREIGN KEY (owner_id) REFERENCES nute_owner (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE IF NOT EXISTS nute_rate_limits (
  bucket CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
  attempts INT UNSIGNED NOT NULL,
  expires_at BIGINT UNSIGNED NOT NULL,
  INDEX nute_rate_expiry (expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE IF NOT EXISTS nute_note_pins (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
  owner_id TINYINT UNSIGNED NOT NULL,
  proof_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  created_at BIGINT UNSIGNED NOT NULL,
  CONSTRAINT nute_pin_owner FOREIGN KEY (owner_id) REFERENCES nute_owner (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE IF NOT EXISTS nute_sync_state (
  owner_id TINYINT UNSIGNED NOT NULL PRIMARY KEY,
  baseline_cursor BIGINT UNSIGNED NOT NULL,
  baseline_vault LONGTEXT NOT NULL,
  head BIGINT UNSIGNED NOT NULL,
  bytes_used BIGINT UNSIGNED NOT NULL,
  CONSTRAINT nute_sync_state_owner FOREIGN KEY (owner_id) REFERENCES nute_owner (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE IF NOT EXISTS nute_sync_receipts (
  owner_id TINYINT UNSIGNED NOT NULL,
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  seq BIGINT UNSIGNED NOT NULL,
  data_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  created_at BIGINT UNSIGNED NOT NULL,
  PRIMARY KEY (owner_id, id),
  UNIQUE KEY nute_receipt_sequence (owner_id, seq),
  CONSTRAINT nute_sync_receipt_owner FOREIGN KEY (owner_id) REFERENCES nute_owner (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE IF NOT EXISTS nute_sync_changes (
  owner_id TINYINT UNSIGNED NOT NULL,
  seq BIGINT UNSIGNED NOT NULL,
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  data LONGTEXT NOT NULL,
  byte_size INT UNSIGNED NOT NULL,
  PRIMARY KEY (owner_id, seq),
  CONSTRAINT nute_sync_change_owner FOREIGN KEY (owner_id) REFERENCES nute_owner (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
