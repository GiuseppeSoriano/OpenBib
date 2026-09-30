# Database backups and restore

PostgreSQL holds every piece of user data (the `pgdata` volume). Redis is a
rebuildable cache and needs no backup ([Redis](#redis-memory-limits)).

The compose file ships an opt-in `backup` profile: a `postgres:16-alpine`
container that runs [`tools/backup/pg_backup.sh`](../../tools/backup/pg_backup.sh)
to take a verified `pg_dump` into the local `pgbackups` volume on a schedule and
delete old dumps. On its own that is a local copy on the same host: it covers
operator mistakes and bad upgrades, not the loss of the host or its disk. What
the privacy notice may say about backups is a separate switch, described in
[Legal consistency](#legal-consistency-backups_enabled).

## Enabling the profile

```sh
docker compose --profile backup up -d backup                 # one dump now, then every 24 h
docker compose --profile backup run --rm backup once         # a single dump, then exit
docker compose --profile backup run --rm --entrypoint ls backup -l /backups
docker compose logs backup
```

Each run:

1. writes `pg_dump -Fc` to `openbib-<UTC timestamp>.dump.partial` (or
   `.dump.enc.partial`, see [Encryption](#encryption));
2. reads the archive back with `pg_restore --list` and renames it to
   `openbib-<UTC timestamp>.dump` (`.dump.enc`) only when that succeeds and
   the archive holds the `alembic_version` table data (the schema revision),
   so a file without `.partial` is always a complete, readable archive of a
   migrated OpenBib database;
3. deletes `openbib-*.dump*` files older than the retention period, including
   `.partial` leftovers of interrupted runs; this also happens after a failed
   dump, because the retention period is a privacy commitment.

Dumps are written with mode `0600`. The log shows file names, sizes and counts
only, for example:

```
2026-09-30T00:22:42Z pg_backup: created openbib-20260930T002241Z.dump: 56194 bytes, 113 archive entries
2026-09-30T00:22:42Z pg_backup: retention 30 days: deleted 2, kept 3
```

Settings come from the shell or from the project `.env` through compose
interpolation (the API ignores these names):

| Variable | Default | Meaning |
|---|---|---|
| `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB` | `openbib` | Passed as `PGUSER`, `PGPASSWORD`, `PGDATABASE`; must name the user and database in the API's `DATABASE_URL`. When an override file changes `DATABASE_URL`, set `PGDATABASE` (and `PGUSER`, `PGPASSWORD`) for the `backup` service in the same override |
| `BACKUP_INTERVAL_SECONDS` | `86400` | Time between runs in loop mode |
| `BACKUP_RETENTION_DAYS` | `30` | Retention, see below |
| `BACKUP_ENCRYPTION_KEY_FILE` | empty | Key file path inside the container; empty means unencrypted dumps |
| `BACKUP_REQUIRE_ENCRYPTION` | `false` | `true` refuses to start without a key file |
| `BACKUP_RETRY_SECONDS` | `300` | Loop mode: delay before retrying a failed dump (capped by the interval); script default, add it to the service environment to change it |

`once` exits with 0 after a verified dump, 1 when the dump failed or holds no
`alembic_version` data, which means a wrong or unmigrated database (no file is
kept either way), and 2 when the configuration is refused. In loop mode a failed dump is
logged as `error: backup failed; no dump written` and retried; a refused
configuration exits with 2 and Docker keeps restarting the container, which
`docker compose ps` shows as `Restarting`. Watch for `error:` lines and for the
age of the newest dump.

**Retention semantics.** The script runs `find -mtime +N`, which matches files
at least N+1 whole days old, and it only runs once per interval. With the daily
default a local dump therefore lives up to about N+2 days: 32 days with the
default of 30. Set `BACKUP_RETENTION_DAYS=28` whenever the privacy notice
promises "at most 30 days".

## Encryption

Configure a key file and dumps become `openbib-<timestamp>.dump.enc`:
`pg_dump` is piped straight into
`openssl enc -aes-256-cbc -md sha256 -pbkdf2 -iter 100000 -pass file:<key file>`,
so no plaintext copy is written, and the result is verified by decrypting it
into `pg_restore --list`. Once a key file is configured the script never falls
back to plaintext: a missing or unreadable key file, a key shorter than 32
characters on its first line or a missing `openssl` stops it with exit code 2.
With `BACKUP_REQUIRE_ENCRYPTION=true` it also refuses to start without a key
file:

```
pg_backup: error: BACKUP_REQUIRE_ENCRYPTION=true but BACKUP_ENCRYPTION_KEY_FILE is not set; refusing to write unencrypted dumps
```

**`openssl` is not part of `postgres:16-alpine`** (`docker run --rm
postgres:16-alpine which openssl` prints nothing and exits with 1). When a key
file is configured the script installs it at start-up with
`apk add --no-cache openssl`, which needs outbound access to the Alpine package
mirror each time the container starts. On hosts without that access, build a
derived image (`FROM postgres:16-alpine` plus `RUN apk add --no-cache openssl`)
and set it as the service `image` in the override file.

Create the key once and keep a copy somewhere other than the backups; without
it the encrypted dumps cannot be restored:

```sh
sudo install -d -m 700 /etc/openbib
openssl rand -base64 32 | sudo tee /etc/openbib/backup.key >/dev/null
sudo chmod 600 /etc/openbib/backup.key
```

Then mount it through `docker-compose.override.yml`, next to `docker-compose.yml`:

```yaml
services:
  backup:
    volumes:
      - /etc/openbib/backup.key:/run/secrets/backup_key:ro
    environment:
      BACKUP_ENCRYPTION_KEY_FILE: /run/secrets/backup_key
      BACKUP_REQUIRE_ENCRYPTION: "true"
      BACKUP_RETENTION_DAYS: "28"
```

AES-CBC carries no integrity tag: the verification proves that the key and
the archive structure are right, not that a stored copy was left untouched.
Keep off-host copies in access-controlled storage.

## Off-host copies

The profile never uploads anything. Ship only `.dump.enc` files, from a daily
host job that runs soon after the dump. The volume is
`<compose project>_pgbackups`, `openbib_pgbackups` by default. This stages the
dumps of the last two days and empties the staging directory of older ones:

```sh
docker run --rm -v openbib_pgbackups:/backups:ro -v /srv/openbib-offsite:/out \
  postgres:16-alpine sh -c '
    find /backups -maxdepth 1 -name "openbib-*.dump.enc" -mtime -2 -exec cp -p {} /out/ \; &&
    find /out -maxdepth 1 -name "openbib-*.dump.enc" -mtime +1 -delete'
```

Then upload the staging directory with a tool that skips files already
uploaded, such as `rclone copy` or `aws s3 sync` (without `--delete`). Never
re-upload every file with a loop of `aws s3 cp`: each upload restarts the
object's age.

Expire the off-host copies after **at most 28 days**, with versioning off so
that expired copies are really gone (see [Privacy operations](../Privacy.md)).
An S3 lifecycle rule counts from the upload, not from the dump, rounds up to
the next midnight UTC and removes objects asynchronously, so a 30-day rule
keeps every copy for more than 30 days. Never store the key next to the dumps.

## Legal consistency (`BACKUPS_ENABLED`)

The privacy notice follows the runtime flags and the operator's `legal.json`.
With `backups_enabled: true` it tells users that the instance "creates
encrypted backups, retained for at most 30 days" and that deletions leave an
encrypted receipt outside the database; with `false` it says that the instance
does not create new backups. In production the API refuses to start when
`BACKUPS_ENABLED` / `DELETION_JOURNAL_ENABLED` differ from `backups_enabled` /
`deletion_journal_enabled` in `legal.json`, and `legal.json` requires
`retention.backups_days` to be 30 when backups are enabled and 0 otherwise.

Starting the profile changes none of these flags, and the local profile alone
does not make `BACKUPS_ENABLED=true` truthful. Set it only when all of the
following hold:

1. dumps are encrypted, with `BACKUP_REQUIRE_ENCRYPTION=true`;
2. encrypted copies are shipped off the host;
3. no copy (local, staging or off-host) outlives 30 days:
   `BACKUP_RETENTION_DAYS=28` locally, staging emptied after two days and an
   off-host expiry of at most 28 days from a same-day upload;
4. the deletion journal is on (`DELETION_JOURNAL_ENABLED=true`,
   `DELETION_JOURNAL_BUCKET`, the S3 credentials and an HTTPS
   `S3_ENDPOINT_URL` when not on AWS), so that a restore can replay account
   deletions ([step 4](#restore-runbook)).

Then change everything in one deployment:

- `.env`: `BACKUPS_ENABLED=true` and `DELETION_JOURNAL_ENABLED=true`;
- `legal.json`: merge in the keys below, keeping your other `retention` fields,
  and bump `privacy_version` (and `effective_date`) because the notice changes;
- have the new notice reviewed, as [Privacy operations](../Privacy.md) requires.

```json
{
  "privacy_version": "2026-10-01",
  "effective_date": "2026-10-01",
  "backups_enabled": true,
  "deletion_journal_enabled": true,
  "retention": { "backups_days": 30 }
}
```

With `BACKUPS_ENABLED=false` (the `.env.example` default) the notice tells
users that no backups are kept, so do not run the scheduled profile in
production. A [pre-deploy dump](#before-deploying-migration-1d2e3f4a5b6c) is a
short-lived operational copy: delete it as soon as the upgrade is verified.
When stopping backups later, keep the journal enabled while older copies
remain, as [Privacy operations](../Privacy.md) describes.

## Restore runbook

Tested end to end on 2026-09-30 (see [Last drill](#last-drill)). The commands
assume the default compose project and credentials; replace `<dump>` with a
file name from the `/backups` listing, and adapt `openbib:openbib` and the live
database name `openbib` (steps 6 and 7) when your `DATABASE_URL` differs.
Restore into a new database and switch over only when it checks out; the
damaged database stays untouched until then.

Only restore a dump younger than 30 days: the deletion replay in step 4
cannot cover older gaps (see there).

0. **Real incident:** stop the writers and the backup loop first, so that
   retention cannot delete the dump you need,
   `docker compose stop api mail-worker backup`. **Drill:** leave everything
   running and use a scratch name such as `openbib_restore_check`.

1. Create the restore target:

   ```sh
   docker compose --profile backup run --rm --entrypoint createdb backup openbib_restore
   ```

2. Load the dump. `--single-transaction` makes a failed restore leave the
   target empty.

   ```sh
   # plain dump
   docker compose --profile backup run --rm --entrypoint pg_restore backup \
     --no-owner --single-transaction -d openbib_restore /backups/<dump>

   # encrypted dump: same key file, same cipher options as pg_backup.sh
   docker compose --profile backup run --rm \
     -v /etc/openbib/backup.key:/run/secrets/backup_key:ro --entrypoint sh backup -c \
     'apk add --no-cache --quiet openssl &&
      openssl enc -d -aes-256-cbc -md sha256 -pbkdf2 -iter 100000 \
        -pass file:/run/secrets/backup_key -in /backups/<dump> |
      pg_restore --no-owner --single-transaction -d openbib_restore'
   ```

   A wrong key fails with `bad decrypt` and `pg_restore: error: input file
   does not appear to be a valid archive`, and nothing is loaded. Check the
   revision the dump carries:

   ```sh
   docker compose exec -T db psql -U openbib -d openbib_restore -Atc "SELECT version_num FROM alembic_version"
   ```

3. Bring the schema up to the release you will run. The `migrate` service runs
   `alembic upgrade head`; nothing happens when the dump is already at head.
   **Skip this step when the restore is a rollback** to an earlier release
   ([below](#before-deploying-migration-1d2e3f4a5b6c)).

   ```sh
   docker compose run --rm \
     -e DATABASE_URL=postgresql+asyncpg://openbib:openbib@db:5432/openbib_restore \
     -e DATABASE_URL_FILE= migrate
   ```

   Always clear `DATABASE_URL_FILE` as shown: when it is set it wins over
   `DATABASE_URL`, and the command would then migrate the live database.

4. **Deletion journal enabled:** replay the account deletions made after the
   dump, first as a dry run, then for real. The same `-e` pair keeps it on the
   restore target; the journal settings, S3 credentials and
   `APP_ENCRYPTION_KEYS` come from `.env`.

   ```sh
   docker compose run --rm \
     -e DATABASE_URL=postgresql+asyncpg://openbib:openbib@db:5432/openbib_restore \
     -e DATABASE_URL_FILE= migrate python -m scripts.replay_deletions
   # Deletion receipts matched: 1; applied=False
   docker compose run --rm \
     -e DATABASE_URL=postgresql+asyncpg://openbib:openbib@db:5432/openbib_restore \
     -e DATABASE_URL_FILE= migrate python -m scripts.replay_deletions --apply
   # Deletion receipts matched: 1; applied=True
   ```

   Running the dry run again must report `matched: 0`. Receipts expire 30
   days after each deletion and the replay skips expired ones, so it cannot
   cover deletions made more than 30 days ago: in a dump older than that,
   the accounts deleted between the dump and that cut-off come back. With the
   journal disabled the script stops with `RuntimeError: Deletion journal is
   disabled; safe backup replay is unavailable`: accounts deleted after the
   dump come back and have to be deleted again from your data-rights records.

5. Before reopening, on the restore target:

   ```sh
   docker compose exec -T db psql -U openbib -d openbib_restore \
     -c "UPDATE auth_sessions SET revoked_at = now() WHERE revoked_at IS NULL" \
     -c "UPDATE user_action_tokens SET used_at = now() WHERE used_at IS NULL" \
     -c "UPDATE registration_challenges SET used_at = now() WHERE used_at IS NULL" \
     -c "SELECT count(*) AS read_links FROM collections WHERE read_link_digest IS NOT NULL" \
     -c "SELECT count(*) AS pending_mail FROM email_outbox WHERE sent_at IS NULL AND failed_at IS NULL"
   ```

   Revoking every session forces a new sign-in; otherwise sessions revoked
   after the dump (logout everywhere, password change) would work again. For
   the same reason every one-time token is spent: password-reset and
   email-change links and registration codes used after the dump would be
   valid again, so users request new ones.

   Collection sharing also goes back to the dump: read links disabled or
   rotated after it work again, and removed members and editors regain
   access. Ask collection owners to review their sharing. When the incident
   requires it (a leaked link, say), disable every read link:
   `UPDATE collections SET read_link_digest = NULL, read_link_ciphertext = NULL, read_link_nonce = NULL, read_link_key_version = NULL WHERE read_link_digest IS NOT NULL`.

   Messages still pending in the dump are sent again when `mail-worker` starts;
   their codes and links have usually expired, so discard them with
   `UPDATE email_outbox SET failed_at = now(), last_error = 'discarded after restore', payload_ciphertext = NULL, payload_nonce = NULL WHERE sent_at IS NULL AND failed_at IS NULL`
   if needed. Tell users that changes made after the dump time are lost,
   including password changes.

6. Compare row counts. Save this query as `counts.sql`; it counts every table
   exactly:

   ```sql
   SELECT table_name,
          (xpath('/row/n/text()',
                 query_to_xml(format('SELECT count(*) AS n FROM public.%I', table_name),
                              false, true, '')))[1]::text::bigint AS row_count
   FROM information_schema.tables
   WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
   ORDER BY table_name;
   ```

   ```sh
   for db in openbib openbib_restore; do
     docker compose exec -T db psql -U openbib -d "$db" -At -F ' ' < counts.sql > "counts-$db.txt"
   done
   diff counts-openbib.txt counts-openbib_restore.txt && echo "row counts match"
   ```

   In a drill the live database is the reference: the counts match, apart
   from writes made since the dump. Each replayed account removes its user
   row and dependent rows (its collections without other members are deleted,
   shared ones pass to the next member) and adds one
   `account_deletion_tombstones` row, exactly as the original deletion did in
   the live database. In a real incident compare with the last known figures,
   and check that the number of entries in `pg_restore --list` matches the
   "archive entries" the backup log reported.

7. Switch over. Nothing may be connected to either database while it is
   renamed, so stop every service that uses it:

   ```sh
   docker compose stop api mail-worker web backup
   docker compose exec -T db psql -U openbib -d postgres \
     -c 'ALTER DATABASE openbib RENAME TO openbib_before_restore' \
     -c 'ALTER DATABASE openbib_restore RENAME TO openbib'
   docker compose up -d
   ```

   Restart the profile with `docker compose --profile backup up -d backup` if
   it was running. `openbib_before_restore` still holds personal data: drop it
   (`DROP DATABASE openbib_before_restore`) as soon as it is no longer needed
   for the investigation. Redis needs no action: it only holds rebuildable
   caches and rate-limit windows.

## Before deploying migration 1d2e3f4a5b6c

This release's migration `1d2e3f4a5b6c` rewrites legacy paper keys (bare
DOIs, `DOI:` labels, doi.org links) to the `doi:` form and merges the
duplicates this creates. It cannot be undone: its downgrade is a no-op, and the
only way back is a dump taken just before the upgrade.

```sh
docker compose build                                   # the new release
docker compose stop api mail-worker                    # no writes after the dump
docker compose run --rm migrate python -m scripts.repair_paper_keys --dry-run
docker compose --profile backup run --rm backup once   # note the file name it logs
docker compose up -d                                   # migrate runs alembic upgrade head first
```

Run the dry run through `migrate` as shown: `docker compose run api …` would
start `migrate` first and apply the migration before the preview. The dry run
prints per-table counts and up to 50 unrepairable keys; those keys can reveal
what users read, so do not paste the output into tickets or shared logs. Copy
the dump off the host if the instance keeps
encrypted off-host copies. On an instance that keeps no backups, delete it once
the upgrade is verified:

```sh
docker compose --profile backup run --rm --entrypoint rm backup /backups/<dump>
```

**Rolling back** means restoring that dump with the [runbook](#restore-runbook)
while **skipping step 3**: the check in step 2 shows the revision before the
upgrade (`f8a9b0c1d2e3` when coming from the previous release), which is what
the previous release expects. Replay deletions (step 4), switch over (step 7)
with the previous release's images, and accept that writes made after the
upgrade are lost.

## Redis memory limits

Redis holds only rebuildable data: provider responses, graph related-list
snapshots (`openbib:graph:related:*`, up to about 2.5 MB each, kept for the
references or citations cache TTL) and rate-limit windows. The bundled
`redis:7-alpine` service has no `maxmemory`, so snapshots can grow until the
host runs out of memory. Set a limit and let Redis evict the least recently
used keys among those with a TTL, which OpenBib gives every key it writes:

```yaml
# docker-compose.override.yml
services:
  cache:
    command: ["redis-server", "--maxmemory", "256mb", "--maxmemory-policy", "volatile-lru"]
```

```sh
docker compose up -d cache
docker compose exec cache redis-cli CONFIG GET maxmemory-policy   # volatile-lru
docker compose exec cache redis-cli INFO stats | grep evicted_keys
```

Size the limit for the snapshots you expect to be warm at once, with headroom.
Rate-limit windows can be evicted too, which briefly resets a window, so a
climbing `evicted_keys` means the limit is too small. If Redis ever runs out
of memory with nothing left to evict, writes fail and authentication, search,
graph and Zotero routes close, as described in
[Persistence](../Architecture/Persistence.md).

## Last drill

2026-09-30, PostgreSQL 16.13 (`postgres:16-alpine`), Docker Compose 2.29:
single and looped runs, retention of aged files, encrypted dumps and the
refusal paths, then steps 1 to 7 on scratch databases. The dump came from a
seeded database at `f8a9b0c1d2e3`, step 3 applied `1d2e3f4a5b6c`, and the
deletion journal was an S3-compatible test server. Row counts matched before
and after the replay. A second pass the same day covered the
`alembic_version` check (an unmigrated database is refused, plain and
encrypted), steps 1, 2, 5 and 6 with the one-time token and read-link
statements, and the off-host staging command with aged files.
