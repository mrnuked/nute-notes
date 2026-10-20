#!/usr/bin/env bash
set -Eeuo pipefail
# Invoked by certbot only after successful renewal; never rewrite other sites.
nginx -t
systemctl reload nginx
