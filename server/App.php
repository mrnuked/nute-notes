<?php
declare(strict_types=1);

namespace Nute;

use PDO;
use Throwable;

require_once __DIR__ . '/Core.php';
require_once __DIR__ . '/SyncJournal.php';

final class App
{
    private string $key;
    private RateLimiter $limiter;
    private ?array $issuedDevice = null;
    public const DEVICE_LIFETIME = 180 * 86400;

    public function __construct(private PDO $db, private array $config)
    {
        $this->key = base64_decode($config['app_key'], true);
        $this->limiter = new RateLimiter($db, $this->key);
    }

    public function initialized(): bool
    {
        return (bool) $this->db->query('SELECT id FROM nute_owner WHERE id = 1')->fetchColumn();
    }

    private function owner(bool $lock = false): array|false
    {
        $suffix = $lock && $this->db->getAttribute(PDO::ATTR_DRIVER_NAME) === 'mysql' ? ' FOR UPDATE' : '';
        return $this->db->query('SELECT * FROM nute_owner WHERE id = 1' . $suffix)->fetch();
    }

    private function email(mixed $email): string
    {
        if (!is_string($email) || strlen($email) > 254 || !filter_var($email, FILTER_VALIDATE_EMAIL)
            || preg_match('/[^\x20-\x7e]/', $email)) {
            throw new ApiError(422, 'invalid_email', 'Введите корректный адрес электронной почты.');
        }
        return strtolower(trim($email));
    }

    private function limits(string $action, string $ip, int $now, bool $chargeOwner = true): void
    {
        [$ipLimit, $accountLimit, $window] = match ($action) {
            'email' => [30, 120, 900],
            'setup' => [8, 20, 3600],
        };
        $this->limiter->take($action . '/ip', $ip, $ipLimit, $window, $now);
        // Fixed account bucket: attacker-supplied email addresses cannot create unlimited buckets.
        if ($chargeOwner) $this->limiter->take($action . '/owner', 'owner', $accountLimit, $window, $now);
    }

    public function identify(array $input, string $ip, int $now): array
    {
        $this->limits('email', $ip, $now, false);
        $email = $this->email($input['email'] ?? null);
        $this->limiter->take('email/owner', 'owner', 120, 900, $now);
        $owner = $this->owner();
        if (!$owner || !hash_equals($owner['email'], $email)) {
            // Intentionally confirms registered email as requested by the owner.
            throw new ApiError(401, 'unknown_account', 'Учётная запись не найдена.');
        }
        return ['salt' => $owner['salt']];
    }

