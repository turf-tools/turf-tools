"""Version-level derived metadata: the bounds box maps open on."""

from __future__ import annotations

from src.derived import compute_derived_metadata
from src.importers.base import Manifest

EMPTY_MANIFEST = Manifest(fields=[])


def test_bounds_span_geocoded_persons(conn) -> None:
    conn.execute(
        "CREATE TABLE persons_geocoded AS SELECT * FROM (VALUES "
        "(-74.0, 40.7), (-73.9, 40.8), (NULL, NULL)) t(longitude, latitude)"
    )
    derived = compute_derived_metadata(conn, "persons_geocoded", EMPTY_MANIFEST)
    assert derived["rowCount"] == 3
    assert derived["bounds"] == [-74.0, 40.7, -73.9, 40.8]


def test_bounds_absent_when_nothing_geocoded(conn) -> None:
    conn.execute("CREATE TABLE persons_geocoded (longitude DOUBLE, latitude DOUBLE)")
    derived = compute_derived_metadata(conn, "persons_geocoded", EMPTY_MANIFEST)
    assert "bounds" not in derived
