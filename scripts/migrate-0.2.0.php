<?php
declare(strict_types=1);

// Additive CLI migration. Does not generate keys, rewrite config, or decrypt the vault.
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
    if (!in_array($driver, ['mysql', 'sqlite'], true)) {
        throw new RuntimeException('Unsupported database.');
    }
    // All schema statements are CREATE ... IF NOT EXISTS. Existing owner, ciphertext,
    // revision, recovery codes, and rate-limit records are never updated by migration.
    $sql = file_get_contents(dirname(__DIR__) . '/database/' . $driver . '.sql');
    foreach (explode(';', $sql) as $statement) {
        if (trim($statement) !== '') {
            $db->exec($statement);
        }
    }
    $db->query('SELECT id, owner_id, token_hash, label, created_at, expires_at, last_used_at
        FROM nute_trusted_devices LIMIT 0');
    echo "NUTE 0.2.0 schema ready. Existing account and encrypted vault preserved.\n";
} catch (Throwable $error) {
    fwrite(STDERR, 'Migration failed (' . get_class($error) . "). Check the existing config, database access, and CREATE permission; never rerun initialization over an existing account.\n");
    exit(1);
}
