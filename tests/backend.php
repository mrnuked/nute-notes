<?php
declare(strict_types=1);

use Nute\ApiError;
use Nute\App;
use Nute\Config;
use Nute\Crypto;
use Nute\Http;
use Nute\RateLimiter;

require_once dirname(__DIR__) . '/server/App.php';
require_once dirname(__DIR__) . '/server/Http.php';

$passed = 0;
function check(bool $condition, string $message): void
{
    global $passed;
    if (!$condition) {
        throw new RuntimeException('FAIL: ' . $message);
    }
    $passed++;
    echo 'PASS ' . $message . PHP_EOL;
}
function rejects(callable $operation, int $status, string $label): void
{
    try {
        $operation();
        throw new RuntimeException('FAIL: did not reject ' . $label);
    } catch (ApiError $error) {
        check($error->status === $status, $label . ' (' . $error->error . ')');
    }
}
function envelope(int $bytes): array
{
    return ['v' => 1, 'iv' => base64_encode(random_bytes(12)), 'ciphertext' => base64_encode(random_bytes($bytes))];
}
$secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'; // gitleaks:allow -- Public RFC 6238 test vector, never a deployment credential.
check(Crypto::totp($secret, 1) === '287082', 'RFC 6238 SHA1 test vector at timestamp 59 (six digits)');
check(Crypto::totp($secret, intdiv(1111111109, 30)) === '081804', 'RFC 6238 SHA1 long timestamp vector');
check(Crypto::matchTotp($secret, '287082', 59, 1) === null, 'previously consumed TOTP cannot replay');
$key = random_bytes(32);
$sealed = Crypto::encryptSecret($secret, $key);
check(Crypto::decryptSecret($sealed, $key) === $secret && !str_contains($sealed, $secret), 'TOTP encryption authenticated round trip');
$blob = base64_decode($sealed);
$blob[30] = chr(ord($blob[30]) ^ 1);
try { Crypto::decryptSecret(base64_encode($blob), $key); throw new LogicException('Tamper accepted'); }
catch (RuntimeException $error) { check(!($error instanceof LogicException), 'TOTP ciphertext tampering rejected'); }
rejects(fn() => Crypto::envelope(['v' => 1, 'iv' => base64_encode(random_bytes(12)), 'ciphertext' => 'short']), 422, 'malformed ciphertext rejected');
rejects(fn() => Crypto::envelope(envelope(32), true), 422, 'wrapped key must contain a 32-byte key plus GCM tag');
rejects(fn() => Crypto::envelope(['v' => 1, 'iv' => base64_encode(random_bytes(12)), 'ciphertext' => str_repeat('A', 2800001)]), 413, 'vault size bound enforced');
$config = ['environment' => 'local', 'origin' => 'http://127.0.0.1:8123', 'dsn' => 'sqlite::memory:',
    'db_user' => '', 'db_password' => '', 'app_key' => base64_encode($key), 'setup_token_hash' => hash('sha256', 'test-token')];
Config::validate($config);
$db = Config::connect($config);
$db->exec(file_get_contents(dirname(__DIR__) . '/database/sqlite.sql'));
$app = new App($db, $config);
$now = 1800000000;
$proof = base64_encode(random_bytes(32));
$input = ['token' => 'test-token', 'email' => 'Owner@example.com', 'authProof' => $proof,
    'salt' => base64_encode(random_bytes(16)), 'wrappedKey' => envelope(48), 'vault' => envelope(64),
    'totpSecret' => $secret, 'otp' => Crypto::totp($secret, intdiv($now, 30))];
