#!/bin/sh
set -e
# Ubuntu 24.04 restricts unprivileged user namespaces. Allow only this executable
# to use Chromium's user-namespace sandbox; never pass --no-sandbox.
if [ -d /etc/apparmor.d ]; then
    cat > /etc/apparmor.d/nute-notes <<'PROFILE'
abi <abi/4.0>,
include <tunables/global>
profile nute-notes "/opt/Nute Notes/nute-notes" flags=(unconfined) {
  userns,
}
PROFILE
    if command -v apparmor_parser >/dev/null 2>&1 && [ -d /sys/kernel/security/apparmor ]; then
        apparmor_parser -r /etc/apparmor.d/nute-notes
    fi
fi
update-desktop-database /usr/share/applications >/dev/null 2>&1 || true
