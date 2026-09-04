#!/bin/sh
set -eu
umask 077
PATH=/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin
export PATH
[ "$(id -u)" -eq 0 ] || exit 77
base=/volume1/work-automation
repository=ghcr.io/chunwol/work-automation
cd "$base"
[ ! -f .auto-deploy-paused ] || exit 0
mkdir .poll-lock 2>/dev/null || exit 0
trap 'rmdir "$base/.poll-lock"' EXIT
mkdir -p registry-anonymous
export DOCKER_CONFIG="$base/registry-anonymous"
# Only this repository's tested main-branch images receive the latest tag.
docker pull --quiet "$repository:latest" >/dev/null
image=$(docker image inspect "$repository:latest" --format '{{index .RepoDigests 0}}')
case "$image" in "$repository@sha256:"*) ;; *) exit 64 ;; esac
if [ -f current-image ] && [ "$(cat current-image)" = "$image" ]; then exit 0; fi
exec_status=0
"$base/bin/deploy.sh" "${image#*@}" </dev/null || exec_status=$?
if [ "$exec_status" -ne 0 ]; then
    logger -t work-automation "Deployment postponed or failed; see deployment.log"
fi
exit "$exec_status"