    public function setup(array $input, string $ip, int $now): array
    {
        $this->limits('setup', $ip, $now);
        if ($this->initialized()) {
            throw new ApiError(409, 'already_initialized', 'Хранилище уже настроено.');
        }
        if (!is_string($input['token'] ?? null) || strlen($input['token']) > 256
            || !hash_equals($this->config['setup_token_hash'], hash('sha256', $input['token']))) {
            throw new ApiError(403, 'setup_denied', 'Неверный ключ первоначальной настройки.');
        }
        $email = $this->email($input['email'] ?? null);
        Crypto::decode64($input['authProof'] ?? null, 32);
        Crypto::decode64($input['salt'] ?? null, 16);
        $wrapped = Crypto::envelope($input['wrappedKey'] ?? null, true);
        $vault = Crypto::envelope($input['vault'] ?? null);
        $secret = $input['totpSecret'] ?? null;
        if (!is_string($secret)) {
            throw new ApiError(422, 'invalid_totp', 'Не задан ключ аутентификатора.');
        }
        Crypto::base32Decode($secret);
        $step = Crypto::matchTotp($secret, $input['otp'] ?? null, $now, -1);
        if ($step === null) {
            throw new ApiError(422, 'invalid_otp', 'Неверный код аутентификатора.');
        }
        $recoveryCodes = [];
        $hashes = [];
        for ($i = 0; $i < 10; $i++) {
            $code = strtoupper(bin2hex(random_bytes(10)));
            $recoveryCodes[] = implode('-', str_split($code, 5));
            $hashes[] = Crypto::recoveryHash($code, $this->key);
        }
        $hash = Crypto::passwordHash($input['authProof']);
        $this->db->beginTransaction();
        try {
            if ($this->owner(true)) {
                throw new ApiError(409, 'already_initialized', 'Хранилище уже настроено.');
            }
            $statement = $this->db->prepare('INSERT INTO nute_owner
                (id, email, salt, auth_hash, wrapped_key, vault, revision, totp_secret, last_totp_step, recovery_codes, created_at, updated_at)
                VALUES (1, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)');
            $statement->execute([$email, $input['salt'], $hash, self::json($wrapped), self::json($vault),
                Crypto::encryptSecret($secret, $this->key), $step, self::json($hashes), $now, $now]);
            $this->db->commit();
        } catch (Throwable $error) {
            if ($this->db->inTransaction()) {
                $this->db->rollBack();
            }
            throw $error;
        }
        return $this->readVault() + ['recoveryCodes' => $recoveryCodes];
    }

    public function login(array $input, string $ip, int $now, ?string $deviceToken = null, string $userAgent = ''): array
    {
        $this->issuedDevice = null;
        // Charge malformed traffic to its source, not to the owner's shared
        // password/second-factor budget. Valid-format guesses still share a cap.
        $this->limiter->take('login/ip', $ip, 12, 900, $now);
        if (isset($input['rememberDevice']) && !is_bool($input['rememberDevice'])) {
            throw new ApiError(422, 'invalid_input', 'Некорректный выбор доверия устройству.');
        }
        $email = $this->email($input['email'] ?? null);
        Crypto::decode64($input['authProof'] ?? null, 32);
        $otp = $input['otp'] ?? null;
        if ($otp !== null && $otp !== '' && (!is_string($otp)
            || !preg_match('/\A(?:[0-9]{6}|[0-9a-fA-F]{5}(?:-?[0-9a-fA-F]{5}){3})\z/D', $otp))) {
            throw self::loginFailure();
        }
        $this->limiter->take('login/owner', 'owner', 30, 900, $now);
        $owner = $this->owner();
        // Real bcrypt dummy hash avoids an immediate response for unknown accounts.
        $hash = $owner['auth_hash'] ?? '$2y$12$1.N1R8tRVcQXZl69yT4IDuKmchq3cXm8YJU14zkuTpUhyRR2TpCxe';
        $valid = password_verify($input['authProof'], $hash);
        if (!$owner || !hash_equals($owner['email'], $email) || !$valid) {
            throw self::loginFailure();
        }
        $this->db->beginTransaction();
        try {
            $owner = $this->owner(true);
            if (!$owner || !hash_equals($owner['auth_hash'], $hash)) {
                throw self::loginFailure();
            }
            $trusted = $this->device($deviceToken, $now);
            // The password-derived proof was checked above. A remembered browser replaces
            // only the second factor, never the master password or the vault encryption key.
            if ($trusted && (!isset($input['otp']) || $input['otp'] === '')) {
                $this->db->prepare('UPDATE nute_trusted_devices SET last_used_at = ? WHERE id = ?')
                    ->execute([$now, $trusted['id']]);
            } else {
                $secret = Crypto::decryptSecret($owner['totp_secret'], $this->key);
                $step = Crypto::matchTotp($secret, $input['otp'] ?? null, $now, (int) $owner['last_totp_step']);
                $recovery = json_decode($owner['recovery_codes'], true, 512, JSON_THROW_ON_ERROR);
                if ($step === null) {
                    $otp = $input['otp'] ?? null;
                    if (!is_string($otp) || !preg_match('/\A[0-9a-fA-F]{5}(?:-?[0-9a-fA-F]{5}){3}\z/D', $otp)) {
                        throw self::loginFailure();
                    }
                    $match = null;
                    $candidate = Crypto::recoveryHash($otp, $this->key);
                    foreach ($recovery as $index => $stored) {
                        if (hash_equals($stored, $candidate)) {
                            $match = $index;
                        }
                    }
                    if ($match === null) {
                        throw self::loginFailure();
                    }
                    unset($recovery[$match]);
                    $step = (int) $owner['last_totp_step'];
                }
                $this->db->prepare('UPDATE nute_owner SET last_totp_step = ?, recovery_codes = ? WHERE id = 1')
                    ->execute([$step, self::json(array_values($recovery))]);
                if (($input['rememberDevice'] ?? false) === true) {
                    $this->issueDevice($deviceToken, $userAgent, $now);
                }
            }
            $this->db->commit();
        } catch (Throwable $error) {
            $this->issuedDevice = null;
            if ($this->db->inTransaction()) {
                $this->db->rollBack();
            }
            throw $error;
        }
        return $this->payload($owner);
    }

    private function device(?string $token, int $now): array|false
    {
        if ($token === null || !preg_match('/\A([a-f0-9]{32})\.([a-f0-9]{64})\z/D', $token, $parts)) {
            return false;
        }
        $statement = $this->db->prepare('SELECT d.* FROM nute_trusted_devices d
            INNER JOIN nute_owner o ON o.id = d.owner_id WHERE d.id = ? AND d.owner_id = 1 AND d.expires_at > ?');
        $statement->execute([$parts[1], $now]);
        $device = $statement->fetch();
        return $device && hash_equals($device['token_hash'], hash('sha256', $parts[2])) ? $device : false;
    }

    public function trustedDevice(?string $token, int $now): bool
    {
        return (bool) $this->device($token, $now);
    }

    private function issueDevice(?string $currentToken, string $userAgent, int $now): void
    {
        $this->db->prepare('DELETE FROM nute_trusted_devices WHERE expires_at <= ?')->execute([$now]);
        $this->forgetDevice($currentToken);
        if ((int) $this->db->query('SELECT COUNT(*) FROM nute_trusted_devices')->fetchColumn() >= 50) {
            throw new ApiError(409, 'device_limit', 'Слишком много доверенных устройств. Войдите без сохранения доверия и удалите старые устройства.');
        }
        $id = bin2hex(random_bytes(16));
        $secret = bin2hex(random_bytes(32));
        $expires = $now + self::DEVICE_LIFETIME;
        $this->db->prepare('INSERT INTO nute_trusted_devices (id, owner_id, token_hash, label, created_at, expires_at, last_used_at)
            VALUES (?, 1, ?, ?, ?, ?, ?)')
            ->execute([$id, hash('sha256', $secret), self::deviceLabel($userAgent), $now, $expires, $now]);
        // Keep this secret in an HttpOnly cookie only, never in a JSON response. Trusted
        // sign-ins do not renew it; stable credentials avoid concurrent-tab rotation races.
        $this->issuedDevice = ['token' => $id . '.' . $secret, 'expiresAt' => $expires];
    }

    public function issuedDeviceCookie(): ?array
    {
        return $this->issuedDevice;
    }

    private static function deviceLabel(string $userAgent): string
    {
        $ua = substr($userAgent, 0, 512);
        $browser = match (true) {
            str_contains($ua, 'Edg/') || str_contains($ua, 'EdgiOS/') => 'Edge',
            str_contains($ua, 'Firefox/') || str_contains($ua, 'FxiOS/') => 'Firefox',
            str_contains($ua, 'Chrome/') || str_contains($ua, 'CriOS/') => 'Chrome',
            str_contains($ua, 'Safari/') => 'Safari',
            default => 'Браузер',
        };
        $platform = match (true) {
            str_contains($ua, 'Android') => 'Android',
            str_contains($ua, 'iPad') => 'iPad',
            str_contains($ua, 'iPhone') => 'iPhone',
            str_contains($ua, 'Windows') => 'Windows',
            str_contains($ua, 'Macintosh') || str_contains($ua, 'Mac OS') => 'macOS / iPadOS',
            str_contains($ua, 'Linux') => 'Linux',
            default => 'устройство',
        };
        return $browser . ' · ' . $platform;
    }

    public function devices(int $now, ?string $currentToken): array
    {
        $current = $this->device($currentToken, $now);
        $statement = $this->db->prepare('SELECT id, label, created_at, expires_at, last_used_at FROM nute_trusted_devices
            WHERE owner_id = 1 AND expires_at > ? ORDER BY last_used_at DESC, id');
        $statement->execute([$now]);
        $devices = [];
        foreach ($statement->fetchAll() as $row) {
            $devices[] = ['id' => $row['id'], 'label' => $row['label'],
                'createdAt' => (int) $row['created_at'], 'expiresAt' => (int) $row['expires_at'],
                'lastUsedAt' => (int) $row['last_used_at'], 'current' => $current && $current['id'] === $row['id']];
        }
        return ['devices' => $devices];
    }

    public function revokeDevice(array $input, ?string $currentToken, int $now): array
    {
        $id = $input['id'] ?? null;
        if (!is_string($id) || !preg_match('/\A[a-f0-9]{32}\z/D', $id)) {
            throw new ApiError(422, 'invalid_device', 'Некорректное устройство.');
        }
        $current = $this->device($currentToken, $now);
        $this->db->prepare('DELETE FROM nute_trusted_devices WHERE id = ? AND owner_id = 1')->execute([$id]);
        return ['ok' => true, 'current' => $current && $current['id'] === $id];
    }

    public function forgetDevice(?string $token): void
    {
        if ($token !== null && preg_match('/\A([a-f0-9]{32})\.([a-f0-9]{64})\z/D', $token, $parts)) {
            $this->db->prepare('DELETE FROM nute_trusted_devices WHERE id = ? AND token_hash = ? AND owner_id = 1')
                ->execute([$parts[1], hash('sha256', $parts[2])]);
        }
    }

    public function readVault(): array
    {
        $owner = $this->owner();
        if (!$owner) {
            throw new ApiError(401, 'unauthorized', 'Войдите в хранилище.');
        }
        return $this->payload($owner);
    }

    private function pinInput(array $input): array
    {
        $id = $input['id'] ?? null;
        if (!is_string($id) || !preg_match('/\A[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\z/Di', $id)) {
            throw new ApiError(422, 'invalid_pin_id', 'Некорректный идентификатор защиты заметки.');
        }
        $proof = Crypto::decode64($input['proof'] ?? null, 32);
        $id = strtolower($id);
        // The client sends a separated 256-bit KDF proof, never the PIN or its
        // salt. A keyed, domain-separated digest binds it to this exact record.
        $digest = hash_hmac('sha256', 'NUTE/note-pin/v1:' . $id . ':' . $proof, $this->key);
        return [$id, $digest];
    }

    private function pinRecord(string $id): array|false
    {
        $suffix = $this->db->getAttribute(PDO::ATTR_DRIVER_NAME) === 'mysql' ? ' FOR UPDATE' : '';
        $query = $this->db->prepare('SELECT proof_hash FROM nute_note_pins WHERE id = ? AND owner_id = 1' . $suffix);
        $query->execute([$id]);
        return $query->fetch();
    }

    private function pinCheckLimits(string $id, int $now): void
    {
        // All requests count towards the owner cap. Successful proof checks
        // reset only the note bucket, while still holding its database lock.
        $this->limiter->take('pin/check/owner', 'owner', 30, 900, $now);
        $this->limiter->take('pin/check/note', $id, 5, 900, $now);
    }

    public function registerPin(array $input, int $now): array
    {
        [$id, $digest] = $this->pinInput($input);
        $this->limiter->take('pin/register/owner', 'owner', 60, 3600, $now);
        $transaction = WriteTransaction::begin($this->db);
        try {
            // Serialize registration against the single owner on MySQL: the
            // record cap and immutable IDs remain safe under concurrent tabs.
            if (!$this->owner(true)) {
                throw new ApiError(401, 'unauthorized', 'Войдите в хранилище.');
            }
            $record = $this->pinRecord($id);
            if ($record) {
                // Otherwise registration would be a second, less restricted
                // oracle for guessing an existing note's PIN proof.
                $this->pinCheckLimits($id, $now);
                if (!hash_equals($record['proof_hash'], $digest)) {
                    throw new ApiError(409, 'pin_exists', 'Для этой заметки уже установлен другой PIN-код.');
                }
                $this->limiter->reset('pin/check/note', $id, 900, $now);
            } else {
                if ((int) $this->db->query('SELECT COUNT(*) FROM nute_note_pins WHERE owner_id = 1')->fetchColumn() >= 20000) {
                    throw new ApiError(409, 'pin_limit', 'Достигнут предел защищённых заметок.');
                }
                $this->db->prepare('INSERT INTO nute_note_pins (id, owner_id, proof_hash, created_at) VALUES (?, 1, ?, ?)')
                    ->execute([$id, $digest, $now]);
            }
            $transaction->commit();
        } catch (ApiError $error) {
            // Expected failures must retain rate-limit increments. No note PIN
            // record is changed before any such error is raised.
            $transaction->commit();
            throw $error;
        } catch (Throwable $error) {
            $transaction->rollback();
            throw $error;
        }
        return ['ok' => true];
    }

    public function checkPin(array $input, int $now): array
    {
        [$id, $digest] = $this->pinInput($input);
        $this->limiter->take('pin/check/owner', 'owner', 30, 900, $now);
        $transaction = WriteTransaction::begin($this->db);
        try {
            $record = $this->pinRecord($id);
            if (!$record) {
                // Unknown IDs never create attacker-controlled per-note buckets.
                throw new ApiError(404, 'pin_missing', 'Защита этой заметки ещё не зарегистрирована на сервере.');
            }
            $this->limiter->take('pin/check/note', $id, 5, 900, $now);
            if (!hash_equals($record['proof_hash'], $digest)) {
                throw new ApiError(403, 'pin_invalid', 'Неверный PIN-код.');
            }
            $this->limiter->reset('pin/check/note', $id, 900, $now);
            $transaction->commit();
        } catch (ApiError $error) {
            $transaction->commit();
            throw $error;
        } catch (Throwable $error) {
            $transaction->rollback();
            throw $error;
        }
        return ['ok' => true];
    }

    public function saveVault(array $input, int $now): array
    {
        $revision = $input['revision'] ?? null;
        if (!is_int($revision) || $revision < 1 || $revision >= 9007199254740991) {
            throw new ApiError(422, 'invalid_revision', 'Некорректная версия хранилища.');
        }
        $vault = Crypto::envelope($input['vault'] ?? null);
        $transaction = WriteTransaction::begin($this->db);
        try {
            $this->owner(true);
            if ($this->db->query('SELECT owner_id FROM nute_sync_state WHERE owner_id = 1')->fetchColumn() !== false) {
                throw new ApiError(426, 'client_update_required', 'Хранилище использует новую синхронизацию. Сохраните резервную копию изменений и обновите приложение.');
            }
            $statement = $this->db->prepare('UPDATE nute_owner SET vault = ?, revision = revision + 1, updated_at = ? WHERE id = 1 AND revision = ?');
            $statement->execute([self::json($vault), $now, $revision]);
            if ($statement->rowCount() !== 1) {
                throw new ApiError(409, 'revision_conflict', 'Хранилище изменено в другом окне. Сначала загрузите актуальную версию.');
            }
            $transaction->commit();
        } catch (Throwable $error) {
            $transaction->rollback();
            throw $error;
        }
        return ['revision' => $revision + 1];
    }

    public function syncPull(array $input, int $now): array
    {
        return (new SyncJournal($this->db))->pull($input);
    }

    public function syncPush(array $input, int $now): array
    {
        return (new SyncJournal($this->db))->push($input, $now);
    }

    public function syncCheckpoint(array $input, int $now): array
    {
        return (new SyncJournal($this->db))->checkpoint($input);
    }

    private function payload(array $owner): array
    {
        return ['email' => $owner['email'], 'syncProtocol' => 1,
            'wrappedKey' => json_decode($owner['wrapped_key'], true, 512, JSON_THROW_ON_ERROR),
            'vault' => json_decode($owner['vault'], true, 512, JSON_THROW_ON_ERROR),
            'revision' => (int) $owner['revision']];
    }

    private static function loginFailure(): ApiError
    {
        return new ApiError(401, 'invalid_credentials', 'Неверный пароль или код аутентификатора.');
    }

    private static function json(mixed $value): string
    {
        return json_encode($value, JSON_UNESCAPED_SLASHES | JSON_THROW_ON_ERROR);
    }
}
