"""`redact_secrets` masks connection-string credentials and leaves everything else as-is."""

from __future__ import annotations

import pytest

from src.redact import redact_secrets


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        (
            'IO Error: Unable to connect to Postgres at "postgres://app:s3cret@db-rw:5432/turf_tools": refused',
            'IO Error: Unable to connect to Postgres at "postgres://app:***@db-rw:5432/turf_tools": refused',
        ),
        ("postgresql://lake:p%40ss@host/db", "postgresql://lake:***@host/db"),
        ("s3://AKIAEXAMPLE:abc/def@bucket/key", "s3://AKIAEXAMPLE:***@bucket/key"),
        ("host=db user=app password=s3cret dbname=x", "host=db user=app password=*** dbname=x"),
        ("password = 's3 cret' sslmode=require", "password = *** sslmode=require"),
        ("two: postgres://a:x@h1/d and postgres://b:y@h2/d", "two: postgres://a:***@h1/d and postgres://b:***@h2/d"),
    ],
)
def test_credentials_are_masked(text: str, expected: str) -> None:
    assert redact_secrets(text) == expected


@pytest.mark.parametrize(
    "text",
    [
        "Could not read the import source 'https://example.com/voters.parquet'.",
        "postgres://app@db-rw:5432/turf_tools",  # no password
        "ratio 12:30 at noon",
        "already masked postgres://app:***@db/x",
    ],
)
def test_text_without_credentials_is_unchanged(text: str) -> None:
    assert redact_secrets(text) == text
