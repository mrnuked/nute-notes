#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
[[ $EUID == 0 ]] || exit 1
base=/var/backups/nute
[[ -d $base && ! -L $base ]] || exit 1
exec 9>/run/lock/nute-backup.lock
flock -n 9 || exit 0
work=$(mktemp -d "$base/.work.XXXXXXXX")
cleanup() {
  # Refuse recursive removal unless mktemp returned a direct child of our backup root.
  [[ $work == "$base"/.work.* && $(dirname -- "$work") == "$base" && ! -L $work ]] && rm -rf -- "$work"
}
trap cleanup EXIT
mysqldump --no-defaults --protocol=socket -uroot --single-transaction --skip-lock-tables \
  --no-tablespaces --set-gtid-purged=OFF nute > "$work/database.sql"
cp /srv/nute/private/config.php "$work/config.php"
readlink -f /srv/nute/current > "$work/release.txt"
stamp=$(date -u +%Y%m%dT%H%M%SZ)
target="$base/nute-$stamp.tar.gz"
[[ ! -e $target ]] || { printf 'Backup name collision; retry after one second.\n' >&2; exit 1; }
tar -czf "$work/archive.tar.gz" -C "$work" database.sql config.php release.txt
tar -tzf "$work/archive.tar.gz" >/dev/null
mv -- "$work/archive.tar.gz" "$target"
printf 'Backup created: %s\n' "$target"
# No automatic deletion: arrange off-server copies and an explicit retention policy.
