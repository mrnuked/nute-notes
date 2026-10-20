<?php
declare(strict_types=1);

namespace Nute;

use PDO;
use Throwable;

require_once __DIR__ . '/Core.php';

/** Ordered opaque changes. No note plaintext, decryption keys or PINs reach this layer. */
final class SyncJournal
{
    public const MAX_BYTES = 64 * 1024 * 1024;
    public const MAX_BATCH_BYTES = 4 * 1024 * 1024;
    public const MAX_BATCH_COUNT = 64;
    // Bounded allocation for immutable ID/hash/sequence receipt and row metadata.
    private const RECEIPT_BYTES = 256;
    private const MAX_CURSOR = 9007199254740991;

    public function __construct(private PDO $db) {}

    private static function json(mixed $value): string
    {
        return json_encode($value, JSON_UNESCAPED_SLASHES | JSON_THROW_ON_ERROR);
    }

    private static function input(array $input, array $allowed): void
    {
        if (array_diff(array_keys($input), $allowed)) {
            throw new ApiError(422, 'invalid_sync_input', 'Некорректный запрос синхронизации.');
        }
    }

    private static function cursor(mixed $value): int
    {
        if (!is_int($value) || $value < 0 || $value > self::MAX_CURSOR) {
            throw new ApiError(422, 'invalid_sync_cursor', 'Некорректная позиция синхронизации.');
        }
        return $value;
    }

    private function begin(): void
    {
        if ($this->db->getAttribute(PDO::ATTR_DRIVER_NAME) === 'sqlite') $this->db->exec('BEGIN IMMEDIATE');
        else $this->db->beginTransaction();
    }