check(!$app->initialized(), 'empty database has no owner');
rejects(fn() => $app->setup(array_replace($input, ['token' => 'wrong-token']), '127.0.0.1', $now), 403, 'setup requires offline token');
rejects(fn() => $app->setup(array_replace($input, ['otp' => 'invalid']), '127.0.0.1', $now), 422, 'setup verifies authenticator');
$setup = $app->setup($input, '127.0.0.1', $now);
check($app->initialized() && $setup['email'] === 'owner@example.com' && $setup['revision'] === 1, 'sole owner setup creates encrypted vault');
check(count($setup['recoveryCodes']) === 10 && count(array_unique($setup['recoveryCodes'])) === 10, 'setup returns ten independent recovery codes');
rejects(fn() => $app->setup($input, '127.0.0.1', $now), 409, 'second account setup disabled');
check($app->identify(['email' => 'OWNER@example.com'], '127.0.0.1', $now)['salt'] === $input['salt'], 'matching email reveals KDF salt');
rejects(fn() => $app->identify(['email' => 'stranger@example.com'], '127.0.0.1', $now), 401, 'unknown email cannot advance');
$login = ['email' => 'owner@example.com', 'authProof' => $proof, 'otp' => $input['otp']];
rejects(fn() => $app->login($login, '127.0.0.1', $now), 401, 'setup TOTP cannot replay for login');
$login['otp'] = Crypto::totp($secret, intdiv($now + 30, 30));
rejects(fn() => $app->login(array_replace($login, ['authProof' => base64_encode(random_bytes(32))]), '127.0.0.1', $now + 30), 401, 'wrong authentication proof rejected');
$signedIn = $app->login($login, '127.0.0.1', $now + 30);
check($signedIn['wrappedKey'] === $input['wrappedKey'] && $signedIn['vault'] === $input['vault'], 'valid two-factor login returns ciphertext only');
rejects(fn() => $app->login($login, '127.0.0.1', $now + 30), 401, 'login TOTP cannot replay');
$login['otp'] = $setup['recoveryCodes'][0];
check($app->login($login, '127.0.0.1', $now + 30)['email'] === 'owner@example.com', 'recovery code replaces lost authenticator');
rejects(fn() => $app->login($login, '127.0.0.1', $now + 30), 401, 'recovery code is single-use');
$changed = envelope(80);
check($app->saveVault(['revision' => 1, 'vault' => $changed], $now + 31)['revision'] === 2, 'save advances revision');
rejects(fn() => $app->saveVault(['revision' => 1, 'vault' => envelope(90)], $now + 32), 409, 'stale client cannot overwrite newer data');
check($app->readVault()['vault'] === $changed, 'conflicting save preserves existing ciphertext');
$row = $db->query('SELECT * FROM nute_owner')->fetch();
check(!str_contains(json_encode($row), $proof) && !str_contains(json_encode($row), $secret)
    && !str_contains(json_encode($row), $setup['recoveryCodes'][0]), 'DB stores no raw auth proof, TOTP secret, or recovery code');
check(!$app->trustedDevice(null, $now), 'browser is not trusted without its device cookie');
$deviceTime = $now + 900;
$deviceLogin = ['email' => 'owner@example.com', 'authProof' => $proof,
    'otp' => $setup['recoveryCodes'][1], 'rememberDevice' => true];
