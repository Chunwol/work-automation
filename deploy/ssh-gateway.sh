#!/bin/sh
set -eu

case "${SSH_ORIGINAL_COMMAND:-}" in
    ping)
        printf 'work-automation deployment gateway\n'
        ;;
    'deploy sha256:'*)
        digest=${SSH_ORIGINAL_COMMAND#deploy }
        hash=${digest#sha256:}
        case "$hash" in *[!a-f0-9]*) exit 64 ;; esac
        [ "${#hash}" -eq 64 ] || exit 64
        exec sudo -n /volume1/work-automation/bin/deploy.sh "$digest"
        ;;
    *)
        printf 'Only a work-automation image deployment is allowed.\n' >&2
        exit 64
        ;;
esac
