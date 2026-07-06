# Backup cron service image — Railway builds this via scripts/railway.backup.json.
#
# A dedicated image (not the backend's Railpack build) because the job needs
# binaries a Python app image doesn't carry: pg_dump, rclone, age. Alpine keeps
# it tiny. postgresql16-client is pinned to the server's major version —
# pg_dump must be >= the server it dumps, and 16 == 16 by construction.
FROM alpine:3.20

RUN apk add --no-cache bash postgresql16-client rclone age

COPY scripts/backup.sh /usr/local/bin/backup.sh
RUN chmod +x /usr/local/bin/backup.sh

# Runs once per cron invocation and exits (restartPolicyType NEVER); a non-zero
# exit surfaces as a failed deploy in Railway, which is the alerting we have.
CMD ["bash", "/usr/local/bin/backup.sh"]
