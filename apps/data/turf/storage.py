"""Read/write turf data blobs.

A turf data blob is a JSON file containing everything the native app needs to
walk a turf (geometry, buildings, doors, people). See packages/db/src/turf-data.ts
for the schema.

In dev, blobs are written to the local filesystem (``local_turfs/`` by default).
When ``TurfsStorageConfig.bucket`` is set, this module will eventually write to
S3 — not yet implemented.
"""

import json
import os
from pathlib import Path

from settings import Settings

LOCAL_TURFS_DIR = Path("local_turfs")


def _local_path(turf_id: str) -> Path:
    return LOCAL_TURFS_DIR / f"{turf_id}.json"


def _public_base_url() -> str:
    """Base URL the native app should use to fetch blobs.

    Defaults to the local data service. Override with DATA_SERVICE_PUBLIC_URL
    (e.g., a LAN IP when testing on a physical device).
    """
    return os.environ.get("DATA_SERVICE_PUBLIC_URL", "http://localhost:8000")


def blob_url(turf_id: str) -> str:
    """Return the URL the native app should fetch to load this turf's data."""
    return f"{_public_base_url()}/turfs/{turf_id}/data"


def write_turf_data(settings: Settings, turf_id: str, data: dict) -> str:
    """Write a turf data blob to storage and return the URL to fetch it."""
    if settings.turfs_storage.bucket:
        raise NotImplementedError(
            "S3-backed turf storage is not implemented yet. Unset TURFS_STORAGE_BUCKET to use local filesystem."
        )

    LOCAL_TURFS_DIR.mkdir(exist_ok=True)
    path = _local_path(turf_id)
    path.write_text(json.dumps(data))
    return blob_url(turf_id)


def read_turf_data(settings: Settings, turf_id: str) -> dict:
    """Read a turf data blob from storage."""
    if settings.turfs_storage.bucket:
        raise NotImplementedError(
            "S3-backed turf storage is not implemented yet. Unset TURFS_STORAGE_BUCKET to use local filesystem."
        )

    path = _local_path(turf_id)
    if not path.exists():
        raise FileNotFoundError(f"Turf data not found for turf_id={turf_id}")
    return json.loads(path.read_text())
