#!/bin/sh
set -eu
umask 077
PATH=/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin
export PATH

[ "$(id -u)" -eq 0 ] || exit 77
base=/volume1/work-automation
digest=${1:-}
hash=${digest#sha256:}
case "$hash" in *[!a-f0-9]*) exit 64 ;; esac
[ "$digest" != "$hash" ] && [ "${#hash}" -eq 64 ] || exit 64
image="ghcr.io/chunwol/work-automation@$digest"
cd "$base"
mkdir .deploy-lock || { printf 'A deployment is already running.\n' >&2; exit 75; }
registry=''
cleanup() {
    rm -f "$base/data/.deployment-pause"
    if [ -n "$registry" ]; then
        rm -f "$registry/config.json"
        rmdir "$registry" 2>/dev/null || true
    fi
    rmdir "$base/.deploy-lock"
}
trap cleanup EXIT
registry=$(mktemp -d "$base/.registry.XXXXXX")
export DOCKER_CONFIG="$registry"
docker pull "$image"

previous=''
if [ -f current-image ]; then previous=$(cat current-image); fi
if [ "$(docker inspect --format '{{.State.Running}}' work-automation 2>/dev/null || true)" = true ]; then
    touch "$base/data/.deployment-pause"
    idle=false
    for attempt in $(seq 1 60); do
        if docker exec work-automation node -e '
            fetch("http://127.0.0.1:3210/internal/deployment")
              .then(async r => { if (!r.ok || (await r.json()).busy) process.exit(1); })
              .catch(() => process.exit(1));'; then idle=true; break; fi
        sleep 2
    done
    if [ "$idle" != true ]; then
        printf 'Portal work is still running; keeping the current service.\n' >&2
        exit 75
    fi
    docker exec work-automation node -e '
        const fs = require("node:fs");
        const Database = require("better-sqlite3");
        fs.mkdirSync("/data/backups", { recursive: true, mode: 0o700 });
        const db = new Database("/data/worklog.db", { readonly: true });
        db.backup("/data/backups/pre-deploy-" + Date.now() + ".db")
          .then(() => db.close()).catch(error => { console.error(error.message); process.exit(1); });'
fi

export WORKLOG_IMAGE="$image"
healthy=false
if docker-compose -p work-automation -f compose.yml up -d --no-deps worklog; then
    for attempt in $(seq 1 60); do
        status=$(docker inspect --format '{{.State.Health.Status}}' work-automation 2>/dev/null || true)
        if [ "$status" = healthy ]; then healthy=true; break; fi
        sleep 2
    done
fi
if [ "$healthy" = true ]; then
    printf '%s\n' "$image" > current-image.next
    mv current-image.next current-image
    printf 'Healthy deployment: %s\n' "$image"
    exit 0
fi

if [ -n "$previous" ]; then
    export WORKLOG_IMAGE="$previous"
    docker-compose -p work-automation -f compose.yml up -d --no-deps worklog
    printf 'New image failed health checks; restored the previous image.\n' >&2
else
    docker-compose -p work-automation -f compose.yml stop worklog
    printf 'Initial image failed health checks; stopped only work-automation.\n' >&2
fi
exit 1
