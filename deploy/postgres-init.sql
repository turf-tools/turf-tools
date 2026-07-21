-- Runs once, on first initialisation of an empty data directory.
-- POSTGRES_DB creates turf_tools; the rest are created here.
CREATE DATABASE turf_tools_ducklake_catalog;
CREATE DATABASE turf_tools_ducklake_geo_catalog;
CREATE DATABASE quickwit;
