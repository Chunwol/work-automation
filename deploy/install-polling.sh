#!/bin/sh
set -eu
[ "$(id -u)" -eq 0 ] || exit 77
base=/volume1/work-automation
[ -x "$base/bin/poll-deploy.sh" ]
if ! grep -Fq "$base/bin/poll-deploy.sh" /etc/crontab; then
    cp -p /etc/crontab "$base/backups/crontab.before-polling"
    printf '\n# work-automation pulls verified images; no inbound SSH from CI\n*/2 * * * * root /volume1/work-automation/bin/poll-deploy.sh >> /volume1/work-automation/deployment.log 2>&1\n' >> /etc/crontab
fi
printf 'Image updates are checked every two minutes.\n'
