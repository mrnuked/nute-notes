<?php
declare(strict_types=1);

use Nute\ApiError;
use Nute\Http;

require_once dirname(__DIR__) . '/server/Http.php';

$checks = [];
function check(bool $condition, string $message): void
{
    global $checks;
    if (!$condition) {
        throw new RuntimeException('FAIL: ' . $message);
    }
    $checks[] = $message;
}
function unauthorized(callable $operation, string $message): void
{
    try {
        $operation();
        throw new RuntimeException('FAIL: ' . $message);
    } catch (ApiError $error) {
        check($error->status === 401, $message);
    }
}

$temporary = sys_get_temp_dir() . DIRECTORY_SEPARATOR . 'nute-session-' . bin2hex(random_bytes(8));
mkdir($temporary, 0700);
session_save_path($temporary);
try {
    Http::session(['environment' => 'local', 'app_key' => base64_encode(random_bytes(32))]);
    check(session_status() === PHP_SESSION_NONE && glob($temporary . DIRECTORY_SEPARATOR . 'sess_*') === [], 'anonymous bootstrap allocates no persistent PHP session');
    check((int) ini_get('session.gc_maxlifetime') === 180 * 86400, 'PHP garbage collection uses the 180-day session boundary');
    $cookie = session_get_cookie_params();
    check($cookie['lifetime'] === 0 && $cookie['httponly'] && $cookie['samesite'] === 'Strict', 'authentication remains a browser-session HttpOnly Strict cookie');
    $csrf = $_SESSION['csrf'];
    $before = session_id();
    $now = 1800000000;
    Http::authenticate($now);
    $first = Http::resumeSecret();
    check(strlen(base64_decode($first, true)) === 32, 'authentication creates a random 256-bit resume secret');
    check(session_id() !== $before && $_SESSION['csrf'] === $csrf, 'authentication rotates the session and preserves CSRF');
    Http::requireOwner($now + 86400);
    check($_SESSION['owner'] === 1, 'a day without activity does not lock the session');
    Http::requireOwner($now + 180 * 86400 - 1);
    check(Http::resumeSecret() === $first, 'resume secret persists up to the absolute session boundary');
    unauthorized(fn() => Http::requireOwner($now + 180 * 86400), '180-day absolute boundary is enforced');
    check(!isset($_SESSION['resume_secret']) && !isset($_SESSION['owner']), 'expiry removes the owner and resume secret');
    unauthorized(fn() => Http::resumeSecret(), 'expired session cannot retrieve a resume secret');
    Http::authenticate($now);
    check(Http::resumeSecret() !== $first, 're-authentication rotates the resume secret');
    Http::logout();
    check($_SESSION === [] && session_status() === PHP_SESSION_NONE, 'logout destroys the whole server session');
    unauthorized(fn() => Http::requireOwner($now), 'logout prevents further authenticated access');
} finally {
    if (session_status() === PHP_SESSION_ACTIVE) {
        session_destroy();
    }
    foreach (glob($temporary . DIRECTORY_SEPARATOR . 'sess_*') as $file) {
        unlink($file);
    }
    rmdir($temporary);
}
foreach ($checks as $message) {
    echo 'PASS ' . $message . PHP_EOL;
}
echo count($checks) . ' session checks passed.' . PHP_EOL;
