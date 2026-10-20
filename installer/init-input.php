<?php
declare(strict_types=1);
// Only pipe this process into scripts/init.php. Never redirect its output to a log.
if (PHP_SAPI !== 'cli') {
    http_response_code(404);
    exit;
}
$domain = getenv('NUTE_INSTALL_DOMAIN');
$password = getenv('NUTE_INSTALL_DB_PASSWORD');
if (!is_string($domain) || !preg_match('/\A[a-z0-9.-]+\z/D', $domain)
    || !is_string($password) || !preg_match('/\A[a-f0-9]{64}\z/D', $password)) {
    fwrite(STDERR, "Missing or invalid installer environment.\n");
    exit(1);
}
echo json_encode([
    'environment' => 'production',
    'origin' => 'https://' . $domain,
    'dsn' => 'mysql:host=localhost;dbname=nute;charset=utf8mb4',
    'db_user' => 'nute',
    'db_password' => $password,
], JSON_THROW_ON_ERROR);
