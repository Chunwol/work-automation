#!/bin/sh
set -eu
umask 077
PATH=/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin
export PATH
[ "$(id -u)" -eq 0 ] || exit 77
base=/volume1/work-automation
exec 9> "$base/.renew.lock"
flock -n 9 || exit 0
trap 'status=$?; if [ "$status" -ne 0 ]; then logger -t work-automation "TLS renewal check failed (exit $status)"; fi' EXIT
printf '%s Checking certificate renewal.\n' "$(date -Iseconds)"
docker run --rm --name work-automation-cert-renew --memory 256m --cpuset-cpus 0 --cpu-shares 128 \
    -v "$base/tls:/etc/letsencrypt" \
    -v "$base/acme:/var/www/acme" \
    -v "$base/certbot-lib:/var/lib/letsencrypt" \
    -v "$base/certbot-logs:/var/log/letsencrypt" \
    certbot/certbot:v5.8.0 renew --quiet --cert-name work.pelmon.kro.kr --webroot -w /var/www/acme
certificate=$(sha256sum "$base/tls/live/work.pelmon.kro.kr/fullchain.pem" | cut -d ' ' -f 1)
applied=$(cat "$base/tls/applied-certificate" 2>/dev/null || true)
if [ "$certificate" != "$applied" ]; then
    nginx -t
    nginx -s reload
    printf '%s\n' "$certificate" > "$base/tls/applied-certificate.next"
    mv "$base/tls/applied-certificate.next" "$base/tls/applied-certificate"
    printf '%s Certificate applied to nginx.\n' "$(date -Iseconds)"
fi
printf '%s Renewal check succeeded.\n' "$(date -Iseconds)"
