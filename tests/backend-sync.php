<?php
declare(strict_types=1);

use Nute\ApiError;
use Nute\App;
use Nute\Config;

require_once dirname(__DIR__) . '/server/App.php';

$passed = 0;
function syncAssert(bool $condition, string $message): void
{
    global $passed;
    if (!$condition) throw new RuntimeException('FAIL: ' . $message);
    $passed++;
    echo 'PASS ' . $message . PHP_EOL;
}
function syncRejects(callable $operation, int $status, string $code, string $message): void
{
    try { $operation(); throw new RuntimeException('FAIL: accepted ' . $message); }
    catch (ApiError $error) { syncAssert($error->status === $status && $error->error === $code, $message . ' (' . $error->error . ')'); }
}
function syncEnvelope(int $size = 64): array
{
    return ['v' => 1, 'iv' => base64_encode(random_bytes(12)), 'ciphertext' => base64_encode(random_bytes($size))];
}
function syncId(int $number): string { return sprintf('00000000-0000-4000-8000-%012d', $number); }
function syncOperation(int $number, int $size = 64): array { return ['id' => syncId($number), 'data' => syncEnvelope($size)]; }
function syncFixture(): array
{
    $config = ['environment' => 'local', 'origin' => 'http://127.0.0.1:8123', 'dsn' => 'sqlite::memory:',
        'db_user' => '', 'db_password' => '', 'app_key' => base64_encode(random_bytes(32)), 'setup_token_hash' => hash('sha256', 'fixture')];
    $db = Config::connect($config);
    $db->exec(file_get_contents(dirname(__DIR__) . '/database/sqlite.sql'));
    $vault = syncEnvelope();
    $q = $db->prepare('INSERT INTO nute_owner VALUES (1, ?, ?, ?, ?, ?, 7, ?, 10, ?, 1, 1)');
    $q->execute(['owner@example.com', 'salt', 'hash', json_encode(syncEnvelope(48)), json_encode($vault), 'totp', '[]']);
    return [$db, new App($db, $config), $vault, $config];
}
$now = 1800000000;
[$db, $app, $vault, $config] = syncFixture();
syncRejects(fn() => $app->syncCheckpoint(['cursor' => 0, 'vault' => $vault], $now), 409, 'sync_not_initialized', 'checkpoint cannot bypass initial baseline capture');
$legacy = syncEnvelope(96);
syncAssert($app->saveVault(['revision' => 7, 'vault' => $legacy], $now)['revision'] === 8, 'legacy save remains valid before sync begins');
$ownerBefore = $db->query('SELECT * FROM nute_owner')->fetch();
$first = $app->syncPull([], $now);
syncAssert($first === ['baseline' => ['cursor' => 0, 'vault' => $legacy], 'changes' => [], 'cursor' => 0, 'hasMore' => false, 'received' => []], 'first pull captures exact latest legacy ciphertext at cursor zero');
syncRejects(fn() => $app->saveVault(['revision' => 8, 'vault' => syncEnvelope()], $now), 426, 'client_update_required', 'legacy writer is frozen after initial pull');
$a = syncOperation(1); $b = syncOperation(2);
syncAssert($app->syncPush(['operations' => [$a]], $now) === ['accepted' => [$a['id']], 'cursor' => 1], 'first peer appends encrypted change');
syncAssert((new App($db, $config))->syncPush(['operations' => [$b]], $now) === ['accepted' => [$b['id']], 'cursor' => 2], 'second independent peer appends without overwriting first');
$pull = $app->syncPull(['after' => 0], $now);
syncAssert($pull['changes'] === [['seq' => 1] + $a, ['seq' => 2] + $b] && $pull['cursor'] === 2 && !$pull['hasMore'], 'both peers pull identical ordered ciphertext history');
syncAssert($app->syncPush(['operations' => [$a, $b]], $now) === ['accepted' => [$a['id'], $b['id']], 'cursor' => 2], 'lost-response retry acknowledges exact operations without duplication');
syncRejects(fn() => $app->syncPush(['operations' => [['id' => $a['id'], 'data' => syncEnvelope()]]], $now), 409, 'sync_operation_conflict', 'existing operation ID cannot carry changed ciphertext');
$c = syncOperation(3);
syncRejects(fn() => $app->syncPush(['operations' => [$c, ['id' => $a['id'], 'data' => syncEnvelope()]]], $now), 409, 'sync_operation_conflict', 'mixed replay conflict rolls back the whole batch');
syncAssert($app->syncPull(['after' => 2], $now)['changes'] === [], 'failed mixed batch never partially appends');
syncRejects(fn() => $app->syncCheckpoint(['cursor' => 1, 'vault' => syncEnvelope()], $now), 409, 'sync_conflict', 'checkpoint refuses to discard changes from a newer peer');
$checkpoint = syncEnvelope(120);
syncAssert($app->syncCheckpoint(['cursor' => 2, 'vault' => $checkpoint], $now) === ['ok' => true], 'current head can be replaced by an encrypted checkpoint');
syncAssert((int) $db->query('SELECT COUNT(*) FROM nute_sync_changes')->fetchColumn() === 0, 'checkpoint compacts live ciphertext payloads');
syncAssert((int) $db->query('SELECT COUNT(*) FROM nute_sync_receipts')->fetchColumn() === 2, 'checkpoint retains immutable operation receipts');
$behind = $app->syncPull(['after' => 1], $now);
syncAssert($behind['baseline'] === ['cursor' => 2, 'vault' => $checkpoint] && $behind['cursor'] === 2, 'offline peer behind compaction receives the new baseline');
syncAssert($app->syncPull(['after' => 2], $now)['baseline'] === null, 'up-to-date peer does not receive redundant checkpoint');
syncAssert($app->syncPush(['operations' => [$a]], $now)['cursor'] === 2, 'retry after compaction never resurrects an acknowledged operation');
syncAssert($app->syncPull(['after' => 0, 'pendingIds' => [$a['id'], $b['id'], syncId(99)]], $now)['received'] === [$a['id'], $b['id']], 'pending replay receipts survive a different device checkpoint and exclude unreceived IDs');
syncRejects(fn() => $app->syncPush(['operations' => [['id' => $a['id'], 'data' => syncEnvelope()]]], $now), 409, 'sync_operation_conflict', 'receipt remains immutable after compaction');
syncAssert($app->syncPush(['operations' => [$c]], $now)['cursor'] === 3, 'sequence continues monotonically after checkpoint');
syncAssert($db->query('SELECT * FROM nute_owner')->fetch() === $ownerBefore, 'sync never rewrites master keys, owner or frozen legacy data');
syncRejects(fn() => $app->syncPull(['after' => 4], $now), 409, 'sync_cursor_ahead', 'client cannot skip unseen future sequence positions');
foreach ([-1, 1.5, '1', null, 9007199254740992] as $invalid) {
    syncRejects(fn() => $app->syncPull(['after' => $invalid], $now), 422, 'invalid_sync_cursor', 'malformed cursor rejected');
}
foreach ([[], array_fill(0, 65, $a), ['named' => $a]] as $invalid) {
    syncRejects(fn() => $app->syncPush(['operations' => $invalid], $now), 422, 'invalid_sync_operations', 'empty, oversized or non-list batch rejected');
}
foreach ([null, ['bad'], array_fill(0, 5001, $a['id']), ['named' => $a['id']]] as $invalid) {
    syncRejects(fn() => $app->syncPull(['pendingIds' => $invalid], $now), 422, 'invalid_sync_pending', 'malformed or oversized pending receipt request rejected');
}
syncRejects(fn() => $app->syncPush(['operations' => [['id' => 'bad', 'data' => $a['data']]]], $now), 422, 'invalid_sync_id', 'malformed operation ID rejected');
syncRejects(fn() => $app->syncPush(['operations' => [['id' => syncId(9), 'data' => ['plaintext' => 'private note']]]], $now), 422, 'invalid_envelope', 'plaintext payload rejected');
syncRejects(fn() => $app->syncPush(['operations' => [$a], 'plaintext' => 'private note'], $now), 422, 'invalid_sync_input', 'unexpected fields rejected');
$large = syncOperation(90, 1700000);
syncRejects(fn() => $app->syncPush(['operations' => [$large, syncOperation(91, 1700000)]], $now), 413, 'request_too_large', 'canonical batch cannot exceed four MiB');

