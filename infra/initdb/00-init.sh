#!/bin/sh
# Runs once, on first start of each source container. Creates that source's
# schema and its roles; RL_SOURCE picks which schema file applies.
set -eu
psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
  -v reader_pw="$RL_READER_PASSWORD" \
  -v service_pw="$RL_SERVICE_PASSWORD" \
  -v executor_pw="$RL_EXECUTOR_PASSWORD" \
  -f "/rl-sql/${RL_SOURCE}.sql"
