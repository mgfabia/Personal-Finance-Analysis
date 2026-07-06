# Backup cron service image — Railway builds this via scripts/railway.backup.json.
#
# Based on the official postgres alpine image so pg_dump matches the PROD server
# major version by construction (prod Railway Postgres is 18.x; pg_dump must be
# >= the server it dumps — 18 also dumps the local dev 16 fine, newer-client-
# older-server is supported). The first cron run against prod failed on exactly
# this: a hand-pinned postgresql16-client vs the 18.4 server. If prod Postgres
# is ever major-upgraded, bump this tag to match.
FROM postgres:18-alpine

RUN apk add --no-cache bash rclone age

COPY scripts/backup.sh /usr/local/bin/backup.sh
RUN chmod +x /usr/local/bin/backup.sh

# The postgres base image's entrypoint boots a database server; this service is
# a client-only cron job. Clear it so the container runs the backup and exits
# (restartPolicyType NEVER); a non-zero exit surfaces as a failed run in Railway.
ENTRYPOINT []
CMD ["bash", "/usr/local/bin/backup.sh"]
