import { createLogger, run } from "./_logging";

const log = createLogger("reset");

const DATA_ENV = "/etc/field-tools-data.env";
const DBS = ["field_tools", "field_tools_ducklake_catalog", "field_tools_geo_ducklake_catalog"];

log.task("stopping services");
run(log, "sudo systemctl stop field-tools-web field-tools-data");

log.task("recreating Postgres databases");
for (const db of DBS) {
  run(log, `sudo -u postgres psql -c "DROP DATABASE IF EXISTS ${db};"`);
  run(log, `sudo -u postgres psql -c "CREATE DATABASE ${db};"`);
}

log.task("wiping DuckLake S3 buckets");
run(
  log,
  `set -a; . ${DATA_ENV}; set +a; ` +
    `aws s3 rm "s3://$DUCKLAKE_STORAGE_BUCKET/" --recursive && ` +
    `aws s3 rm "s3://$GEO_DUCKLAKE_STORAGE_BUCKET/" --recursive`,
);

log.task("pushing schema");
run(log, "pnpm prod:db:push");

log.task("seeding reference data");
run(log, "pnpm prod:db:seed");

log.task("starting services");
run(log, "sudo systemctl start field-tools-data field-tools-web");

log.success("reset complete");