$app->login($deviceLogin, '127.0.0.1', $deviceTime, null, 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0');
$issued = $app->issuedDeviceCookie();
check(is_array($issued) && $issued['expiresAt'] === $deviceTime + 180 * 86400, 'explicit 2FA trust lasts exactly 180 days');
$deviceToken = $issued['token'];
check($app->trustedDevice($deviceToken, $deviceTime), 'issued device token is trusted');
$withoutOtp = ['email' => 'owner@example.com', 'authProof' => $proof];
rejects(fn() => $app->login($withoutOtp, '127.0.0.1', $deviceTime), 401, 'untrusted browser still requires 2FA');
rejects(fn() => $app->login(array_replace($withoutOtp, ['authProof' => base64_encode(random_bytes(32))]), '127.0.0.1', $deviceTime, $deviceToken), 401, 'trusted device never bypasses master proof');
check($app->login($withoutOtp + ['rememberDevice' => true], '127.0.0.1', $deviceTime + 1, $deviceToken)['vault'] === $changed, 'trusted browser signs in without another 2FA code');
check($app->issuedDeviceCookie() === null, 'trusted sign-in does not renew the absolute lifetime or rotate across tabs');
$devices = $app->devices($deviceTime + 1, $deviceToken)['devices'];
check(count($devices) === 1 && $devices[0]['current'] && $devices[0]['label'] === 'Chrome · Windows'
    && $devices[0]['lastUsedAt'] === $deviceTime + 1, 'authenticated device list identifies this browser and its last use');
$storedDevice = $db->query('SELECT * FROM nute_trusted_devices')->fetch();
check(!str_contains(json_encode($storedDevice), explode('.', $deviceToken)[1])
    && !str_contains(json_encode($devices), $storedDevice['token_hash']), 'database keeps only token hash and device list exposes no credential');
check(!$app->trustedDevice(substr($deviceToken, 0, -1) . (str_ends_with($deviceToken, 'a') ? 'b' : 'a'), $deviceTime), 'modified token is rejected');
check($app->trustedDevice($deviceToken, $issued['expiresAt'] - 1)
    && !$app->trustedDevice($deviceToken, $issued['expiresAt']), 'trust expires at the exact 180-day boundary');
rejects(fn() => $app->login($withoutOtp, '127.0.0.1', $issued['expiresAt'], $deviceToken), 401, 'expired trust requires 2FA again');
$revoked = $app->revokeDevice(['id' => $devices[0]['id']], $deviceToken, $deviceTime + 2);
check($revoked['current'] && !$app->trustedDevice($deviceToken, $deviceTime + 2), 'revoking current device removes its trust');
rejects(fn() => $app->login($withoutOtp, '127.0.0.1', $deviceTime + 2, $deviceToken), 401, 'revoked token cannot authenticate without 2FA');
$deviceLogin['otp'] = $setup['recoveryCodes'][2];
$app->login($deviceLogin, '127.0.0.1', $deviceTime + 3);
$secondToken = $app->issuedDeviceCookie()['token'];
$app->forgetDevice($secondToken);
check(!$app->trustedDevice($secondToken, $deviceTime + 3), 'forgetting current browser revokes its persistent credential');
$deviceLogin['otp'] = Crypto::totp($secret, intdiv($deviceTime + 30, 30));
$app->login($deviceLogin, '127.0.0.1', $deviceTime + 30);
check($app->trustedDevice($app->issuedDeviceCookie()['token'], $deviceTime + 30), 'fresh TOTP can enroll a trusted browser');
$limiter = new RateLimiter($db, $key);
$limiter->take('test', 'fixed-owner', 2, 60, $now);
$limiter->take('test', 'fixed-owner', 2, 60, $now);
rejects(fn() => $limiter->take('test', 'fixed-owner', 2, 60, $now), 429, 'rate limit enforced in database');
$limiter->take('test', 'fixed-owner', 2, 60, $now + 60);
check(true, 'rate limit expires at next window');
$_SERVER = ['HTTP_HOST' => '127.0.0.1:8123', 'REMOTE_ADDR' => '127.0.0.1', 'HTTP_ORIGIN' => $config['origin']];
Http::validateRequest($config, true);
check(true, 'same-origin loopback local request accepted');
$_SERVER['HTTP_ORIGIN'] = 'https://attacker.example';
rejects(fn() => Http::validateRequest($config, true), 403, 'cross-origin mutation rejected');
unset($_SERVER['HTTP_ORIGIN']);
rejects(fn() => Http::validateRequest($config, true), 403, 'mutation without Origin rejected');
$_SERVER['HTTP_HOST'] = 'attacker.example';
rejects(fn() => Http::validateRequest($config, false), 403, 'host rebinding rejected');
$_SESSION = ['owner' => 1, 'created_at' => $now, 'last_activity' => $now];
Http::requireOwner($now + 899);
check($_SESSION['last_activity'] === $now + 899, 'active session records the last request');
Http::requireOwner($now + 86400);
check($_SESSION['owner'] === 1, 'session does not expire after idle time');
$_SESSION = ['owner' => 1, 'created_at' => $now, 'last_activity' => $now + 180 * 86400 - 1, 'resume_secret' => 'test'];
rejects(fn() => Http::requireOwner($now + 180 * 86400), 401, '180-day absolute timeout enforced');
// Regression: anonymous malformed requests must not spend the owner's budget.
$window = $now + 1800;
for ($i = 0; $i < 120; $i++) {
    rejects(fn() => $app->identify(['email' => ['invalid']], '192.0.2.' . (20 + intdiv($i, 30)), $window), 422, 'malformed email remains rejected without blocking owner identification');
}
check($app->identify(['email' => 'owner@example.com'], '192.0.2.24', $window)['salt'] === $input['salt'], 'owner can reach password step after malformed distributed email traffic');
rejects(fn() => $app->identify([], '192.0.2.20', $window), 429, 'email syntax failures retain per-IP protection');
for ($i = 0; $i < 30; $i++) {
    $bad = $i % 2 === 0 ? [] : ['email' => 'owner@example.com', 'authProof' => ['invalid']];
    rejects(fn() => $app->login($bad, '192.0.2.' . (1 + intdiv($i, 12)), $window), 422, 'malformed login remains rejected without owner lockout');
}
$good = ['email' => 'owner@example.com', 'authProof' => $proof, 'otp' => Crypto::totp($secret, intdiv($window, 30))];
check($app->login($good, '192.0.2.4', $window)['vault'] === $changed, 'correct owner login survives 30 malformed distributed requests');
rejects(fn() => $app->login([], '192.0.2.1', $window), 429, 'malformed requests retain the per-IP budget');
$window += 900;
for ($i = 0; $i < 30; $i++) {
    rejects(fn() => $app->login(['email' => 'owner@example.com', 'authProof' => $proof, 'otp' => ['invalid']], '198.51.100.' . (1 + intdiv($i, 12)), $window), 401, 'malformed second factor cannot spend owner budget');
}
$good['otp'] = Crypto::totp($secret, intdiv($window, 30));
check($app->login($good, '198.51.100.4', $window)['vault'] === $changed, 'valid second factor still works after malformed attempts');
$window += 900;
for ($i = 0; $i < 30; $i++) {
    rejects(fn() => $app->login(['email' => 'owner@example.com', 'authProof' => base64_encode(random_bytes(32))], '203.0.113.' . (1 + intdiv($i, 12)), $window), 401, 'well-formed incorrect proofs remain counted globally');
}
rejects(fn() => $app->login($good, '203.0.113.4', $window), 429, 'distributed password-guessing budget remains enforced');
echo "\n$passed backend assertions passed.\n";
