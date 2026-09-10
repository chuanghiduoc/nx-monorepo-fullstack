#!/bin/sh
# Restores from a backup, and from nothing else.
#
#   tools/scripts/restore.sh <postgres dump> <storage archive>
#
# The point of this script is that it uses only what `backup.sh` produced. A
# restore that quietly needs the running system — a migration replayed from the
# repository, a role created by hand, an object still on a disk somewhere — is
# a restore that works in a drill and fails in an outage.
#
# It is destructive: the database is dropped and rebuilt. That is what a restore
# is, and pretending otherwise by merging into a live database is how a drill
# leaves a half-restored system nobody can reason about.
set -eu

DUMP="${1:?usage: restore.sh <postgres dump> <storage archive>}"
OBJECTS="${2:?usage: restore.sh <postgres dump> <storage archive>}"
COMPOSE="docker compose -f docker-compose.prod.yml --env-file .env.prod"
DB="${POSTGRES_DB:-app}"
OWNER="${POSTGRES_USER:-postgres}"

echo "Stopping everything that writes"
# The applications first: a restore into a database the API is still writing to
# is a race with a data loss on the other side of it.
${COMPOSE} stop api worker web edge

echo "Recreating the database"
${COMPOSE} exec -T postgres psql --username "${OWNER}" --dbname postgres \
  -c "DROP DATABASE IF EXISTS \"${DB}\" WITH (FORCE);"
${COMPOSE} exec -T postgres psql --username "${OWNER}" --dbname postgres \
  -c "CREATE DATABASE \"${DB}\";"

echo "Restoring ${DUMP}"
# `--no-owner` on the way in as well: the dump was taken that way, and the roles
# are created by the migration rather than by the dump.
${COMPOSE} exec -T postgres pg_restore \
  --username "${OWNER}" \
  --dbname "${DB}" \
  --no-owner \
  --exit-on-error \
  < "${DUMP}"

echo "Restoring ${OBJECTS}"
${COMPOSE} start api
# Waits for the container rather than for the application: the tar goes into the
# volume, and the volume is there as soon as the container is.
sleep 2
# Both inside `sh -c`, so Git Bash does not rewrite the container path into a
# Windows one on the way through.
${COMPOSE} exec -T api sh -c 'rm -rf /var/lib/app/storage/* || true'
${COMPOSE} exec -T api sh -c 'cd /var/lib/app/storage && tar -xzf -' < "${OBJECTS}"

echo "Starting the rest"
${COMPOSE} start worker web edge

echo "Restored. Check the application before calling it done:"
echo "  curl -s -o /dev/null -w '%{http_code}\\n' http://localhost:8080/api"
