#!/bin/sh
# Scheduled PostgreSQL backups for the opt-in "backup" compose profile.
#
#   pg_backup.sh once   take one verified dump, apply retention and exit
#   pg_backup.sh        the same every BACKUP_INTERVAL_SECONDS (the default)
#
# The connection comes from the libpq environment (PGHOST, PGUSER, PGPASSWORD,
# PGDATABASE). Each run writes a custom-format dump to BACKUP_DIR as
# openbib-<UTC timestamp>.dump, or as .dump.enc when BACKUP_ENCRYPTION_KEY_FILE
# is set, through a .partial file that is renamed only after pg_restore could
# read it back. Logs carry file names, sizes and counts only. Restore steps and
# the matching decryption command: docs/Operations/Backups.md.

set -u
umask 077

BACKUP_DIR=${BACKUP_DIR:-/backups}
BACKUP_INTERVAL_SECONDS=${BACKUP_INTERVAL_SECONDS:-86400}
BACKUP_RETRY_SECONDS=${BACKUP_RETRY_SECONDS:-300}
BACKUP_RETENTION_DAYS=${BACKUP_RETENTION_DAYS:-30}
BACKUP_ENCRYPTION_KEY_FILE=${BACKUP_ENCRYPTION_KEY_FILE:-}
BACKUP_REQUIRE_ENCRYPTION=${BACKUP_REQUIRE_ENCRYPTION:-false}

tmp=""
sleep_pid=""

log() {
    printf '%s pg_backup: %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"
}

die() {
    log "error: $*"
    exit 2
}

# Restores must pass exactly these options (plus -d): keep them in sync with
# the decryption command in docs/Operations/Backups.md.
cipher() {
    openssl enc -aes-256-cbc -md sha256 -pbkdf2 -iter 100000 \
        -pass "file:$BACKUP_ENCRYPTION_KEY_FILE" "$@"
}

positive() {
    case $2 in
        '' | *[!0-9]*) die "$1 must be a positive integer" ;;
    esac
    [ "$2" -gt 0 ] || die "$1 must be a positive integer"
}

check_config() {
    positive BACKUP_INTERVAL_SECONDS "$BACKUP_INTERVAL_SECONDS"
    positive BACKUP_RETRY_SECONDS "$BACKUP_RETRY_SECONDS"
    positive BACKUP_RETENTION_DAYS "$BACKUP_RETENTION_DAYS"
    case $BACKUP_REQUIRE_ENCRYPTION in
        true | false) ;;
        *) die "BACKUP_REQUIRE_ENCRYPTION must be true or false" ;;
    esac
    [ -d "$BACKUP_DIR" ] && [ -w "$BACKUP_DIR" ] || die "$BACKUP_DIR is not a writable directory"
    if [ -z "$BACKUP_ENCRYPTION_KEY_FILE" ]; then
        [ "$BACKUP_REQUIRE_ENCRYPTION" = false ] ||
            die "BACKUP_REQUIRE_ENCRYPTION=true but BACKUP_ENCRYPTION_KEY_FILE is not set; refusing to write unencrypted dumps"
        return 0
    fi
    # A configured key never falls back to plaintext, whatever REQUIRE says.
    [ -r "$BACKUP_ENCRYPTION_KEY_FILE" ] || die "the encryption key file is missing or unreadable"
    key_length=$(($(head -n 1 "$BACKUP_ENCRYPTION_KEY_FILE" | tr -d '\r\n' | wc -c)))
    [ "$key_length" -ge 32 ] || die "the encryption key must be at least 32 characters on its first line"
    if ! command -v openssl >/dev/null 2>&1 && command -v apk >/dev/null 2>&1; then
        # postgres:16-alpine ships without the openssl CLI.
        log "installing the openssl CLI with apk"
        apk add --no-cache --quiet openssl >/dev/null 2>&1
    fi
    command -v openssl >/dev/null 2>&1 || die "openssl is not available; refusing to write unencrypted dumps"
}

