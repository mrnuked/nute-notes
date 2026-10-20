<?php
declare(strict_types=1);

use Nute\ApiError;
use Nute\App;
use Nute\Config;

require_once dirname(__DIR__) . '/server/App.php';

$passed = 0;
function pinCheck(bool $condition, string $label): void
{
    global $passed;
    if (!$condition) throw new RuntimeException('FAIL: ' . $label);
    $passed++;
    echo 'PASS ' . $label . PHP_EOL;
}
function pinRejects(callable $operation, int $status, string $code, string $label): void
{
    try {
        $operation();
        throw new RuntimeException('FAIL: accepted ' . $label);
    } catch (ApiError $error) {
        pinCheck($error->status === $status && $error->error === $code, $label);
    }
}
function pinFixture(): array
{
    $config = ['environment' => 'local', 'origin' => 'http://127.0.0.1:8123', 'dsn' => 'sqlite::memory:',
        'db_user' => '', 'db_password' => '', 'app_key' => base64_encode(random_bytes(32)),
        'setup_token_hash' => hash('sha256', 'test-only')];
    $db = Config::connect($config);
    $db->exec(file_get_contents(dirname(__DIR__) . '/database/sqlite.sql'));
    $db->exec("INSERT INTO nute_owner VALUES (1, 'owner@example.com', 'salt', 'hash', 'wrapped', 'vault', 7, 'totp', 10, '[]', 1, 1)");
    return [$db, $config, new App($db, $config)];
}
function pinId(int $number): string
{
    return sprintf('00000000-0000-4000-8000-%012d', $number);
}

[$db, $config, $app] = pinFixture();
$now = 1800000000; // Both fixed rate windows start here.
$proof = base64_encode(random_bytes(32));
$wrong = base64_encode(random_bytes(32));
$input = ['id' => pinId(1), 'proof' => $proof];
$before = $db->query('SELECT * FROM nute_owner')->fetch();
pinCheck($app->registerPin($input, $now) === ['ok' => true], 'new note PIN proof registers');
$row = $db->query('SELECT * FROM nute_note_pins')->fetch();
pinCheck(array_keys($row) === ['id', 'owner_id', 'proof_hash', 'created_at'], 'PIN table stores no title, salt, PIN or ciphertext');
pinCheck(!str_contains(json_encode($row), $proof) && preg_match('/\A[a-f0-9]{64}\z/', $row['proof_hash']) === 1, 'only a keyed proof digest is stored');
pinCheck($app->checkPin($input, $now) === ['ok' => true], 'correct proof accepted');
pinCheck($app->registerPin($input, $now) === ['ok' => true], 'same proof registration is idempotent');
pinRejects(fn() => $app->registerPin(['id' => $input['id'], 'proof' => $wrong], $now), 409, 'pin_exists', 'existing proof cannot be replaced');
pinCheck($db->query('SELECT * FROM nute_note_pins')->fetch() === $row, 'wrong registration leaves PIN record byte-identical');
pinRejects(fn() => $app->checkPin(['id' => $input['id'], 'proof' => $wrong], $now), 403, 'pin_invalid', 'wrong PIN proof rejected');
pinCheck((new App($db, $config))->checkPin($input, $now) === ['ok' => true], 'correct proof resets previous per-note failures across application instances');
for ($i = 0; $i < 5; $i++) {
    pinRejects(fn() => (new App($db, $config))->checkPin(['id' => $input['id'], 'proof' => $wrong], $now), 403, 'pin_invalid', 'failed attempts persist across application instances');
}
pinRejects(fn() => $app->checkPin($input, $now), 429, 'rate_limited', 'correct proof cannot clear a note already blocked after five failures');
pinRejects(fn() => $app->registerPin($input, $now), 429, 'rate_limited', 'registration cannot bypass the per-note check limit');
pinRejects(fn() => $app->checkPin($input, $now + 899), 429, 'rate_limited', 'rate limit remains active until the window expires');
pinCheck($app->checkPin($input, $now + 900) === ['ok' => true], 'PIN checks resume after the 15-minute window expires');
pinCheck($db->query('SELECT * FROM nute_owner')->fetch() === $before, 'PIN operations never rewrite the owner or encrypted vault');
foreach (['1234', str_repeat('a', 36), '00000000-0000-1000-8000-000000000001'] as $invalid) {
    pinRejects(fn() => $app->registerPin(['id' => $invalid, 'proof' => $proof], $now + 900), 422, 'invalid_pin_id', 'non-UUIDv4 identifier rejected');
}
foreach (['1234', base64_encode(random_bytes(31)), base64_encode(random_bytes(33)), $proof . "\n"] as $invalid) {
    pinRejects(fn() => $app->checkPin(['id' => $input['id'], 'proof' => $invalid], $now + 900), 422, 'invalid_input', 'noncanonical 32-byte proof rejected');
}

