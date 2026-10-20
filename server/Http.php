<?php
declare(strict_types=1);

namespace Nute;

require_once __DIR__ . '/Core.php';

final class Http
{
    public const MAX_REQUEST_BYTES = 4194304;
    public const SESSION_MAX_AGE = 180 * 86400;
    private const PREAUTH_MAX_AGE = 86400;

    public static function headers(bool $secure): void
    {
        header("Content-Security-Policy: default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; manifest-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; object-src 'none'");
        header('X-Content-Type-Options: nosniff');
        header('X-Frame-Options: DENY');
        header('Referrer-Policy: no-referrer');
        header('Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=(), usb=()');
        header('Cross-Origin-Opener-Policy: same-origin');
        header('Cross-Origin-Resource-Policy: same-origin');
        header('Cache-Control: no-store, max-age=0');
        header('Pragma: no-cache');
        if ($secure) {
            header('Strict-Transport-Security: max-age=31536000');
        }
    }

    public static function secure(): bool
    {
        // Deliberately do not trust client-supplied X-Forwarded-Proto.
        return (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off')
            || (int) ($_SERVER['SERVER_PORT'] ?? 0) === 443;
    }

    public static function validateRequest(array $config, bool $mutation): void
    {
        if ($config['environment'] === 'production' && !self::secure()) {
            throw new ApiError(400, 'https_required', 'Требуется защищённое HTTPS-соединение.');
        }
        if ($config['environment'] === 'local'
            && !in_array($_SERVER['REMOTE_ADDR'] ?? '', ['127.0.0.1', '::1'], true)) {
            throw new ApiError(403, 'local_only', 'Локальная среда доступна только с этого компьютера.');
        }
        $origin = $_SERVER['HTTP_ORIGIN'] ?? null;
        if (($mutation && $origin !== $config['origin']) || ($origin !== null && $origin !== $config['origin'])
            || (isset($_SERVER['HTTP_SEC_FETCH_SITE']) && !in_array($_SERVER['HTTP_SEC_FETCH_SITE'], ['same-origin', 'none'], true))) {
            throw new ApiError(403, 'origin_denied', 'Источник запроса не разрешён.');
        }
        $url = parse_url($config['origin']);
        $expectedHost = $url['host'] . (isset($url['port']) ? ':' . $url['port'] : '');
        if (strtolower($_SERVER['HTTP_HOST'] ?? '') !== strtolower($expectedHost)) {
            throw new ApiError(403, 'host_denied', 'Адрес сервера не разрешён.');
        }
    }

    public static function session(array $config): void
    {
        ini_set('session.use_strict_mode', '1');
        ini_set('session.use_only_cookies', '1');
        ini_set('session.use_trans_sid', '0');
        ini_set('session.gc_maxlifetime', (string) self::SESSION_MAX_AGE);
        session_name($config['environment'] === 'production' ? '__Host-nute' : 'nute_local');
        session_set_cookie_params(['lifetime' => 0, 'path' => '/', 'secure' => $config['environment'] === 'production',
            'httponly' => true, 'samesite' => 'Strict']);
        $cookie = $_COOKIE[session_name()] ?? '';
        // Read legacy/authenticated PHP sessions, but never retain anonymous
        // records (including strict-mode replacements for forged cookie IDs).
        if (is_string($cookie) && preg_match('/\A[A-Za-z0-9,-]{16,128}\z/D', $cookie)) {
            session_id($cookie);
            if (!session_start()) throw new \RuntimeException('Session unavailable');
            if (($_SESSION['owner'] ?? null) === 1) return;
            if (!session_destroy()) throw new \RuntimeException('Session removal failed');
        }
        session_id('');
        $_SESSION = [];
        $now = time();
        $key = base64_decode($config['app_key'], true);
        if (!is_string($key) || strlen($key) !== 32) throw new \RuntimeException('Invalid session signing key');
        $valid = is_string($cookie) && preg_match('/\Apre\.([0-9]{10})\.([a-f0-9]{64})\.([a-f0-9]{64})\z/D', $cookie, $parts)
            && (int) $parts[1] <= $now && $now - (int) $parts[1] < self::PREAUTH_MAX_AGE
            && hash_equals(hash_hmac('sha256', 'NUTE/preauth/v1:' . $parts[1] . ':' . $parts[2], $key), $parts[3]);
        if ($valid) {
            $_SESSION['csrf'] = $parts[2];
        } else {
            $_SESSION['csrf'] = bin2hex(random_bytes(32));
            $signature = hash_hmac('sha256', 'NUTE/preauth/v1:' . $now . ':' . $_SESSION['csrf'], $key);
            setcookie(session_name(), 'pre.' . $now . '.' . $_SESSION['csrf'] . '.' . $signature,
                ['path' => '/', 'secure' => $config['environment'] === 'production', 'httponly' => true, 'samesite' => 'Strict']);
        }
    }

    public static function csrf(): void
    {
        $csrf = $_SERVER['HTTP_X_CSRF_TOKEN'] ?? '';
        if (!is_string($csrf) || !isset($_SESSION['csrf']) || !hash_equals($_SESSION['csrf'], $csrf)) {
            throw new ApiError(403, 'csrf_failed', 'Обновите страницу и повторите действие.');
        }
    }

    public static function requireCurrentClient(bool $allowLegacy = false): void
    {
        if (!in_array($_SERVER['HTTP_X_NUTE_CLIENT'] ?? '', $allowLegacy ? ['0.3', '0.4'] : ['0.4'], true)) {
            throw new ApiError(426, 'client_update_required', 'Эта вкладка использует старую версию NUTE. Сохраните резервную копию несохранённых изменений, затем обновите страницу.');
        }
    }

    public static function deviceCookie(array $config): ?string
    {
        $name = $config['environment'] === 'production' ? '__Host-nute_device' : 'nute_device_local';
        $value = $_COOKIE[$name] ?? null;
        return is_string($value) && strlen($value) <= 97 ? $value : null;
    }

    public static function setDeviceCookie(array $config, ?array $device): void
    {
        $name = $config['environment'] === 'production' ? '__Host-nute_device' : 'nute_device_local';
        setcookie($name, $device['token'] ?? '', ['expires' => $device['expiresAt'] ?? time() - 3600,
            'path' => '/', 'secure' => $config['environment'] === 'production',
            'httponly' => true, 'samesite' => 'Strict']);
    }

    public static function authenticate(int $now): void
    {
        $csrf = $_SESSION['csrf'];
        if (session_status() !== PHP_SESSION_ACTIVE) {
            // The pre-auth cookie is not a PHP session ID. Allocate only after
            // password + second-factor (or setup) verification has succeeded.
            unset($_COOKIE[session_name()]);
            session_id('');
            if (!session_start()) throw new \RuntimeException('Session unavailable');
        }
        if (!session_regenerate_id(true)) throw new \RuntimeException('Session rotation failed');
        $_SESSION['csrf'] = $csrf;
        $_SESSION['owner'] = 1;
        $_SESSION['created_at'] = $now;
        $_SESSION['last_activity'] = $now;
        // Protects the browser's encrypted reload capsule. The vault key and
        // capsule stay on the client; this secret belongs only to this login.
        $_SESSION['resume_secret'] = base64_encode(random_bytes(32));
        // Keep the CSRF token stable for requests queued by the same browser page.
    }

    public static function requireOwner(int $now): void
    {
        $created = $_SESSION['created_at'] ?? null;
        if (($_SESSION['owner'] ?? null) !== 1
            || !is_int($created) || $created > $now
            || $now - $created >= self::SESSION_MAX_AGE) {
            unset($_SESSION['owner'], $_SESSION['created_at'], $_SESSION['last_activity'], $_SESSION['resume_secret']);
            throw new ApiError(401, 'session_expired', 'Сеанс завершён. Войдите снова.');
        }
        $_SESSION['last_activity'] = $now;
    }

    // Call only after authenticate() or requireOwner(). Older sessions without
    // a capsule secret must authenticate once to enable reload restoration.
    public static function resumeSecret(): string
    {
        $secret = $_SESSION['resume_secret'] ?? null;
        if (($_SESSION['owner'] ?? null) !== 1 || !is_string($secret)
            || strlen($secret) !== 44 || strlen((string) base64_decode($secret, true)) !== 32) {
            throw new ApiError(401, 'session_expired', 'Сеанс завершён. Войдите снова.');
        }
        return $secret;
    }

    public static function logout(): void
    {
        $_SESSION = [];
        $params = session_get_cookie_params();
        setcookie(session_name(), '', ['expires' => time() - 3600, 'path' => $params['path'],
            'secure' => $params['secure'], 'httponly' => true, 'samesite' => 'Strict']);
        if (session_status() === PHP_SESSION_ACTIVE && !session_destroy()) {
            throw new \RuntimeException('Session removal failed');
        }
    }

    public static function input(int $maxBytes = self::MAX_REQUEST_BYTES): array
    {
        $type = strtolower(trim(explode(';', $_SERVER['CONTENT_TYPE'] ?? '')[0]));
        if ($type !== 'application/json') {
            throw new ApiError(415, 'json_required', 'Требуется JSON-запрос.');
        }
        if ((int) ($_SERVER['CONTENT_LENGTH'] ?? 0) > $maxBytes) {
            throw new ApiError(413, 'request_too_large', 'Размер запроса превышает допустимый.');
        }
        $stream = fopen('php://input', 'rb');
        $body = stream_get_contents($stream, $maxBytes + 1);
        fclose($stream);
        if ($body === false || strlen($body) > $maxBytes) {
            throw new ApiError(413, 'request_too_large', 'Размер запроса превышает допустимый.');
        }
        try {
            $decoded = json_decode($body, true, 32, JSON_THROW_ON_ERROR);
        } catch (\JsonException) {
            throw new ApiError(400, 'invalid_json', 'Некорректный JSON-запрос.');
        }
        if (!is_array($decoded) || !str_starts_with(ltrim($body), '{')) {
            throw new ApiError(400, 'invalid_json', 'Ожидается JSON-объект.');
        }
        return $decoded;
    }

    public static function respond(array $data, int $status = 200): never
    {
        http_response_code($status);
        header('Content-Type: application/json; charset=utf-8');
        echo json_encode($data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_THROW_ON_ERROR);
        exit;
    }
}
