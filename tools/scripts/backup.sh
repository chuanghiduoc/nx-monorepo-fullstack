#!/bin/sh
# Takes a backup of everything a restore needs, and nothing else.
#
#   tools/scripts/backup.sh [destination]
#
# Two things come out: the database, and the objects the local storage driver
# holds. A deployment on S3 backs the bucket up where the bucket lives and drops
# the second half — which is why they are separate files rather than one archive
# that is half wrong.
#
# **`pg_dump`, not a file copy of the data directory.** A copy taken while the
# server is running is not a backup; it is a directory that sometimes restores.
# The trade is that this is slower and locks nothing, which is the right way
# round for a backup that runs while people are using the service.
set -eu

DESTINATION="${1:-./backups}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
COMPOSE="docker compose -f docker-compose.prod.yml --env-file .env.prod"

DUMP="${DESTINATION}/postgres-${STAMP}.dump"
OBJECTS="${DESTINATION}/storage-${STAMP}.tar.gz"

mkdir -p "${DESTINATION}"

echo "Backing up the database to ${DUMP}"
# The custom format, because it restores selectively and in parallel; plain SQL
# restores in one stream and cannot skip a table that will not load.
${COMPOSE} exec -T postgres pg_dump \
  --username "${POSTGRES_USER:-postgres}" \
  --dbname "${POSTGRES_DB:-app}" \
  --format custom \
  --no-owner \
  > "${DUMP}"

echo "Backing up the object store to ${OBJECTS}"
# From inside the container, because the volume is the container's. A tar of the
# host path would be empty on a machine where Docker keeps volumes in a VM.
#
# The path is inside `sh -c` rather than an argument of its own, and that is not
# style: Git Bash rewrites any argument that starts with `/` into a Windows
# path, so `-C /var/lib/app/storage` reached the container as
# `C:/Program Files/Git/var/lib/app/storage` and tar could not find it.
${COMPOSE} exec -T api sh -c 'cd /var/lib/app/storage && tar -czf - .' > "${OBJECTS}"

# What the age metric reads. Written last, and only on the way out, so the
# timestamp means "a backup finished" rather than "a backup started and may
# have failed" — which is the difference between an alert that fires and one
# that stays quiet while nothing is being backed up.
#
# On the queue's Redis rather than in a file: the API publishes
# `backup_age_seconds` and does not share a filesystem with wherever this runs.
# That instance is the one checked at boot for `noeviction`, so the key cannot
# be thrown away by a cache — a backup age that vanished would read as "no
# backup has ever run".
echo "${STAMP}" > "${DESTINATION}/last-backup"

COMPLETED_AT="$(date -u +%s)"

if ${COMPOSE} exec -T redis-critical redis-cli      SET app:backup:last-completed "${COMPLETED_AT}" > /dev/null 2>&1; then
  echo "Recorded the backup time for the age metric."
else
  # Not fatal: the backup exists, which is the point. But it is said out loud,
  # because a silent failure here means the alert that watches for backups
  # stopping is itself quietly not working.
  echo "WARNING: could not record the backup time in Redis; backup_age_seconds will not update." >&2
fi

echo "Done:"
ls -la "${DUMP}" "${OBJECTS}"
