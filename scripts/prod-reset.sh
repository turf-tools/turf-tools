#!/usr/bin/env bash
# Nuke and reseed the deployed box.
#
# Drops + recreates all three Postgres DBs, empties both DuckLake S3
# buckets, re-pushes the OLTP schema, and reruns the OLTP + DuckLake
# seeds. Wired to `pnpm prod:reset`. Run on the box, in a tmux session
# (seed-boundaries is slow).
set -euo pipefail

WEB_ENV=/etc/field-tools-web.env
DATA_ENV=/etc/field-tools-data.env

DBS=(field_tools field_tools_ducklake_catalog field_tools_geo_ducklake_catalog)

echo "==> stopping services"
sudo systemctl stop field-tools-web field-tools-data

echo "==> recreating Postgres databases"
for db in "${DBS[@]}"; do
  sudo -u postgres psql -c "DROP DATABASE IF EXISTS $db;"
  sudo -u postgres psql -c "CREATE DATABASE $db;"
done

echo "==> wiping DuckLake S3 buckets"
# shellcheck disable=SC1090
(set -a; . "$DATA_ENV"; set +a
  aws s3 rm "s3://$DUCKLAKE_STORAGE_BUCKET/" --recursive
  aws s3 rm "s3://$GEO_DUCKLAKE_STORAGE_BUCKET/" --recursive)

echo "==> pushing OLTP schema"
pnpm prod:db:push

echo "==> seeding OLTP (admin user, default org)"
# shellcheck disable=SC1090
(set -a; . "$WEB_ENV"; set +a; unset NODE_ENV; pnpm db:mock)

echo "==> seeding DuckLake (persons + boundaries — slow)"
# shellcheck disable=SC1090
(set -a; . "$DATA_ENV"; set +a; unset NODE_ENV; pnpm data:mock)

echo "==> starting services"
sudo systemctl start field-tools-data field-tools-web

echo "==> done"
