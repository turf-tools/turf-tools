from pydantic import Field
from pydantic_settings import BaseSettings


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

    dev_voterfile_url: str = Field(
        default="",
        description="URL to fetch the voter file from (parquet format assumed).",
    )

    ducklake_metadata_postgres_url: str | None = Field(
        default=None,
        description="PostgreSQL connection URL for the DuckLake metadata catalog. If not set, uses local DuckDB file.",
    )

    geo_ducklake_metadata_postgres_url: str | None = Field(
        default=None,
        description=(
            "PostgreSQL connection URL for the geo DuckLake metadata catalog. If not set, uses local DuckDB file."
        ),
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
        # `nys-voters-2026-03-08-10k-sample` seed fixture so geocoding has
        # TIGER coverage for every borough out of the box.
        default=["061", "005", "047", "081", "085"],
        description="County FIPS codes within the state (e.g. 061 for New York County/Manhattan).",
    )
    tiger_data_dir: str = Field(
        default="./tiger_cache",
        description="Local directory to cache downloaded TIGER shapefiles.",
    )

    quickwit_batch_size: int = Field(
        default=1_000_000,
        description=(
            "Number of voter records to stream per Quickwit local-ingest batch. "
            "1,000,000 is the conservative default; larger batch sizes may be faster "
            "if the builder machine has enough memory."
        ),
    )


def get_settings() -> Settings:
    """Create and return application settings from environment variables."""
    return Settings()
