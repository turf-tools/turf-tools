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


def _dev_meta_schema(name: str) -> str | None:
    """Dev shares one Postgres DB across catalogs via distinct schemas; prod uses
    a DB per catalog (default schema), so no META_SCHEMA there."""
    return None if os.environ.get("NODE_ENV") == "production" else name


class S3StorageConfig(BaseSettings):
    """Configuration for an S3-compatible object storage bucket."""

    endpoint_url: str = ""
    access_key_id: str = ""
    secret_access_key: str = ""
    bucket: str = ""
    region: str = "auto"


class DucklakeStorageConfig(S3StorageConfig):
    """Object storage for DuckLake data files (Parquet, etc.)."""

    model_config = {"env_prefix": "DUCKLAKE_STORAGE_"}


class GeoDucklakeStorageConfig(S3StorageConfig):
    """Object storage for geo DuckLake data files (TIGER-derived Parquet, etc.)."""

    model_config = {"env_prefix": "GEO_DUCKLAKE_STORAGE_"}


class UserDataStorageConfig(S3StorageConfig):
    """Object storage for user-uploaded data."""

    model_config = {"env_prefix": "USER_DATA_STORAGE_"}


class Settings(BaseSettings):
    """Application settings loaded from environment variables."""

    model_config = {"env_file": ".env"}

    voter_file_url: str = Field(
        default="https://zohran-data-backups.nyc3.digitaloceanspaces.com/ny-voters-2026-03-08.parquet",
        description=(
            "Public URL where the source voter file (parquet) can be downloaded. "
            "Used by the seed CLI to tell first-time users where to grab the "
            "fixture from when one isn't present locally."
        ),
    )

    voter_file_fixture: str = Field(
        default="ny-voters-2026-03-08-nyc.parquet",
        description=(
            "Filename of the voter file fixture inside `fixtures_dir` that "
            "`seed-persons` reads from. Override to point at a smaller sample "
            "during development."
        ),
    )

    fixtures_dir: str = Field(
        default="fixtures",
        description=("Directory (relative to apps/data) holding voter file fixtures."),
    )

    ducklake_metadata_postgres_url: str | None = Field(
        default_factory=_default_ducklake_metadata_url,
        description="PostgreSQL connection URL for the DuckLake metadata catalog. If not set, uses local DuckDB file.",
    )
    # Postgres schema holding this catalog's metadata tables. Lets several
    # catalogs share one Postgres DB (dev points both at the dev Postgres). Unset
    # in prod, where each catalog has its own DB and uses the default schema.
    ducklake_meta_schema: str | None = Field(default_factory=lambda: _dev_meta_schema("ducklake"))

    geo_ducklake_metadata_postgres_url: str | None = Field(
        default_factory=_default_ducklake_metadata_url,
        description=(
            "PostgreSQL connection URL for the geo DuckLake metadata catalog. If not set, uses local DuckDB file."
        ),
    )
    geo_ducklake_meta_schema: str | None = Field(default_factory=lambda: _dev_meta_schema("geo_ducklake"))

    database_url: str = Field(
        default_factory=_default_database_url,
        description="PostgreSQL connection URL for operational data shared with the web app.",
    )

    ducklake_storage: DucklakeStorageConfig = Field(default_factory=DucklakeStorageConfig)
    geo_ducklake_storage: GeoDucklakeStorageConfig = Field(default_factory=GeoDucklakeStorageConfig)
    user_data_storage: UserDataStorageConfig = Field(default_factory=UserDataStorageConfig)

    # TIGER download settings
    tiger_year: str = Field(
        default="2024",
        description="TIGER/Line vintage year to download.",
    )
    tiger_state_fips: str = Field(
        default="36",
        description="State FIPS code for TIGER data (e.g. 36 for New York).",
    )
    tiger_county_fips: list[str] = Field(
        # All five NYC counties: New York (Manhattan), Bronx, Kings (Brooklyn),
        # Queens, Richmond (Staten Island). Matches the
        # `ny-voters-2026-03-08-10k-sample` seed fixture so geocoding has
        # TIGER coverage for every borough out of the box.
        default=["061", "005", "047", "081", "085"],
        description="County FIPS codes within the state (e.g. 061 for New York County/Manhattan).",
    )
    tiger_data_dir: str = Field(
        default="./tiger_cache",
        description="Local directory to cache downloaded TIGER shapefiles.",
    )
    voter_zip5_filter: list[str] | None = Field(
        default=None,
        description=(
            "When set, restrict seed-persons to voters whose residential ZIP5 is in this list. "
            "Used to scope dev runs to a small set of test areas for fast iteration."
        ),
    )

    # OSM refinement layer. Pin a specific Geofabrik daily snapshot
    # (YYMMDD in the filename) rather than `-latest`, so the cached PBF
    # filename encodes the version and re-runs are reproducible.
    osm_url: str = Field(
        default="https://download.geofabrik.de/north-america/us/new-york-260501.osm.pbf",
        description="URL of the Geofabrik OSM PBF extract to ingest (date-pinned).",
    )
    osm_data_dir: str = Field(
        default="./osm_cache",
        description="Local directory to cache the downloaded OSM PBF.",
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
        default="config/quickwit.yaml",
        description="Quickwit node config passed to `local-ingest` (carries the metastore URI).",
    )


def get_settings() -> Settings:
    """Create and return application settings from environment variables."""
    return Settings()
