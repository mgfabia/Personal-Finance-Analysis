#!/usr/bin/env bash
#
# Nightly Postgres backup — pg_dump to a timestamped file, then push off-Railway.
# A finance app owns its own backups: Railway's disk is NOT a backup. This is
# wired early so durability exists before any real data lands.
#
# Requires: pg_dump (postgresql-client), DATABASE_URL in the environment.
# Off-Railway upload is intentionally a hook (UPLOAD_CMD) — fill in YOUR storage
# (S3 / Backblaze B2 / rclone remote / etc.); that destination + its creds are
# yours to provide.
#
# Encryption (AGE_RECIPIENT, strongly recommended for prod): when set, the dump
# is encrypted to that age public key before upload and the plaintext is
# deleted. Asymmetric on purpose — the env can only *encrypt*; the private key
# (which decrypts) lives offline in the password manager, so a leaked bucket,
# storage token, or full Railway env yields ciphertext only. Restore: fetch the
# newest .age object, decrypt with the offline private key
# (`age --decrypt -i key.txt -o pf.dump pf_<TS>.dump.age`), then
# `pg_restore --clean --if-exists --no-owner -d "$DATABASE_URL" pf.dump`.
#
# Run manually:        DATABASE_URL=... ./scripts/backup.sh
# Schedule (prod):     Railway cron service (scripts/backup.Dockerfile), daily.

set -euo pipefail

: "${DATABASE_URL:?DATABASE_URL must be set}"

BACKUP_DIR="${BACKUP_DIR:-/tmp/pf-backups}"
RETAIN_DAYS="${RETAIN_DAYS:-14}"
TS="$(date -u +%Y%m%dT%H%M%SZ)"
OUT="${BACKUP_DIR}/pf_${TS}.dump"

mkdir -p "$BACKUP_DIR"

echo "[backup] dumping database -> ${OUT}"
# Custom format (-Fc) = compressed, restorable with pg_restore.
pg_dump --format=custom --no-owner --no-privileges --dbname="$DATABASE_URL" --file="$OUT"
echo "[backup] dump complete ($(du -h "$OUT" | cut -f1))"

# --- Encrypt before upload (AGE_RECIPIENT = age public key) -------------------
if [[ -n "${AGE_RECIPIENT:-}" ]]; then
  echo "[backup] encrypting to age recipient"
  age --encrypt --recipient "$AGE_RECIPIENT" --output "${OUT}.age" "$OUT"
  rm "$OUT"                     # plaintext never leaves this container
  OUT="${OUT}.age"
elif [[ -n "${UPLOAD_CMD:-}" ]]; then
  echo "[backup] WARNING: AGE_RECIPIENT not set — uploading an UNENCRYPTED dump." >&2
fi

# --- Off-Railway upload (REQUIRED in prod — fill this in) --------------------
# Set UPLOAD_CMD to a command that takes the dump path as $1. Examples:
#   aws s3 cp "$1" s3://my-bucket/pf-backups/
#   rclone copy "$1" b2:my-bucket/pf-backups/
if [[ -n "${UPLOAD_CMD:-}" ]]; then
  echo "[backup] uploading off-Railway"
  bash -c "$UPLOAD_CMD" _ "$OUT"
  echo "[backup] upload complete"
else
  echo "[backup] WARNING: UPLOAD_CMD not set — backup stayed local at ${OUT}." >&2
  echo "[backup]          Set UPLOAD_CMD before relying on this in production." >&2
fi

# --- Local retention (matters for on-host runs; cron containers are ephemeral) --
find "$BACKUP_DIR" -name 'pf_*.dump*' -type f -mtime +"$RETAIN_DAYS" -delete || true
echo "[backup] done"
