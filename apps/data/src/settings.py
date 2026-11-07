import os

from pydantic import Field
from pydantic_settings import BaseSettings


def _default_database_url() -> str:
    """Dev Postgres fallback — mirrors packages/db/src/index.ts."""
    if os.environ.get("NODE_ENV") == "production":
        raise ValueError("DATABASE_URL is required in production.")
    return "postgres://postgres:postgres@127.0.0.1:5432/postgres"


def _default_ducklake_metadata_url() -> str | None:
    """Dev defaults DuckLake to a Postgres catalog (concurrency-safe, so import
    jobs don't fight the serving connection over a single-writer local file).
    Prod sets it explicitly; unset in prod → local-file fallback."""
    if os.environ.get("NODE_ENV") == "production":
        return None
    return _default_database_url()


class StorageConfig(BaseSettings):
    """S3-compatible object storage for the deployment.

    One bucket per deployment; the lakes and the search index are separated by
    prefix inside it, so a single credential covers everything.
    """

    model_config = {"env_prefix": "STORAGE_"}

    endpoint_url: str = ""
    access_key_id: str = ""
    secret_access_key: str = ""
    bucket: str = ""
    region: str = "auto"
    # DuckDB addressing style. Latitude accepts path; DO Spaces needs vhost.
    url_style: str = "path"


class Settings(BaseSettings):
    """Application settings loaded from environment variables."""

    model_config = {"env_file": ".env"}

    ducklake_metadata_postgres_url: str | None = Field(
        default_factory=_default_ducklake_metadata_url,
        description="PostgreSQL connection URL for the DuckLake metadata catalog. If not set, uses local DuckDB file.",
    )
    # Postgres schema holding this catalog's metadata tables. Same names in
    # every environment: dev shares one Postgres DB across catalogs via these
    # schemas; prod gives each catalog its own DB but keeps the schema name.
    ducklake_meta_schema: str = "catalog"

    ducklake_geo_metadata_postgres_url: str | None = Field(
        default_factory=_default_ducklake_metadata_url,
        description=(
            "PostgreSQL connection URL for the geo DuckLake metadata catalog. If not set, uses local DuckDB file."
        ),
    )
    ducklake_geo_meta_schema: str = "catalog_geo"

    database_url: str = Field(
        default_factory=_default_database_url,
        description="PostgreSQL connection URL for operational data shared with the web app.",
    )

    storage: StorageConfig = Field(default_factory=StorageConfig)
    ducklake_prefix: str = Field(default="ducklake", description="Key prefix for the person lake.")
    ducklake_geo_prefix: str = Field(default="ducklake-geo", description="Key prefix for the geo lake.")

    # Reference-data vintages. Each import fetches the counties and states its
    # own addresses need (`tiger.geo_extent`).
    tiger_year: str = Field(
        default="2024",
        description="TIGER/Line vintage year to download.",
    )
    tiger_data_dir: str = Field(
        default="./tiger_cache",
        description="Local directory to cache downloaded TIGER shapefiles.",
    )

    # Pin a Geofabrik Jan-1 snapshot (YYMMDD): dailies and monthlies rotate
    # out within weeks to months, while Jan-1 files stay up for years. Only
    # read when a state's OSM tables are first built; bumping it doesn't
    # refresh states already built.
    osm_snapshot: str = Field(
        default="260101",
        description="Geofabrik snapshot date (YYMMDD) of the per-state OSM extracts to ingest.",
    )
    osm_data_dir: str = Field(
        default="./osm_cache",
        description="Local directory to cache downloaded OSM PBFs.",
    )

    quickwit_batch_size: int = Field(
        default=1_000_000,
        description=(
            "Number of voter records to stream per Quickwit local-ingest batch. "
            "1,000,000 is the conservative default; larger batch sizes may be faster "
            "if the builder machine has enough memory."
        ),
    )
    quickwit_url: str = Field(
        default="http://127.0.0.1:7280",
        description="Base URL of the Quickwit searcher's REST API (index create + search).",
    )
    quickwit_binary: str = Field(
        default="quickwit",
        description="Path to the Quickwit CLI binary used for `tool local-ingest`.",
    )
    quickwit_config_path: str = Field(
        default="quickwit/node.yaml",
        description="Quickwit node config passed to `local-ingest` (carries the metastore URI).",
    )


def get_settings() -> Settings:
    """Create and return application settings from environment variables."""
    return Settings()
