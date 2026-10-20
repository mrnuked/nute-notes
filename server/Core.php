<?php
declare(strict_types=1);

namespace Nute;

use PDO;
use RuntimeException;

final class ApiError extends RuntimeException
{
    public function __construct(public readonly int $status, public readonly string $error, string $message)
    {
        parent::__construct($message);
    }
}

final class Config
{
    public static function load(): array
    {
        $path = getenv('NUTE_CONFIG_PATH') ?: dirname(__DIR__) . '/private/config.php';
        if (!is_file($path)) {
            throw new ApiError(503, 'not_configured', 'Сервер ещё не настроен.');
        }
        $config = require $path;
        if (!is_array($config)) {
            throw new RuntimeException('Invalid configuration');
        }
        self::validate($config);
        return $config;
    }

    public static function validate(array $config): void
    {
        foreach (['environment', 'origin', 'dsn', 'db_user', 'db_password', 'app_key', 'setup_token_hash'] as $key) {
            if (!isset($config[$key]) || !is_string($config[$key])) {
                throw new RuntimeException('Missing configuration');
            }
        }
        if (!in_array($config['environment'], ['production', 'local'], true)) {
            throw new RuntimeException('Invalid environment');
        }
        $url = parse_url($config['origin']);
        if (!$url || !isset($url['scheme'], $url['host']) || isset($url['user']) || isset($url['pass'])
            || isset($url['path']) || isset($url['query']) || isset($url['fragment'])) {
            throw new RuntimeException('Invalid origin');
        }
        $local = $config['environment'] === 'local';
        if (($local && (!in_array($url['host'], ['localhost', '127.0.0.1', '[::1]'], true)
                || !in_array($url['scheme'], ['http', 'https'], true)))
            || (!$local && ($url['scheme'] !== 'https' || !str_starts_with($config['dsn'], 'mysql:')))) {
            throw new RuntimeException('Unsafe origin or database configuration');
        }
        if (strlen(base64_decode($config['app_key'], true) ?: '') !== 32
            || !preg_match('/\A[a-f0-9]{64}\z/D', $config['setup_token_hash'])) {
            throw new RuntimeException('Invalid key configuration');
        }
    }

    public static function connect(array $config): PDO
    {
        $db = new PDO($config['dsn'], $config['db_user'], $config['db_password'], [
            PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
            PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
            PDO::ATTR_EMULATE_PREPARES => false,
        ]);
        if ($db->getAttribute(PDO::ATTR_DRIVER_NAME) === 'sqlite') {
            if ($config['environment'] !== 'local') {
                throw new RuntimeException('SQLite is restricted to local development');
            }
            $db->exec('PRAGMA busy_timeout = 5000');
        }
        return $db;
    }
}

final class Crypto
{
    public static function decode64(mixed $value, int $bytes): string
    {
        if (!is_string($value) || strlen($value) > 4 * (int) ceil($bytes / 3)) {
            throw new ApiError(422, 'invalid_input', 'Некорректный формат данных.');
        }
        $decoded = base64_decode($value, true);
        if ($decoded === false || strlen($decoded) !== $bytes || base64_encode($decoded) !== $value) {
            throw new ApiError(422, 'invalid_input', 'Некорректный формат данных.');
        }
        return $decoded;
    }

    public static function envelope(mixed $value, bool $wrapped = false, int $maxBytes = 2800000): array
    {
        if (!is_array($value) || ($value['v'] ?? null) !== 1
            || array_diff(array_keys($value), ['v', 'iv', 'ciphertext'])) {
            throw new ApiError(422, 'invalid_envelope', 'Некорректные зашифрованные данные.');
        }
        self::decode64($value['iv'] ?? null, 12);
        $text = $value['ciphertext'] ?? null;
        // Individual operations remain small; authenticated checkpoints have a separate cap.
        if (!is_string($text) || strlen($text) > $maxBytes) {
            throw new ApiError(413, 'vault_too_large', 'Размер хранилища превышает допустимый.');
        }
        $cipher = base64_decode($text, true);
        if ($cipher === false || strlen($cipher) < 16 || base64_encode($cipher) !== $text
            || ($wrapped && strlen($cipher) !== 48)) {
            throw new ApiError(422, 'invalid_envelope', 'Некорректные зашифрованные данные.');
        }
        return ['v' => 1, 'iv' => $value['iv'], 'ciphertext' => $text];
    }

    public static function encryptSecret(string $secret, string $key): string
    {
        $iv = random_bytes(12);
        $cipher = openssl_encrypt($secret, 'aes-256-gcm', $key, OPENSSL_RAW_DATA, $iv, $tag, 'NUTE/totp/v1', 16);
        if ($cipher === false) {
            throw new RuntimeException('Secret encryption failed');
        }
        return base64_encode($iv . $tag . $cipher);
    }