[$db, $app, $vault] = syncFixture();
$items = [];
for ($i = 1; $i <= 64; $i++) $items[] = syncOperation($i);
syncAssert($app->syncPush(['operations' => $items], $now)['cursor'] === 64, 'push also freezes legacy baseline before first background upload');
$last = syncOperation(65);
$app->syncPush(['operations' => [$last]], $now);
$page = $app->syncPull(['after' => 0, 'pendingIds' => [$items[0]['id'], $last['id']]], $now);
syncAssert(count($page['changes']) === 64 && $page['cursor'] === 64 && $page['hasMore'], 'pull pagination is bounded to sixty-four ordered changes');
syncAssert($page['received'] === [$items[0]['id']], 'receipt acknowledgements never skip a change on the next page');
syncAssert($page['baseline']['vault'] === $vault, 'background-first sync retains the original baseline');
$next = $app->syncPull(['after' => $page['cursor']], $now);
syncAssert($next['changes'] === [['seq' => 65] + $last] && $next['cursor'] === 65 && !$next['hasMore'], 'next page neither skips nor duplicates the sixty-fifth change');

[$db, $app] = syncFixture();
$large = [];
for ($i = 1; $i <= 12; $i++) $large[] = syncOperation($i, 400000);
$app->syncPush(['operations' => array_slice($large, 0, 6)], $now);
$app->syncPush(['operations' => array_slice($large, 6)], $now);
$page = $app->syncPull(['after' => 0], $now);
syncAssert(count($page['changes']) < 12 && $page['cursor'] === count($page['changes']) && $page['hasMore'], 'large changes are paginated by bytes as well as count');
$next = $app->syncPull(['after' => $page['cursor']], $now);
syncAssert(count($page['changes']) + count($next['changes']) === 12 && $next['cursor'] === 12 && !$next['hasMore'], 'byte pagination makes progress and returns every operation');

