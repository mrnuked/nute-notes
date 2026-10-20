#!/usr/bin/env bash
# Fresh, independent instance only. Never run with bash -x (generated secrets).
set -Eeuo pipefail
umask 077

die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
usage() {
  cat <<'EOF'
Usage: sudo bash installer/install.sh --domain notes.example.org --email admin@example.org [--check|--finish-tls]
  --check       Read-only preflight. Does not install packages or create files.
  --finish-tls  Retry certificate/final HTTPS setup after this installer's ACME failure.
  --render NAME Render nginx-http, nginx-tls, or php-pool to stdout; no system changes.
Fresh Ubuntu 24.04/26.04, root, valid public DNS and incoming TCP 80/443 required.
The certificate request accepts the Let's Encrypt subscriber agreement.
EOF
}
domain='' email='' mode=install render=''
while (($#)); do
  case "$1" in
    --domain|--email|--render)
      (($# >= 2)) || die "Missing value for $1"
      case "$1" in --domain) domain=$2;; --email) email=$2;; --render) render=$2;; esac
      shift 2;;
    --check|--finish-tls)
      [[ $mode == install ]] || die 'Choose one operation.'
      mode=${1#--}; shift;;
    --help|-h) usage; exit 0;;
    *) die "Unknown argument: $1";;
  esac
