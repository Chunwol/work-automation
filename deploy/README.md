# NAS deployment

Production URL: https://work.pelmon.kro.kr

This is an independent service on Synology DSM. The initial database is empty;
PC accounts, schedules, credentials and screenshots are never uploaded.

## Layout and isolation

- `/volume1/work-automation`: root-owned deployment configuration.
- `data/worklog.db`: persistent SQLite database, container UID 1000.
- `secrets/master-key`: encryption key; losing it prevents credential recovery.
- `secrets/setup-token`: first-administrator setup token. General signup needs no token.
- `tls`, `acme`, `certbot-lib`, `certbot-logs`: independent TLS renewal state.
- `data/backups`: consistent SQLite snapshots before image replacement.
- `backups`: original NAS configuration retained for recovery.
- Container `work-automation`: non-root, read-only image, dropped capabilities,
  512 MB / one CPU limit, localhost-only port 3211. Native nginx terminates TLS.
This NAS kernel does not support CPU quota or PID-count cgroups. CPU affinity and
shares are used instead; the compose PID limit is best-effort and is not enforced here.

Back up the database **and** encryption key securely, separately from Git.
Do not copy an active SQLite database without its WAL: use SQLite's backup API.
Backups are not a substitute for an off-device backup and should be retained/pruned
according to the operator's policy.

## CI/CD

`main` push -> unit/API and synthetic browser tests -> production image smoke test
-> GHCR immutable digest -> NAS outbound pull -> health check -> exact revision over HTTPS.
The server never receives a school account during deployment or testing.

Repository variable: `NAS_DEPLOY_ENABLED=true` publishes the tested `latest` tag.
The production environment allows only `main`. Protect `main` when adding repository writers.

External CI cannot reach this NAS's SSH port. The NAS checks the public, source-only
GHCR image every two minutes instead. Anonymous pull access is required and must be
verified after creating or changing the package. No SSH port is exposed, no permanent
GitHub token is stored on the NAS, and CI has no NAS administration key.
The root-owned deploy script accepts only this repository's immutable image digest.
Run `install-polling.sh` after installing the scripts. `deployment.log` records errors.
Creating `/volume1/work-automation/.auto-deploy-paused` pauses the updater; removing
that file resumes it. Use this before a manual rollback or maintenance.
Kernel file locks prevent overlapping deployments and renewals, and are released
automatically when a process exits or the NAS restarts.
The next poll also clears a stale API maintenance pause left by an interrupted
deployment, but never while another deployment holds its exclusive lock.

Before replacement, new API writes are briefly paused and existing portal jobs must
finish. If work stays active, deployment is deferred without stopping the container.
CI waits for the exact commit reported by `/health`, not merely an HTTP 200 response.

Do not run `install-nas.sh` against an existing installation. It intentionally refuses
to replace an existing directory. Review it before first use and validate nginx before reload.

The application image is delivered automatically. Infrastructure files (`compose.yml`,
root-owned scripts, nginx configuration) require a reviewed administrator update;
CI does not rewrite host configuration.

## HTTPS

Point the `work` DNS record to the NAS. Install the HTTP challenge-only virtual host
first, obtain an independent certificate using the official Certbot image and webroot,
then install `nginx.conf` after `nginx -t` succeeds. Never change other virtual hosts.
The production certificate uses ZeroSSL ACME. Supply EAB credentials privately at
initial account registration, never in Git or CI logs. Certbot's root-only account
and renewal files retain the CA selection, so renewal needs no EAB key in the script.
Run `install-renewal.sh` once to schedule `bin/renew-tls.sh` at 03:21 and 15:21
(NAS local time). Certbot renews when due, before expiration, and retries on the next
scheduled run after a failure. nginx reloads only when the certificate changes.
Check `certbot-logs/renewal.log` and NAS system logs for failures.
DSM upgrades or reverse-proxy changes can regenerate nginx/cron configuration;
verify this custom host and its renewal job after such operations.

## Recovery

`current-image` records the last healthy digest. A failed replacement restores that
image, or stops only this new service if no prior image exists. Deployment failures
remain failed in Actions. The database is not automatically rolled back, to avoid
discarding user changes; any incompatible future schema change needs a migration
and recovery plan. An operator may pause polling and run `bin/deploy.sh sha256:...`
as root with a prior successful digest. No registry password is needed for this public image.

Keep the original `pelmon.kro.kr` service running. Never run global Docker cleanup,
modify another project's compose file, or expose port 3211 on all interfaces.