    private function state(bool $initialize): array
    {
        // Also used by legacy saveVault: this owner-row lock makes the first
        // snapshot and legacy-write cutoff one atomic transition.
        $suffix = $this->db->getAttribute(PDO::ATTR_DRIVER_NAME) === 'mysql' ? ' FOR UPDATE' : '';
        $owner = $this->db->query('SELECT vault FROM nute_owner WHERE id = 1' . $suffix)->fetch();
        if (!$owner) throw new ApiError(401, 'unauthorized', 'Войдите в хранилище.');
        $state = $this->db->query('SELECT * FROM nute_sync_state WHERE owner_id = 1')->fetch();
        if (!$state) {
            if (!$initialize) throw new ApiError(409, 'sync_not_initialized', 'Сначала загрузите хранилище для синхронизации.');
            // Copy exactly, including old-model ciphertext. Migration itself
            // does not insert this row or replace any existing owner data.
            $this->db->prepare('INSERT INTO nute_sync_state (owner_id, baseline_cursor, baseline_vault, head, bytes_used)
                VALUES (1, 0, ?, 0, ?)')->execute([$owner['vault'], strlen($owner['vault'])]);
            $state = ['owner_id' => 1, 'baseline_cursor' => 0, 'baseline_vault' => $owner['vault'], 'head' => 0, 'bytes_used' => strlen($owner['vault'])];
        }
        return $state;
    }

    public function pull(array $input): array
    {
        self::input($input, ['after', 'pendingIds']);
        $after = self::cursor(array_key_exists('after', $input) ? $input['after'] : 0);
        $pending = array_key_exists('pendingIds', $input) ? $input['pendingIds'] : [];
        if (!is_array($pending) || !array_is_list($pending) || count($pending) > 5000) {
            throw new ApiError(422, 'invalid_sync_pending', 'Некорректный список ожидающих изменений.');
        }
        foreach ($pending as $id) {
            if (!is_string($id) || !preg_match('/\A[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\z/D', $id)) {
                throw new ApiError(422, 'invalid_sync_pending', 'Некорректный список ожидающих изменений.');
            }
        }
        $pending = array_values(array_unique($pending));
        $this->begin();
        try {
            $state = $this->state(true);
            $head = (int) $state['head'];
            $base = (int) $state['baseline_cursor'];
            if ($after > $head) throw new ApiError(409, 'sync_cursor_ahead', 'Позиция устройства опережает сервер. Загрузите актуальную копию.');
            $baseline = null;
            if ($after === 0 || $after < $base) {
                $baseline = ['cursor' => $base, 'vault' => json_decode($state['baseline_vault'], true, 32, JSON_THROW_ON_ERROR)];
            }
            $cursor = max($after, $base);
            $query = $this->db->prepare('SELECT seq, id, data, byte_size FROM nute_sync_changes
                WHERE owner_id = 1 AND seq > ? ORDER BY seq LIMIT 64');
            $query->execute([$cursor]);
            $changes = [];
            $bytes = 0;
            foreach ($query as $row) {
                // The baseline is separately bounded by the vault envelope cap.
                // Never count it against this page, which could otherwise stall
                // cursor zero when the first change is itself a large envelope.
                $size = (int) $row['byte_size'] + 96;
                if ($bytes + $size > self::MAX_BATCH_BYTES) break;
                $changes[] = ['seq' => (int) $row['seq'], 'id' => $row['id'],
                    'data' => json_decode($row['data'], true, 32, JSON_THROW_ON_ERROR)];
                $bytes += $size;
                $cursor = (int) $row['seq'];
            }
            $known = [];
            foreach (array_chunk($pending, 200) as $chunk) {
                $query = $this->db->prepare('SELECT id FROM nute_sync_receipts WHERE owner_id = 1 AND seq <= ? AND id IN ('
                    . implode(',', array_fill(0, count($chunk), '?')) . ')');
                $query->execute([$cursor, ...$chunk]);
                foreach ($query->fetchAll(PDO::FETCH_COLUMN) as $id) $known[$id] = true;
            }
            $received = array_values(array_filter($pending, static fn(string $id): bool => isset($known[$id])));
            $this->db->commit();
            return ['baseline' => $baseline, 'changes' => $changes, 'cursor' => $cursor, 'hasMore' => $cursor < $head, 'received' => $received];
        } catch (Throwable $error) {
            if ($this->db->inTransaction()) $this->db->rollBack();
            throw $error;
        }
    }

    public function push(array $input, int $now): array
    {
        self::input($input, ['operations']);
        $operations = $input['operations'] ?? null;
        if (!is_array($operations) || !array_is_list($operations) || count($operations) < 1 || count($operations) > self::MAX_BATCH_COUNT) {
            throw new ApiError(422, 'invalid_sync_operations', 'Ожидается от 1 до 64 изменений.');
        }
        if (strlen(self::json($input)) > self::MAX_BATCH_BYTES) {
            throw new ApiError(413, 'request_too_large', 'Пакет синхронизации превышает допустимый размер.');
        }
        $normalized = [];
        foreach ($operations as $operation) {
            if (!is_array($operation) || array_diff(array_keys($operation), ['id', 'data'])) {
                throw new ApiError(422, 'invalid_sync_operations', 'Некорректное изменение.');
            }
            $id = $operation['id'] ?? null;
            if (!is_string($id) || !preg_match('/\A[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\z/D', $id)) {
                throw new ApiError(422, 'invalid_sync_id', 'Некорректный идентификатор изменения.');
            }
            $data = self::json(Crypto::envelope($operation['data'] ?? null));
            $normalized[] = ['id' => $id, 'data' => $data, 'hash' => hash('sha256', $data), 'bytes' => strlen($data)];
        }
        $this->begin();
        try {
            $state = $this->state(true);
            $head = (int) $state['head'];
            $used = (int) $state['bytes_used'];
            $accepted = [];
            $receipt = $this->db->prepare('SELECT data_hash FROM nute_sync_receipts WHERE owner_id = 1 AND id = ?');
            $insertReceipt = $this->db->prepare('INSERT INTO nute_sync_receipts (owner_id, id, seq, data_hash, created_at) VALUES (1, ?, ?, ?, ?)');
            $insertChange = $this->db->prepare('INSERT INTO nute_sync_changes (owner_id, seq, id, data, byte_size) VALUES (1, ?, ?, ?, ?)');
            foreach ($normalized as $operation) {
                $receipt->execute([$operation['id']]);
                $previous = $receipt->fetchColumn();
                if ($previous !== false) {
                    if (!hash_equals($previous, $operation['hash'])) {
                        throw new ApiError(409, 'sync_operation_conflict', 'Идентификатор изменения уже использован для других данных.');
                    }
                } else {
                    $used += $operation['bytes'] + self::RECEIPT_BYTES;
                    if ($used > self::MAX_BYTES || $head >= self::MAX_CURSOR) {
                        throw new ApiError(413, 'sync_journal_full', 'Журнал синхронизации заполнен. Откройте приложение для сохранения общей копии.');
                    }
                    $head++;
                    $insertReceipt->execute([$operation['id'], $head, $operation['hash'], $now]);
                    $insertChange->execute([$head, $operation['id'], $operation['data'], $operation['bytes']]);
                }
                // Duplicate IDs inside one otherwise valid retry are acknowledged once.
                $accepted[$operation['id']] = true;
            }
            $this->db->prepare('UPDATE nute_sync_state SET head = ?, bytes_used = ? WHERE owner_id = 1')->execute([$head, $used]);
            $this->db->commit();
            return ['accepted' => array_keys($accepted), 'cursor' => $head];
        } catch (Throwable $error) {
            if ($this->db->inTransaction()) $this->db->rollBack();
            throw $error;
        }
    }

    public function checkpoint(array $input): array
    {
        self::input($input, ['cursor', 'vault']);
        $cursor = self::cursor($input['cursor'] ?? null);
        $vault = self::json(Crypto::envelope($input['vault'] ?? null, false, 16 * 1024 * 1024));
        $this->begin();
        try {
            $state = $this->state(false);
            if ($cursor !== (int) $state['head']) {
                throw new ApiError(409, 'sync_conflict', 'На сервере появились новые изменения. Сначала завершите синхронизацию.');
            }
            $payloadBytes = (int) $this->db->query('SELECT COALESCE(SUM(byte_size), 0) FROM nute_sync_changes WHERE owner_id = 1')->fetchColumn();
            $used = (int) $state['bytes_used'] - strlen($state['baseline_vault']) - $payloadBytes + strlen($vault);
            if ($used > self::MAX_BYTES) throw new ApiError(413, 'sync_journal_full', 'Недостаточно места в журнале синхронизации.');
            $this->db->prepare('UPDATE nute_sync_state SET baseline_cursor = ?, baseline_vault = ?, bytes_used = ? WHERE owner_id = 1')
                ->execute([$cursor, $vault, $used]);
            $this->db->prepare('DELETE FROM nute_sync_changes WHERE owner_id = 1 AND seq <= ?')->execute([$cursor]);
            // Receipts never expire: an offline device may retry arbitrarily late.
            $this->db->commit();
            return ['ok' => true];
        } catch (Throwable $error) {
            if ($this->db->inTransaction()) $this->db->rollBack();
            throw $error;
        }
    }
}
