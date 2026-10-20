<?php
declare(strict_types=1);

require_once dirname(__DIR__) . '/server/Http.php';
\Nute\Http::headers(\Nute\Http::secure());
header('Content-Type: text/html; charset=utf-8');
readfile(__DIR__ . '/app.html');
