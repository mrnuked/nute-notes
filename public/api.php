<?php
declare(strict_types=1);

use Nute\ApiError;
use Nute\App;
use Nute\Config;
use Nute\Http;

ini_set('display_errors', '0');
require_once dirname(__DIR__) . '/server/Http.php';
require_once dirname(__DIR__) . '/server/App.php';

Http::headers(Http::secure());
try {
    $config = Config::load();
    $action = $_GET['action'] ?? '';
    $method = $_SERVER['REQUEST_METHOD'] ?? '';
    $methods = ['bootstrap' => 'GET', 'email' => 'POST', 'setup' => 'POST', 'login' => 'POST',
        'vault' => ['GET', 'PUT'], 'resume' => 'POST', 'logout' => 'POST', 'devices' => 'GET', 'revoke_device' => 'POST',
        'pin_register' => 'POST', 'pin_check' => 'POST',
        'sync_pull' => 'POST', 'sync_push' => 'POST', 'sync_checkpoint' => 'POST'];
    if (!is_string($action) || !array_key_exists($action, $methods)) {
        throw new ApiError(404, 'not_found', 'Запрос не найден.');
    }
    if (!in_array($method, (array) $methods[$action], true)) {
        header('Allow: ' . implode(', ', (array) $methods[$action]));
        throw new ApiError(405, 'method_not_allowed', 'Метод запроса не поддерживается.');
    }
    $mutation = $method !== 'GET';
    Http::validateRequest($config, $mutation);
    Http::session($config);
    if ($mutation) {
        Http::csrf();
    }
    if ($action === 'sync_checkpoint') {
        Http::requireOwner(time());
        Http::requireCurrentClient();
    }
    $input = $mutation ? Http::input($action === 'sync_checkpoint' ? 20 * 1024 * 1024 : Http::MAX_REQUEST_BYTES) : [];
    $app = new App(Config::connect($config), $config);
    $now = time();
    $ip = $_SERVER['REMOTE_ADDR'] ?? 'unknown';
    $deviceToken = Http::deviceCookie($config);
    $result = match ($action) {
        'bootstrap' => ['initialized' => $app->initialized(), 'csrf' => $_SESSION['csrf'], 'syncProtocol' => 1,
            'trustedDevice' => $app->trustedDevice($deviceToken, $now)],
        'email' => $app->identify($input, $ip, $now),
        'setup' => $app->setup($input, $ip, $now),
        'login' => $app->login($input, $ip, $now, $deviceToken, $_SERVER['HTTP_USER_AGENT'] ?? ''),
        'resume' => (static function () use ($app, $now): array {
            Http::requireOwner($now);
            return $app->readVault() + ['resumeSecret' => Http::resumeSecret()];
        })(),
        'vault' => (static function () use ($app, $method, $input, $now): array {
            Http::requireOwner($now);
            if ($method === 'PUT') {
                Http::requireCurrentClient(true);
            }
            return $method === 'GET' ? $app->readVault() : $app->saveVault($input, $now);
        })(),
        'pin_register', 'pin_check' => (static function () use ($app, $action, $input, $now): array {
            Http::requireOwner($now);
            Http::requireCurrentClient(true);
            return $action === 'pin_register' ? $app->registerPin($input, $now) : $app->checkPin($input, $now);
        })(),
        'sync_pull', 'sync_push', 'sync_checkpoint' => (static function () use ($app, $action, $input, $now): array {
            Http::requireOwner($now);
            Http::requireCurrentClient();
            return match ($action) {
                'sync_pull' => $app->syncPull($input, $now),
                'sync_push' => $app->syncPush($input, $now),
                'sync_checkpoint' => $app->syncCheckpoint($input, $now),
            };
        })(),
        'devices' => (static function () use ($app, $now, $deviceToken): array {
            Http::requireOwner($now);
            return $app->devices($now, $deviceToken);
        })(),
        'revoke_device' => (static function () use ($app, $now, $input, $deviceToken, $config): array {
            Http::requireOwner($now);
            $revoked = $app->revokeDevice($input, $deviceToken, $now);
            if ($revoked['current']) {
                Http::setDeviceCookie($config, null);
            }
            return $revoked;
        })(),
        'logout' => (static function () use ($app, $input, $deviceToken, $config): array {
            if (isset($input['forgetDevice']) && !is_bool($input['forgetDevice'])) {
                throw new ApiError(422, 'invalid_input', 'Некорректный выбор выхода.');
            }
            if (($input['forgetDevice'] ?? false) === true) {
                $app->forgetDevice($deviceToken);
                Http::setDeviceCookie($config, null);
            }
            Http::logout();
            return ['ok' => true];
        })(),
    };
    if ($action === 'setup' || $action === 'login') {
        Http::authenticate($now);
        $result['csrf'] = $_SESSION['csrf'];
        $result['resumeSecret'] = Http::resumeSecret();
    }
    if ($action === 'login' && $app->issuedDeviceCookie() !== null) {
        Http::setDeviceCookie($config, $app->issuedDeviceCookie());
    }
    Http::respond($result);
} catch (ApiError $error) {
    if ($error->status === 429) {
        header('Retry-After: 900');
    }
    Http::respond(['error' => $error->error, 'message' => $error->getMessage()], $error->status);
} catch (Throwable $error) {
    // Never return SQL, paths, secrets, or request contents to the browser.
    error_log('NUTE request failed: ' . get_class($error));
    Http::respond(['error' => 'server_error', 'message' => 'Сервис временно недоступен. Повторите позже.'], 500);
}