backup() {
    stamp=$(date -u +%Y%m%dT%H%M%SZ)
    final="$BACKUP_DIR/openbib-$stamp.dump"
    [ -z "$BACKUP_ENCRYPTION_KEY_FILE" ] || final="$final.enc"
    tmp="$final.partial"
    list=$(mktemp) || return 1
    if [ -z "$BACKUP_ENCRYPTION_KEY_FILE" ]; then
        pg_dump --no-password -Fc -f "$tmp" &&
            pg_restore --list "$tmp" >"$list"
        rc=$?
    else
        # Stream pg_dump into openssl so no plaintext copy is written; the
        # status file carries pg_dump's exit code out of the pipeline.
        status=$(mktemp) || { rm -f "$list"; return 1; }
        { pg_dump --no-password -Fc; echo $? >"$status"; } | cipher -out "$tmp"
        rc=$?
        [ "$(cat "$status")" = 0 ] || rc=1
        rm -f "$status"
        if [ "$rc" -eq 0 ]; then
            cipher -d -in "$tmp" | pg_restore --list >"$list"
            rc=$?
        fi
    fi
    entries=$(grep -c '^[0-9]' "$list")
    # A readable archive of the wrong or an unmigrated database is no backup.
    if [ "$rc" -eq 0 ] && ! grep -Eq ' TABLE DATA public alembic_version( |$)' "$list"; then
        log "error: the dump holds no alembic_version data; is PGDATABASE the application database?"
        rc=1
    fi
    rm -f "$list"
    if [ "$rc" -ne 0 ]; then
        rm -f "$tmp"
        tmp=""
        log "error: backup failed; no dump written"
        return 1
    fi
    mv "$tmp" "$final" || return 1
    tmp=""
    log "created ${final##*/}: $(($(wc -c <"$final"))) bytes, $entries archive entries"
}

prune() {
    # find -mtime +N matches files at least N+1 whole days old.
    deleted=$(find "$BACKUP_DIR" -maxdepth 1 -type f -name 'openbib-*.dump*' \
        -mtime "+$BACKUP_RETENTION_DAYS" -print -delete | wc -l)
    kept=$(find "$BACKUP_DIR" -maxdepth 1 -type f \
        \( -name 'openbib-*.dump' -o -name 'openbib-*.dump.enc' \) | wc -l)
    log "retention ${BACKUP_RETENTION_DAYS} days: deleted $((deleted)), kept $((kept))"
}

run_once() {
    backup
    rc=$?
    # Retention is a privacy commitment, so it also runs after a failed dump.
    prune
    return "$rc"
}

stop() {
    [ -z "$sleep_pid" ] || kill "$sleep_pid" 2>/dev/null
    [ -z "$tmp" ] || rm -f "$tmp"
    log "stopped"
    exit 143
}

mode=${1:-loop}
case $mode in
    once | loop) ;;
    *) die "usage: pg_backup.sh [once|loop]" ;;
esac
check_config
trap stop TERM INT HUP
encryption=off
[ -z "$BACKUP_ENCRYPTION_KEY_FILE" ] || encryption=on
if [ "$mode" = once ]; then
    log "single run: retention $BACKUP_RETENTION_DAYS days, encryption $encryption"
    run_once
    exit $?
fi

log "starting: every $BACKUP_INTERVAL_SECONDS s, retention $BACKUP_RETENTION_DAYS days, encryption $encryption"
while :; do
    delay=$BACKUP_INTERVAL_SECONDS
    if ! run_once && [ "$BACKUP_RETRY_SECONDS" -lt "$delay" ]; then
        delay=$BACKUP_RETRY_SECONDS
        log "retrying in $delay s"
    fi
    sleep "$delay" &
    sleep_pid=$!
    wait "$sleep_pid"
    sleep_pid=""
done
