# NAS deployment

Production URL: https://work.pelmon.kro.kr

This is an independent service on Synology DSM. The initial database is empty;
PC accounts, schedules, credentials and screenshots are never uploaded.

## Layout and isolation

- `/volume1/docker/work-automation`: root-owned deployment configuration.
- `data/worklog.db`: persistent SQLite database, container UID 1000.
- `secrets/master-key`: encryption key; losing it prevents credential recovery.
- `secrets/setup-token`: first-administrator setup token. General signup needs no token.
- `tls`, `acme`, `certbot-lib`, `certbot-logs`: independent TLS renewal state.
- `data/backups`: consistent SQLite snapshots before image replacement.
- `backups`: original NAS configuration retained for recovery.
- Container `work-automation`: non-root, read-only image, dropped capabilities,
  512 MB / one CPU limit, localhost-only port 3211. Native nginx terminates TLS.

Back up the database **and** encryption key securely, separately from Git.
Do not copy an active SQLite database without its WAL: use SQLite's backup API.
Backups are not a substitute for an off-device backup and should be retained/pruned
according to the operator's policy.

## CI/CD

`main` push -> unit/API and synthetic browser tests -> production image smoke test
-> GHCR immutable digest -> restricted SSH deployment -> health check -> public HTTPS.
The server never receives a school account during deployment or testing.

Repository variables: `NAS_HOST`, `NAS_USER`, `NAS_DEPLOY_ENABLED=true`.
Repository secrets: `NAS_DEPLOY_KEY`, `NAS_KNOWN_HOSTS` (verified host key, not blind keyscan).
Protect `main` and the `production` environment when adding repository writers.

The dedicated SSH key can execute only `ping` or `deploy sha256:<64 hex>`.
The root-owned deployment script accepts only this repository's image digest.
GHCR authentication uses the workflow's short-lived read-only token via SSH stdin;
its temporary Docker login file is removed when the command exits.
Admin SSH passwords, app encryption keys and the setup token are not GitHub secrets.

Do not run `install-nas.sh` against an existing installation. It intentionally refuses
to replace an existing directory. Review it before first use, retain an authenticated
administrator session, validate `sshd -t` and sudoers, reload SSH, and verify both
`ping` and denial of arbitrary commands with the new key.

The application image is delivered automatically. Infrastructure files (`compose.yml`,
root-owned scripts, nginx configuration) require a reviewed administrator update;
the restricted CI key cannot rewrite its own permissions or host configuration.

## HTTPS

Point the `work` DNS record to the NAS. Install the HTTP challenge-only virtual host
first, obtain an independent certificate using the official Certbot image and webroot,
then install `nginx.conf` after `nginx -t` succeeds. Never change other virtual hosts.
Run `bin/renew-tls.sh` twice daily from the NAS scheduler and monitor failures.
DSM upgrades or reverse-proxy changes can regenerate nginx/cron configuration;
verify this custom host and its renewal job after such operations.

## Recovery

`current-image` records the last healthy digest. A failed replacement restores that
image, or stops only this new service if no prior image exists. Deployment failures
remain failed in Actions. The database is not automatically rolled back, to avoid
discarding user changes; any incompatible future schema change needs a migration
and recovery plan. An operator may deploy a prior successful digest through the
same restricted command with a current read-only GHCR token.

Keep the original `pelmon.kro.kr` service running. Never run global Docker cleanup,
modify another project's compose file, or expose port 3211 on all interfaces.
