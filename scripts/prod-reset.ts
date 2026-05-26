import { run, section } from "./_logging";

const DATA_ENV = "/etc/field-tools-data.env";
const DBS = ["field_tools", "field_tools_ducklake_catalog", "field_tools_geo_ducklake_catalog"];

section("stopping services");
run("sudo systemctl stop field-tools-web field-tools-data");

section("recreating Postgres databases");
for (const db of DBS) {
  run(`sudo -u postgres psql -c "DROP DATABASE IF EXISTS ${db};"`);
  run(`sudo -u postgres psql -c "CREATE DATABASE ${db};"`);
}

section("wiping DuckLake S3 buckets");
run(
  `set -a; . ${DATA_ENV}; set +a; ` +
    `aws s3 rm "s3://$DUCKLAKE_STORAGE_BUCKET/" --recursive && ` +
    `aws s3 rm "s3://$GEO_DUCKLAKE_STORAGE_BUCKET/" --recursive`,
);

section("pushing schema");
run("pnpm prod:db:push");

section("seeding reference data");
run("pnpm prod:db:seed");

section("starting services");
run("sudo systemctl start field-tools-data field-tools-web");
