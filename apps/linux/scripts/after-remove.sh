#!/bin/sh
set -e
# Preserve all user profiles, offline queues and keyring entries.
if [ "$1" = remove ] || [ "$1" = purge ]; then
    if [ -f /etc/apparmor.d/nute-notes ]; then
        if command -v apparmor_parser >/dev/null 2>&1 && [ -d /sys/kernel/security/apparmor ]; then
            apparmor_parser -R /etc/apparmor.d/nute-notes || true
        fi
        rm -f /etc/apparmor.d/nute-notes
    fi
fi
update-desktop-database /usr/share/applications >/dev/null 2>&1 || true