[$db, $app] = syncFixture();
$payload = syncEnvelope(786432); // Slightly over one MiB after envelope overhead.
for ($i = 1; $i <= 63; $i++) $app->syncPush(['operations' => [['id' => syncId($i), 'data' => $payload]]], $now);
syncRejects(fn() => $app->syncPush(['operations' => [['id' => syncId(64), 'data' => $payload]]], $now), 413, 'sync_journal_full', 'journal refuses writes beyond its total 64 MiB allocation');
syncAssert($app->syncPull(['after' => 63], $now)['cursor'] === 63, 'capacity failure leaves head and receipts unchanged');
$app->syncCheckpoint(['cursor' => 63, 'vault' => syncEnvelope()], $now);
syncAssert($app->syncPush(['operations' => [['id' => syncId(64), 'data' => $payload]]], $now)['cursor'] === 64, 'checkpoint releases payload space while retaining receipt history');
syncAssert($app->syncPush(['operations' => [['id' => syncId(1), 'data' => $payload]]], $now)['cursor'] === 64, 'capacity compaction never permits replay duplicates');

[$db, $app] = syncFixture();
$app->syncPull([], $now);
$largeCheckpoint = syncEnvelope(3 * 1024 * 1024 / 4 * 3); // Exactly three MiB of base64 ciphertext.
syncRejects(fn() => $app->syncPush(['operations' => [['id' => syncId(200), 'data' => $largeCheckpoint]]], $now), 413, 'vault_too_large', 'individual operation retains its 2,800,000-character envelope cap');
syncAssert($app->syncCheckpoint(['cursor' => 0, 'vault' => $largeCheckpoint], $now) === ['ok' => true], 'checkpoint accepts a three MiB merged vault larger than one operation');
syncAssert($app->syncPull(['after' => 0], $now)['baseline']['vault'] === $largeCheckpoint, 'large checkpoint round trip preserves every ciphertext byte');
$tooLargeCheckpoint = ['v' => 1, 'iv' => base64_encode(random_bytes(12)), 'ciphertext' => str_repeat('A', 16 * 1024 * 1024 + 4)];
syncRejects(fn() => $app->syncCheckpoint(['cursor' => 0, 'vault' => $tooLargeCheckpoint], $now), 413, 'vault_too_large', 'checkpoint refuses ciphertext above sixteen MiB');
syncAssert($app->syncPull(['after' => 0], $now)['baseline']['vault'] === $largeCheckpoint, 'oversized checkpoint never replaces the last accepted baseline');
unset($largeCheckpoint, $tooLargeCheckpoint);

[$db, $app] = syncFixture();
$app->syncPull([], $now);
$d = syncOperation(100);
syncAssert($app->syncPush(['operations' => [$d, $d]], $now) === ['accepted' => [$d['id']], 'cursor' => 1], 'same ID repeated within a batch is acknowledged only once');
$pending = [];
for ($i = 1; $i <= 5000; $i++) $pending[] = syncId($i);
syncAssert($app->syncPull(['after' => 0, 'pendingIds' => $pending], $now)['received'] === [$d['id']], 'maximum pending receipt query is chunked without SQL parameter overflow');
echo "$passed sync backend checks passed.\n";