[$db, $config, $app] = pinFixture();
for ($i = 0; $i < 30; $i++) {
    if ($i === 0) $app->registerPin($input, $now);
    pinCheck($app->checkPin($input, $now) === ['ok' => true], 'successful unlock resets only the per-note attempt bucket');
}
pinCheck((int) $db->query('SELECT COUNT(*) FROM nute_rate_limits')->fetchColumn() === 2, 'successful unlock leaves registration and global request buckets intact');
pinRejects(fn() => $app->checkPin($input, $now), 429, 'rate_limited', 'successful unlocks remain subject to the 30-request owner bound');

[$db, $config, $app] = pinFixture();
for ($i = 1; $i <= 30; $i++) {
    pinRejects(fn() => $app->checkPin(['id' => pinId($i), 'proof' => $proof], $now), 404, 'pin_missing', 'unknown PIN proof is not registered implicitly');
}
pinCheck((int) $db->query('SELECT COUNT(*) FROM nute_rate_limits')->fetchColumn() === 1, 'unknown identifiers create only one fixed owner rate bucket');
pinRejects(fn() => (new App($db, $config))->checkPin(['id' => pinId(31), 'proof' => $proof], $now), 429, 'rate_limited', 'owner check limit survives changed session or network identity');
pinRejects(fn() => $app->checkPin(['id' => pinId(31), 'proof' => $proof], $now + 900), 404, 'pin_missing', 'owner check limit expires after 15 minutes');

[$db, $config, $app] = pinFixture();
for ($i = 1; $i <= 60; $i++) $app->registerPin(['id' => pinId($i), 'proof' => $proof], $now);
pinRejects(fn() => $app->registerPin(['id' => pinId(61), 'proof' => $proof], $now), 429, 'rate_limited', 'registration limited to 60 per owner per hour');
pinCheck($app->registerPin(['id' => pinId(61), 'proof' => $proof], $now + 3600) === ['ok' => true], 'registration window expires after one hour');
$firstHash = $db->query("SELECT proof_hash FROM nute_note_pins WHERE id = '" . pinId(1) . "'")->fetchColumn();
$secondHash = $db->query("SELECT proof_hash FROM nute_note_pins WHERE id = '" . pinId(2) . "'")->fetchColumn();
pinCheck($firstHash !== $secondHash, 'stored proofs are bound to the note identifier');
$insert = $db->prepare('INSERT INTO nute_note_pins VALUES (?, 1, ?, ?)');
$db->beginTransaction();
for ($i = 62; $i <= 20000; $i++) $insert->execute([pinId($i), str_repeat('0', 64), $now]);
$db->commit();
pinRejects(fn() => $app->registerPin(['id' => pinId(20001), 'proof' => $proof], $now + 3600), 409, 'pin_limit', 'PIN records have a bounded 20000-record owner limit');
pinCheck((int) $db->query('SELECT COUNT(*) FROM nute_note_pins')->fetchColumn() === 20000, 'rejected registration creates no additional record');
echo "$passed PIN backend checks passed.\n";
