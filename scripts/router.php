<?php
// Local development router. Production must serve only public/ through Apache/Nginx.
$path = parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH);
if ($path === '/app.html' || str_contains($path, '..') || str_contains($path, '/.')) {
    http_response_code(404); exit;
}
if ($path === '/') { require dirname(__DIR__) . '/public/index.php'; return true; }
return false;