    public static function decryptSecret(string $encoded, string $key): string
    {
        $blob = base64_decode($encoded, true);
        if ($blob === false || strlen($blob) < 29) {
            throw new RuntimeException('Invalid stored secret');
        }
        $plain = openssl_decrypt(substr($blob, 28), 'aes-256-gcm', $key, OPENSSL_RAW_DATA,
            substr($blob, 0, 12), substr($blob, 12, 16), 'NUTE/totp/v1');
        if ($plain === false) {
            throw new RuntimeException('Secret authentication failed');
        }
        return $plain;
    }

    public static function base32Decode(string $secret): string
    {
        if (!preg_match('/\A[A-Z2-7]{32}\z/D', $secret)) {
            throw new ApiError(422, 'invalid_totp', 'Некорректный ключ аутентификатора.');
        }
        $alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
        $buffer = 0;
        $bits = 0;
        $result = '';
        foreach (str_split($secret) as $char) {
            $buffer = ($buffer << 5) | strpos($alphabet, $char);
            $bits += 5;
            if ($bits >= 8) {
                $bits -= 8;
                $result .= chr(($buffer >> $bits) & 255);
                $buffer &= (1 << $bits) - 1;
            }
        }
        return $result;
    }

    public static function totp(string $secret, int $step): string
    {
        $counter = pack('N2', (int) floor($step / 4294967296), $step & 0xffffffff);
        $hash = hash_hmac('sha1', $counter, self::base32Decode($secret), true);
        $offset = ord($hash[19]) & 15;
        $number = unpack('N', substr($hash, $offset, 4))[1] & 0x7fffffff;
        return str_pad((string) ($number % 1000000), 6, '0', STR_PAD_LEFT);
    }

    public static function matchTotp(string $secret, mixed $otp, int $now, int $afterStep): ?int
    {
        if (!is_string($otp) || !preg_match('/\A[0-9]{6}\z/D', $otp)) {
            return null;
        }
        $step = intdiv($now, 30);
        foreach ([$step, $step - 1, $step + 1] as $candidate) {
            if ($candidate > $afterStep && hash_equals(self::totp($secret, $candidate), $otp)) {
                return $candidate;
            }
        }
        return null;
    }

    public static function passwordHash(string $proof): string
    {
        return defined('PASSWORD_ARGON2ID')
            ? password_hash($proof, PASSWORD_ARGON2ID, ['memory_cost' => 65536, 'time_cost' => 3, 'threads' => 1])
            : password_hash($proof, PASSWORD_BCRYPT, ['cost' => 12]);
    }

    public static function recoveryHash(string $code, string $key): string
    {
        return hash_hmac('sha256', 'NUTE/recovery/v1:' . strtoupper(str_replace('-', '', trim($code))), $key);
    }
}

final class RateLimiter
{
    public function __construct(private PDO $db, private string $key) {}

    // Call while holding the same database lock that serializes the protected
    // operation; otherwise a success could erase a concurrent failed attempt.
    public function reset(string $scope, string $identity, int $window, int $now): void
    {
        $expiry = (intdiv($now, $window) + 1) * $window;
        $bucket = hash_hmac('sha256', $scope . ':' . $identity . ':' . $expiry, $this->key);
        $this->db->prepare('DELETE FROM nute_rate_limits WHERE bucket = ?')->execute([$bucket]);
    }

    public function take(string $scope, string $identity, int $maximum, int $window, int $now): void
    {
        $expiry = (intdiv($now, $window) + 1) * $window;
        $bucket = hash_hmac('sha256', $scope . ':' . $identity . ':' . $expiry, $this->key);
        $sql = $this->db->getAttribute(PDO::ATTR_DRIVER_NAME) === 'mysql'
            ? 'INSERT INTO nute_rate_limits (bucket, attempts, expires_at) VALUES (?, 1, ?) ON DUPLICATE KEY UPDATE attempts = attempts + 1'
            : 'INSERT INTO nute_rate_limits (bucket, attempts, expires_at) VALUES (?, 1, ?) ON CONFLICT(bucket) DO UPDATE SET attempts = attempts + 1';
        $this->db->prepare($sql)->execute([$bucket, $expiry]);
        $statement = $this->db->prepare('SELECT attempts FROM nute_rate_limits WHERE bucket = ?');
        $statement->execute([$bucket]);
        $attempts = (int) $statement->fetchColumn();
        // Release SQLite's implicit read lock before cleanup writes. Keeping
        // this cursor open can deadlock with another connection's writer lock.
        $statement->closeCursor();
        $this->db->prepare('DELETE FROM nute_rate_limits WHERE expires_at < ?')->execute([$now]);
        if ($attempts > $maximum) {
            throw new ApiError(429, 'rate_limited', 'Слишком много попыток. Повторите позже.');
        }
    }
}
