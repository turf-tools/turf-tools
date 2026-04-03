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


class UserDataStorageConfig(S3StorageConfig):
    """Object storage for user-uploaded data."""

    model_config = {"env_prefix": "USER_DATA_STORAGE_"}


class TurfsStorageConfig(S3StorageConfig):
    """Object storage for turf cut outputs."""

    model_config = {"env_prefix": "TURFS_STORAGE_"}


class Settings(BaseSettings):
    """Application settings loaded from environment variables."""

    ducklake_metadata_postgres_url: str | None = Field(
        default=None,
        description="PostgreSQL connection URL for the DuckLake metadata catalog. If not set, uses local DuckDB file.",
    )

    ducklake_storage: DucklakeStorageConfig = Field(default_factory=DucklakeStorageConfig)
    user_data_storage: UserDataStorageConfig = Field(default_factory=UserDataStorageConfig)
    turfs_storage: TurfsStorageConfig = Field(default_factory=TurfsStorageConfig)


def get_settings() -> Settings:
    """Create and return application settings from environment variables."""
    return Settings()
