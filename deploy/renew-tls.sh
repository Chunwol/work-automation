#!/bin/sh
set -eu
PATH=/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin
export PATH
base=/volume1/work-automation
docker run --rm --name work-automation-cert-renew --memory 256m --cpuset-cpus 0 --cpu-shares 128 \
    -v "$base/tls:/etc/letsencrypt" \
    -v "$base/acme:/var/www/acme" \
    -v "$base/certbot-lib:/var/lib/letsencrypt" \
    -v "$base/certbot-logs:/var/log/letsencrypt" \
    certbot/certbot:v5.8.0 renew --quiet --webroot -w /var/www/acme
nginx -t
nginx -s reload
