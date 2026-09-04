#!/bin/sh
# Run once as root from the reviewed deploy bundle. Existing services are not changed.
set -eu
umask 077
PATH=/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:/usr/syno/bin
export PATH
[ "$(id -u)" -eq 0 ] || exit 77
base=/volume1/work-automation
source=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
key=${1:?Pass the dedicated public-key file}
public_key=$(tr -d '\r' < "$key")
printf '%s\n' "$public_key" | grep -Eq '^ssh-ed25519 [A-Za-z0-9+/=]+ work-automation-ci$'
[ ! -e "$base" ] || { printf 'Installation already exists; use the upgrade runbook.\n' >&2; exit 73; }
mkdir -m 755 "$base"
# This path is outside shared folders with inherited, writable DSM ACLs.
if command -v synoacltool >/dev/null 2>&1; then synoacltool -del "$base" 2>/dev/null || true; fi
chmod 755 "$base"
mkdir -m 755 "$base/bin" "$base/ssh" "$base/acme"
mkdir -m 700 "$base/data" "$base/secrets" "$base/tls" "$base/certbot-lib" "$base/certbot-logs" "$base/backups"
chown 1000:1000 "$base/data" "$base/secrets"
openssl rand -base64 32 > "$base/secrets/master-key"
openssl rand -hex 32 > "$base/secrets/setup-token"
chown 1000:1000 "$base/secrets/master-key" "$base/secrets/setup-token"
chmod 400 "$base/secrets/master-key" "$base/secrets/setup-token"
cp "$source/compose.yml" "$base/compose.yml"
cp "$source/deploy.sh" "$source/ssh-gateway.sh" "$source/renew-tls.sh" "$base/bin/"
chmod 755 "$base/bin/"*.sh
printf 'command="%s/bin/ssh-gateway.sh",no-agent-forwarding,no-port-forwarding,no-X11-forwarding,no-pty %s\n' "$base" "$public_key" > "$base/ssh/authorized_keys"
chmod 644 "$base/ssh/authorized_keys"
cp -p /etc/ssh/sshd_config "$base/backups/sshd_config.before"
printf '\n# work-automation restricted deployment key\nMatch User dongyang\n    AuthorizedKeysFile /volume1/work-automation/ssh/authorized_keys\n' >> /etc/ssh/sshd_config
if ! sshd -t; then
    cp -p "$base/backups/sshd_config.before" /etc/ssh/sshd_config
    exit 1
fi
[ -d /etc/sudoers.d ]
printf 'dongyang ALL=(root) NOPASSWD: /volume1/work-automation/bin/deploy.sh\n' > /etc/sudoers.d/work-automation
chmod 440 /etc/sudoers.d/work-automation
cp "$source/nginx-bootstrap.conf" /usr/local/etc/nginx/sites-enabled/work-automation.conf
if ! nginx -t; then
    rm /usr/local/etc/nginx/sites-enabled/work-automation.conf
    exit 1
fi
nginx -s reload
printf 'Fresh data directory, protected secrets, SSH key and HTTP challenge host prepared.\n'
printf 'Validate sudoers and reload sshd, then test the restricted key before closing this session.\n'
