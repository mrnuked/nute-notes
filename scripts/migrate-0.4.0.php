<?php
declare(strict_types=1);

// Additive migration only. Journal baseline is captured by the first sync API
// transaction, never here: older clients may still save before that transition.
if (PHP_SAPI !== 'cli') {
    http_response_code(404);
    exit;
}
require_once dirname(__DIR__) . '/server/Core.php';
use Nute\Config;

try {
    $options = getopt('', ['config:']);
    if (isset($options['config'])) {
        if (!is_string($options['config']) || !is_file($options['config'])) throw new RuntimeException('Existing configuration required.');
        putenv('NUTE_CONFIG_PATH=' . $options['config']);
    }
    $config = Config::load();
    $db = Config::connect($config);
    $driver = $db->getAttribute(PDO::ATTR_DRIVER_NAME);
    if (!in_array($driver, ['mysql', 'sqlite'], true)) throw new RuntimeException('Unsupported database.');
    foreach (['nute_owner', 'nute_rate_limits', 'nute_trusted_devices', 'nute_note_pins'] as $table) $db->query('SELECT * FROM ' . $table . ' LIMIT 0');
    $sql = file_get_contents(dirname(__DIR__) . '/database/' . $driver . '.sql');
    foreach (['nute_sync_state', 'nute_sync_receipts', 'nute_sync_changes'] as $table) {
        if (!preg_match('/CREATE TABLE IF NOT EXISTS ' . $table . '\s*\(.*?;/s', $sql, $statement)) throw new RuntimeException('Sync migration schema missing.');
        $db->exec($statement[0]);
    }
    $db->query('SELECT owner_id, baseline_cursor, baseline_vault, head, bytes_used FROM nute_sync_state LIMIT 0');
    $db->query('SELECT owner_id, id, seq, data_hash, created_at FROM nute_sync_receipts LIMIT 0');
    $db->query('SELECT owner_id, seq, id, data, byte_size FROM nute_sync_changes LIMIT 0');
    echo "NUTE 0.4.0 schema ready. Existing owner, encrypted vault, devices and PIN records preserved.\n";
} catch (Throwable $error) {
    fwrite(STDERR, 'Migration failed (' . get_class($error) . "). Check existing config, database access, and CREATE permission; never rerun initialization over an existing account.\n");
    exit(1);
}
