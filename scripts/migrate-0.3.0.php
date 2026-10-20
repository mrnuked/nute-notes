<?php
declare(strict_types=1);

// Additive migration only. Never generates keys or rewrites account/ciphertext.
if (PHP_SAPI !== 'cli') {
    http_response_code(404);
    exit;
}

require_once dirname(__DIR__) . '/server/Core.php';

use Nute\Config;

try {
    $options = getopt('', ['config:']);
    if (isset($options['config'])) {
        if (!is_string($options['config']) || !is_file($options['config'])) {
            throw new RuntimeException('Existing configuration required.');
        }
        putenv('NUTE_CONFIG_PATH=' . $options['config']);
    }
    $config = Config::load();
    $db = Config::connect($config);
    $driver = $db->getAttribute(PDO::ATTR_DRIVER_NAME);
    if (!in_array($driver, ['mysql', 'sqlite'], true)) throw new RuntimeException('Unsupported database.');
    // Require the existing 0.2 schema rather than silently initializing it.
    $db->query('SELECT id FROM nute_owner LIMIT 0');
    $db->query('SELECT bucket FROM nute_rate_limits LIMIT 0');
    $db->query('SELECT id FROM nute_trusted_devices LIMIT 0');
    $sql = file_get_contents(dirname(__DIR__) . '/database/' . $driver . '.sql');
    if (!preg_match('/CREATE TABLE IF NOT EXISTS nute_note_pins\s*\(.*?;/s', $sql, $statement)) {
        throw new RuntimeException('PIN migration schema missing.');
    }
    $db->exec($statement[0]);
    $db->query('SELECT id, owner_id, proof_hash, created_at FROM nute_note_pins LIMIT 0');
    echo "NUTE 0.3.0 schema ready. Existing account, encrypted vault, devices and limits preserved.\n";
} catch (Throwable $error) {
    fwrite(STDERR, 'Migration failed (' . get_class($error) . "). Check existing config, database access, and CREATE permission; never rerun initialization over an existing account.\n");
    exit(1);
}
