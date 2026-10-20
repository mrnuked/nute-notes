<?php
declare(strict_types=1);

// CLI only. Supply installation JSON on standard input; never put passwords in arguments.
if (PHP_SAPI !== 'cli') {
    http_response_code(404);
    exit;
}
require_once dirname(__DIR__) . '/server/Core.php';

use Nute\Config;

try {
    $options = getopt('', ['config:']);
    $path = $options['config'] ?? dirname(__DIR__) . '/private/config.php';
    if (!is_string($path) || is_file($path)) {
        throw new RuntimeException('Configuration already exists or path is invalid. Refusing to overwrite.');
    }
    $input = json_decode(stream_get_contents(STDIN, 65537), true, 16, JSON_THROW_ON_ERROR);
    if (!is_array($input)) {
        throw new RuntimeException('Expected an installation JSON object on stdin.');
    }
    $directory = dirname($path);
    if (!is_dir($directory) && !mkdir($directory, 0700, true)) {
        throw new RuntimeException('Cannot create private configuration directory.');
    }
    $resolved = realpath($directory);
    $public = realpath(dirname(__DIR__) . '/public');
    $normalized = strtolower(str_replace('\\', '/', $resolved ?: '')) . '/';
    $publicNormalized = strtolower(str_replace('\\', '/', $public ?: '')) . '/';
    if (!$resolved || str_starts_with($normalized, $publicNormalized)) {
        throw new RuntimeException('Configuration must be outside the public webroot.');
    }
    $token = bin2hex(random_bytes(32));
    $config = [
        'environment' => $input['environment'] ?? 'production',
        'origin' => $input['origin'] ?? 'https://notes.example.org',
        'dsn' => $input['dsn'] ?? '',
        'db_user' => $input['db_user'] ?? '',
        'db_password' => $input['db_password'] ?? '',
        'app_key' => base64_encode(random_bytes(32)),
        'setup_token_hash' => hash('sha256', $token),
    ];
    Config::validate($config);
    $db = Config::connect($config);
    $driver = $db->getAttribute(PDO::ATTR_DRIVER_NAME);
    if (!in_array($driver, ['mysql', 'sqlite'], true)) {
        throw new RuntimeException('Unsupported database.');
    }
    $sql = file_get_contents(dirname(__DIR__) . '/database/' . $driver . '.sql');
    if ($driver === 'mysql') {
        // Avoid requiring PDO multi-statements on shared hosting.
        foreach (explode(';', $sql) as $statement) {
            if (trim($statement) !== '') {
                $db->exec($statement);
            }
        }
    } else {
        $db->exec($sql);
    }
    if ($db->query('SELECT id FROM nute_owner WHERE id = 1')->fetchColumn()) {
        throw new RuntimeException('Database is already initialized. Restore its original configuration; do not generate a new app key.');
    }
    $file = fopen($path, 'x');
    if ($file === false) {
        throw new RuntimeException('Cannot create configuration; no existing file was modified.');
    }
    $content = "<?php\ndeclare(strict_types=1);\nreturn " . var_export($config, true) . ";\n";
    if (fwrite($file, $content) !== strlen($content)) {
        fclose($file);
        throw new RuntimeException('Configuration write was incomplete. Inspect it before continuing.');
    }
    fclose($file);
    chmod($path, 0600);
    if (!is_file($directory . '/.htaccess')) {
        file_put_contents($directory . '/.htaccess', "Require all denied\n");
    }
    echo "Configuration created: " . $path . PHP_EOL;
    echo "Open " . $config['origin'] . "/?setup and enter this one-time setup token:" . PHP_EOL;
    echo $token . PHP_EOL;
    echo "The token is disabled after the sole owner is created. Keep private/config.php with the encrypted database backups." . PHP_EOL;
} catch (Throwable $error) {
    // Setup may include sensitive PDO error details; print only safe guidance and class.
    fwrite(STDERR, "Initialization failed (" . get_class($error) . "). Check PHP extensions, installation JSON, database access, config path, and whether the database/config already exists.\n");
    exit(1);
}
