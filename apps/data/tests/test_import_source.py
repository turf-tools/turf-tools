"""Source-read failures reach the admin as something actionable.

`SourceUnreadableError`'s message lands verbatim in `dataset_versions.error` and
is rendered in the UI, so these pin the two ways a bad source shows up: a local
path that isn't there, and anything the driver refuses to read (a bad URL being
the common case — exercised here with an unreadable file, since it fails in the
same place without needing the network).
"""

from __future__ import annotations

import pytest

from src.importers.base import SourceUnreadableError, redact_source
from src.importers.nys_voter_file import NysVoterFileImporter

# A presigned URL and a credential-in-URI, the two shapes that make a raw source
# string a secret.
PRESIGNED = (
    "https://bucket.example.com/scratch/voters.parquet"
    "?X-Amz-Credential=AKIAEXAMPLE%2F20260802%2Fus-east-1&X-Amz-Signature=deadbeefcafe"
)
CREDENTIALED = "s3://AKIAEXAMPLE:sUp3rS3cr3t@bucket/scratch/voters.parquet"


class _Progress:
    def __init__(self) -> None:
        self.steps = 0

    def advance(self, n: int = 1) -> None:
        self.steps += n


def test_missing_local_source_fails_before_touching_the_catalog() -> None:
    # No connection needed: the up-front check runs before any schema work,
    # which is what stops the fixed-width decode deadlocking on a missing file.
    with pytest.raises(SourceUnreadableError, match="Import source not found"):
        NysVoterFileImporter().load("/nope/not-here.parquet", "irrelevant", None, _Progress())


def test_unreadable_source_is_wrapped_rather_than_surfacing_driver_text(conn, tmp_path) -> None:
    not_parquet = tmp_path / "voters.parquet"
    not_parquet.write_text("this is not a parquet file", encoding="utf-8")

    with pytest.raises(SourceUnreadableError) as excinfo:
        NysVoterFileImporter().load(str(not_parquet), "nys_voter_file_v1", conn, _Progress())

    message = str(excinfo.value)
    assert str(not_parquet) in message
    assert "Check that it exists and is reachable." in message
    # The driver's own wording stays off the user-facing message but remains on
    # the chain, so the job log keeps the real diagnosis.
    assert excinfo.value.__cause__ is not None


def test_redact_source_drops_presigned_query_but_keeps_the_file_identifiable() -> None:
    redacted = redact_source(PRESIGNED)

    assert redacted == "https://bucket.example.com/scratch/voters.parquet"
    assert "X-Amz-Signature" not in redacted
    assert "deadbeefcafe" not in redacted


def test_redact_source_drops_credentials_embedded_in_the_uri() -> None:
    redacted = redact_source(CREDENTIALED)

    assert redacted == "s3://bucket/scratch/voters.parquet"
    assert "sUp3rS3cr3t" not in redacted
    assert "AKIAEXAMPLE" not in redacted


def test_redact_source_leaves_local_paths_alone() -> None:
    assert redact_source("/data/voters.parquet") == "/data/voters.parquet"


def test_error_message_never_carries_the_raw_source(conn) -> None:
    # The message lands in `dataset_versions.error` and renders in the UI, so a
    # presigned source must not survive into it.
    with pytest.raises(SourceUnreadableError) as excinfo:
        NysVoterFileImporter().load(PRESIGNED, "nys_voter_file_v1", conn, _Progress())

    message = str(excinfo.value)
    assert "X-Amz-Signature" not in message
    assert "deadbeefcafe" not in message
    assert "bucket.example.com/scratch/voters.parquet" in message