done
[[ ${#domain} -le 253 && $domain =~ ^[a-z0-9.-]+$ && $domain == *.* && $domain != *..* ]] || die 'Use a fully qualified ASCII domain.'
IFS=. read -r -a labels <<<"$domain"
for label in "${labels[@]}"; do
  [[ $label =~ ^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$ ]] || die 'Domain labels must be lowercase ASCII/punycode.'
done
[[ ${labels[-1]} =~ [a-z] ]] || die 'An IP address is not a domain.'
[[ $domain != *. ]] || die 'Trailing dots are not accepted.'
if [[ -z $render ]]; then
  [[ ${#email} -le 254 && $email =~ ^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$ ]] || die 'A certificate contact email is required.'
fi

render_http() {
  cat <<EOF
server {
    listen 80;
    listen [::]:80;
    server_name $domain;
    server_tokens off;
    location ^~ /.well-known/acme-challenge/ {
        root /var/www/nute-acme;
        default_type text/plain;
        try_files \$uri =404;
    }
    location / { return 503; }
}
EOF
}
render_tls() {
  cat <<EOF
server {
    listen 80;
    listen [::]:80;
    server_name $domain;
    server_tokens off;
    location ^~ /.well-known/acme-challenge/ {
        root /var/www/nute-acme;
        default_type text/plain;
        try_files \$uri =404;
    }
    location / { return 308 https://$domain\$request_uri; }
}
server {
    listen 443 ssl;
    listen [::]:443 ssl;
    server_name $domain;
    ssl_certificate /etc/letsencrypt/live/$domain/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/$domain/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    server_tokens off;
    root /srv/nute/current/public;
    index index.php;
    client_max_body_size 20m;
    add_header Strict-Transport-Security "max-age=31536000" always;
    add_header X-Content-Type-Options nosniff always;
    add_header Referrer-Policy no-referrer always;
    add_header X-Frame-Options DENY always;
    location = /app.html { return 404; }
    location ~ /\\. { deny all; }
    location ~ \\.(sql|sqlite|db|log|ini|bak|env|md)$ { deny all; }
    location / { try_files \$uri \$uri/ =404; }
    location ~ ^/(index|api)\\.php$ {
        include fastcgi_params;
        fastcgi_hide_header Strict-Transport-Security;
        fastcgi_hide_header X-Content-Type-Options;
        fastcgi_hide_header Referrer-Policy;
        fastcgi_hide_header X-Frame-Options;
        fastcgi_hide_header X-Powered-By;
        fastcgi_param SCRIPT_FILENAME \$document_root\$fastcgi_script_name;
        fastcgi_param HTTPS on;
        fastcgi_pass unix:/run/php/nute.sock;
    }
    location ~ \\.php$ { return 404; }
}
EOF
}
render_pool() {
  cat <<'EOF'
[nute]
user = nute
group = nute
listen = /run/php/nute.sock
listen.owner = www-data
listen.group = www-data
listen.mode = 0660
pm = ondemand
pm.max_children = 2
pm.process_idle_timeout = 20s
pm.max_requests = 300
request_terminate_timeout = 60s
security.limit_extensions = .php
clear_env = yes
env[NUTE_CONFIG_PATH] = /srv/nute/private/config.php
php_admin_value[session.save_path] = /var/lib/nute/sessions
php_admin_value[session.gc_maxlifetime] = 15552000
php_admin_value[session.gc_probability] = 1
php_admin_value[session.gc_divisor] = 100
php_admin_value[memory_limit] = 192M
php_admin_value[max_execution_time] = 55
php_admin_value[post_max_size] = 20M
php_admin_flag[file_uploads] = off
php_admin_flag[display_errors] = off
php_admin_flag[log_errors] = on
php_admin_flag[expose_php] = off
php_admin_flag[allow_url_fopen] = off
php_admin_flag[session.use_strict_mode] = on
EOF
}
if [[ -n $render ]]; then
  [[ $mode == install ]] || die '--render cannot be combined with another operation.'
  case "$render" in nginx-http) render_http;; nginx-tls) render_tls;; php-pool) render_pool;; *) die 'Unknown template.';; esac
  exit 0
fi

[[ $EUID == 0 ]] || die 'Run preflight/install with sudo.'
[[ -r /etc/os-release ]] || die 'Ubuntu is required.'
. /etc/os-release
[[ $ID == ubuntu && ($VERSION_ID == 24.04 || $VERSION_ID == 26.04) ]] || die 'Only Ubuntu 24.04/26.04 is supported.'
[[ -d /run/systemd/system ]] || die 'A booted systemd server is required.'
source_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)
site=/etc/nginx/sites-available/nute
private=/srv/nute/private
mysql_cmd=(mysql --no-defaults --protocol=socket -uroot --batch --skip-column-names)

verify_dns() {
  getent ahosts "$domain" >/dev/null || die 'DNS does not resolve. Publish A/AAAA records first.'
  printf 'DNS resolves. Every public A/AAAA record must route to this server; ACME validates reachability.\n'
}
check_database() {
  if command -v mysql >/dev/null; then
    "${mysql_cmd[@]}" -e 'SELECT 1' >/dev/null || die 'Cannot inspect local MySQL as root; refusing to continue.'
    [[ $("${mysql_cmd[@]}" -e "SELECT COUNT(*) FROM information_schema.SCHEMATA WHERE SCHEMA_NAME='nute'") == 0 ]] || die 'Database nute already exists.'
    [[ $("${mysql_cmd[@]}" -e "SELECT COUNT(*) FROM mysql.user WHERE User='nute'") == 0 ]] || die 'MySQL account nute already exists.'
  elif [[ -d /var/lib/mysql && -n $(find /var/lib/mysql -mindepth 1 -maxdepth 1 -print -quit) ]]; then
    die 'Existing database files without a usable MySQL client.'
  fi
}
preflight() {
  for path in /srv/nute /var/lib/nute /var/backups/nute /var/www/nute-acme \
    "$site" /etc/nginx/sites-enabled/nute /run/php/nute.sock \
    /usr/local/sbin/nute-backup /etc/systemd/system/nute-backup.service \
    /etc/systemd/system/nute-backup.timer /etc/letsencrypt/renewal-hooks/deploy/nute-reload \
    "/etc/letsencrypt/live/$domain" "/etc/letsencrypt/archive/$domain" "/etc/letsencrypt/renewal/$domain.conf"; do
    [[ ! -e $path && ! -L $path ]] || die "Existing resource: $path. This is not an upgrade installer."
  done
  if getent passwd nute >/dev/null || getent group nute >/dev/null; then die 'System user/group nute already exists.'; fi
  if [[ -d /etc/php ]] && find /etc/php -path '*/pool.d/nute.conf' -print -quit | grep -q .; then die 'A NUTE PHP pool already exists.'; fi
  if command -v nginx >/dev/null; then
    # nginx -t/-T can open log files; keep --check strictly read-only.
    config=$(grep -Rhs 'server_name' /etc/nginx || true)
    if printf '%s\n' "$config" | grep -Fq "$domain"; then die 'Domain already occurs in nginx configuration.'; fi
    if printf '%s\n' "$config" | grep -E '^[[:space:]]*server_name[[:space:]].*[*~]' >/dev/null; then
      die 'Existing wildcard/regex nginx site requires manual conflict review.'
    fi
  fi
  if command -v ss >/dev/null; then
    listeners=$(ss -H -ltnp '( sport = :80 or sport = :443 )')
    if [[ -n $listeners ]] && printf '%s\n' "$listeners" | grep -v '"nginx"' >/dev/null; then die 'Ports 80/443 are owned by a service other than nginx.'; fi
  fi
  if dpkg-query -W -f='${Status}' mariadb-server 2>/dev/null | grep -q 'install ok installed'; then die 'MariaDB present; this fresh-server installer uses Ubuntu MySQL.'; fi
  check_database
  for path in public/index.php public/api.php public/app.html server/Core.php server/App.php server/Http.php database/mysql.sql scripts/init.php installer/backup.sh installer/init-input.php installer/nute-backup.service installer/nute-backup.timer installer/renewal-hook.sh; do
    [[ -f $source_root/$path && ! -L $source_root/$path ]] || die "Missing/linked package file: $path"
  done
  for path in public server database scripts installer; do
    [[ ! -L $source_root/$path ]] || die 'Linked package directories are forbidden.'
    [[ -z $(find "$source_root/$path" -type l -print -quit) ]] || die 'Package symlinks are forbidden.'
  done
  verify_dns
}

finish_tls() {
  [[ -f $private/tls-pending.sha256 && ! -L $private/tls-pending.sha256 ]] || die 'No controlled TLS retry state exists.'
  [[ $(stat -c '%u:%a' "$private/tls-pending.sha256") == 0:600 ]] || die 'Unsafe TLS state permissions.'
  [[ $(cat "$private/install-domain") == "$domain" && $(cat "$private/install-email") == "$email" ]] || die 'TLS retry must use the original domain/email.'
  sha256sum --check --status "$private/tls-pending.sha256" || die 'Installed configuration changed; manual review required.'
  [[ $(readlink /etc/nginx/sites-enabled/nute) == "$site" ]] || die 'Nginx site link changed.'
  verify_dns
  certbot certonly --non-interactive --agree-tos --email "$email" --webroot \
    --webroot-path /var/www/nute-acme --cert-name "$domain" -d "$domain" --keep-until-expiring
  # Only our own HTTP site is replaced; retain it for rollback on nginx validation failure.
  render_tls > "$private/nginx-https.conf"
  cp "$site" "$private/nginx-http.conf"
  cat "$private/nginx-https.conf" > "$site"
  if ! nginx -t; then
    cat "$private/nginx-http.conf" > "$site"
    die 'HTTPS nginx validation failed; original HTTP site restored.'
  fi
  pool=$(find /etc/php -path '*/pool.d/nute.conf' -type f)
  [[ -f $pool ]] || die 'Expected exactly one NUTE PHP pool.'
  sha256sum "$private/config.php" "$site" "$pool" > "$private/tls-pending.sha256"
  systemctl reload nginx
  curl --fail --silent --show-error --resolve "$domain:443:127.0.0.1" "https://$domain/api.php?action=bootstrap" \
    | php -r '$v=json_decode(stream_get_contents(STDIN),true,32,JSON_THROW_ON_ERROR); if (!is_array($v) || !isset($v["csrf"]) || !array_key_exists("initialized",$v)) exit(1);'
  mv "$private/tls-pending.sha256" "$private/install-complete.sha256"
  printf 'Installation complete: https://%s/?setup\nRead the private setup token with: sudo cat /srv/nute/private/first-owner.txt\n' "$domain"
}

if [[ $mode == finish-tls ]]; then finish_tls; exit 0; fi
preflight
if [[ $mode == check ]]; then
  printf 'Read-only preflight passed. No files, packages, database, DNS, firewall or SSH settings changed.\n'
  exit 0
fi
trap 'printf "\nInstallation stopped. Existing state was preserved. Do not delete databases/config or rerun initialization. See docs/INSTALL.md.\n" >&2' ERR
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y --no-install-recommends nginx php-fpm php-cli php-mysql php-mbstring mysql-server certbot curl ca-certificates
nginx -t
systemctl start mysql
check_database
php -r 'exit(PHP_VERSION_ID >= 80300 && extension_loaded("pdo_mysql") && extension_loaded("mbstring") && extension_loaded("openssl") ? 0 : 1);' || die 'PHP 8.3+ with required extensions is unavailable.'
phpversion=$(php -r 'echo PHP_MAJOR_VERSION,".",PHP_MINOR_VERSION;')
[[ -d /etc/php/$phpversion/fpm/pool.d ]] || die 'CLI and FPM versions do not match.'
command -v "php-fpm$phpversion" >/dev/null || die 'Matching PHP-FPM binary is missing.'
useradd --system --user-group --home-dir /srv/nute --shell /usr/sbin/nologin nute
install -d -m 0755 /srv/nute /srv/nute/releases /srv/nute/releases/initial /var/www/nute-acme /var/lib/nute
install -d -o root -g nute -m 0750 "$private"
install -d -o nute -g nute -m 0700 /var/lib/nute/sessions
install -d -o root -g root -m 0700 /var/backups/nute
for path in public server database; do cp -R "$source_root/$path" /srv/nute/releases/initial/; done
install -d -m 0755 /srv/nute/releases/initial/scripts
install -m 0644 "$source_root/scripts/init.php" /srv/nute/releases/initial/scripts/
for path in "$source_root"/scripts/migrate-*.php; do
  [[ -f $path && ! -L $path ]] || continue
  install -m 0644 "$path" /srv/nute/releases/initial/scripts/
done
chown -R root:root /srv/nute/releases/initial
find /srv/nute/releases/initial -type d -exec chmod 0755 {} +
find /srv/nute/releases/initial -type f -exec chmod 0644 {} +
ln -s /srv/nute/releases/initial /srv/nute/current
export NUTE_INSTALL_DOMAIN=$domain
NUTE_INSTALL_DB_PASSWORD=$(php -r 'echo bin2hex(random_bytes(32));')
export NUTE_INSTALL_DB_PASSWORD
# Random hex is the only SQL interpolation. Secrets never enter command-line arguments.
"${mysql_cmd[@]}" <<SQL
CREATE DATABASE nute CHARACTER SET utf8mb4 COLLATE utf8mb4_bin;
CREATE USER 'nute'@'localhost' IDENTIFIED BY '$NUTE_INSTALL_DB_PASSWORD';
GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, REFERENCES ON nute.* TO 'nute'@'localhost';
SQL
php "$source_root/installer/init-input.php" | php /srv/nute/current/scripts/init.php --config="$private/config.php" > "$private/first-owner.txt"
unset NUTE_INSTALL_DB_PASSWORD NUTE_INSTALL_DOMAIN
"${mysql_cmd[@]}" -e "REVOKE CREATE, REFERENCES ON nute.* FROM 'nute'@'localhost';"
chown root:nute "$private/config.php"
chmod 0640 "$private/config.php"
chmod 0600 "$private/first-owner.txt"
render_pool > "/etc/php/$phpversion/fpm/pool.d/nute.conf"
chmod 0644 "/etc/php/$phpversion/fpm/pool.d/nute.conf"
"php-fpm$phpversion" -t
systemctl enable --now "php$phpversion-fpm" mysql nginx
systemctl reload "php$phpversion-fpm"
render_http > "$site"
chmod 0644 "$site"
ln -s "$site" /etc/nginx/sites-enabled/nute
nginx -t
systemctl reload nginx
install -m 0700 "$source_root/installer/backup.sh" /usr/local/sbin/nute-backup
install -m 0644 "$source_root/installer/nute-backup.service" /etc/systemd/system/nute-backup.service
install -m 0644 "$source_root/installer/nute-backup.timer" /etc/systemd/system/nute-backup.timer
install -d -m 0755 /etc/letsencrypt/renewal-hooks/deploy
install -m 0755 "$source_root/installer/renewal-hook.sh" /etc/letsencrypt/renewal-hooks/deploy/nute-reload
systemctl daemon-reload
systemctl enable --now nute-backup.timer certbot.timer
systemctl start nute-backup.service
printf '%s\n' "$domain" > "$private/install-domain"
printf '%s\n' "$email" > "$private/install-email"
sha256sum "$private/config.php" "$site" "/etc/php/$phpversion/fpm/pool.d/nute.conf" > "$private/tls-pending.sha256"
chmod 0600 "$private/tls-pending.sha256"
finish_tls
