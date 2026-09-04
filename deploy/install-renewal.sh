#!/bin/sh
set -eu
[ "$(id -u)" -eq 0 ] || exit 77
base=/volume1/work-automation
[ -x "$base/bin/renew-tls.sh" ]
[ -f "$base/tls/live/work.pelmon.kro.kr/fullchain.pem" ]
if ! grep -Fq "$base/bin/renew-tls.sh" /etc/crontab; then
    cp -p /etc/crontab "$base/backups/crontab.before-worklog"
    printf '\n# work-automation independent TLS renewal\n21 3,15 * * * root /volume1/work-automation/bin/renew-tls.sh >> /volume1/work-automation/certbot-logs/renewal.log 2>&1\n' >> /etc/crontab
fi
printf 'Renewal is scheduled at 03:21 and 15:21 NAS local time.\n'
