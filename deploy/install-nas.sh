#!/bin/sh
# Run once as root from the reviewed deploy bundle. Existing services are not changed.
set -eu
umask 077
PATH=/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:/usr/syno/bin
export PATH
[ "$(id -u)" -eq 0 ] || exit 77
base=/volume1/work-automation
source=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
[ ! -e "$base" ] || { printf 'Installation already exists; use the upgrade runbook.\n' >&2; exit 73; }
mkdir -m 755 "$base"
# This path is outside shared folders with inherited, writable DSM ACLs.
if command -v synoacltool >/dev/null 2>&1; then synoacltool -del "$base" 2>/dev/null || true; fi
chmod 755 "$base"
mkdir -m 755 "$base/bin" "$base/acme"
mkdir -m 700 "$base/data" "$base/secrets" "$base/tls" "$base/certbot-lib" "$base/certbot-logs" "$base/backups"
chown 1000:1000 "$base/data" "$base/secrets"
openssl rand -base64 32 > "$base/secrets/master-key"
openssl rand -hex 32 > "$base/secrets/setup-token"
chown 1000:1000 "$base/secrets/master-key" "$base/secrets/setup-token"
chmod 400 "$base/secrets/master-key" "$base/secrets/setup-token"
cp "$source/compose.yml" "$base/compose.yml"
cp "$source/deploy.sh" "$source/poll-deploy.sh" "$source/renew-tls.sh" "$base/bin/"
chmod 755 "$base/bin/"*.sh
cp "$source/nginx-bootstrap.conf" /usr/local/etc/nginx/sites-enabled/work-automation.conf
if ! nginx -t; then
    rm /usr/local/etc/nginx/sites-enabled/work-automation.conf
    exit 1
fi
nginx -s reload
printf 'Fresh data directory, protected secrets and HTTP challenge host prepared.\n'
printf 'Install TLS, then run install-renewal.sh and install-polling.sh.\n'
