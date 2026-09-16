#!/bin/sh
# Hourly pg_dump of the app database and both DuckLake catalogs into /backups,
# which the backup-sync service mirrors to the deployment's bucket. Each dump
# lands in a slot named by hour (24) and, once a day, by day of month (31);
# slots overwrite in place, so retention needs no listing or lifecycle rules.
# Runs in the postgres image so pg_dump always matches the server.
#
# Catalogs first: an import landing mid-run then leaves a version row whose
# catalog tables are missing (visible, re-importable), never the reverse.
DIR=/backups
DATABASES="turf_tools_ducklake turf_tools_ducklake_geo turf_tools"
# UTC hour whose dump also fills the daily slot — 07:00 UTC is overnight in
# New York, after any canvass day has synced.
DAILY_HOUR=07

run_once() {
  hour=$(date -u +%H)
  day=$(date -u +%d)
  for db in $DATABASES; do
    mkdir -p "$DIR/$db/hourly" "$DIR/$db/daily"
    tmp="$DIR/$db/.tmp.dump"
    if ! pg_dump -Fc -d "$db" -f "$tmp"; then
      echo "backup: pg_dump $db FAILED"
      rm -f "$tmp"
      return 1
    fi
    mv -f "$tmp" "$DIR/$db/hourly/$hour.dump"
    if [ "$hour" = "$DAILY_HOUR" ]; then
      cp -f "$DIR/$db/hourly/$hour.dump" "$DIR/$db/daily/$day.dump"
    fi
  done
  # Read by `tt backups`: the last completed run.
  date -u +%Y-%m-%dT%H:%M:%SZ > "$DIR/latest"
  echo "backup: $(cat "$DIR/latest") ok"
}

# Back up on start, then at the top of every hour. A failed run is logged and
# retried next hour rather than crash-looping the container.
run_once || true
while true; do
  sleep $((3600 - $(date +%s) % 3600))
  run_once || true
done
