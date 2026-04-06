import os

from db import create_tables
from geocode import AddressInput, GeocodingProvider, GeocodingResult, export_geojson, geocode_buildings
from import_voter_file import import_voter_file

FIXTURE_PATH = os.path.join(os.path.dirname(__file__), "..", "fixtures", "nys-voters-2026-03-08-ad-65-ed-39.parquet")


class MockGeocodingProvider(GeocodingProvider):
    """Returns fixed coordinates for all addresses."""

    def geocode_batch(self, addresses: list[AddressInput]) -> list[GeocodingResult]:
        return [
            GeocodingResult(id=addr.id, latitude=40.72 + i * 0.001, longitude=-73.99 + i * 0.001, matched=True)
            for i, addr in enumerate(addresses)
        ]


class PartialMockProvider(GeocodingProvider):
    """Matches some addresses, fails others."""

    def geocode_batch(self, addresses: list[AddressInput]) -> list[GeocodingResult]:
        return [
            GeocodingResult(id=addr.id, latitude=40.72, longitude=-73.99, matched=True)
            if i % 2 == 0
            else GeocodingResult(id=addr.id, latitude=None, longitude=None, matched=False)
            for i, addr in enumerate(addresses)
        ]


def test_geocode_buildings(conn):
    create_tables(conn)
    import_voter_file(conn, FIXTURE_PATH, "nys_boe")

    result = geocode_buildings(conn, provider=MockGeocodingProvider())

    assert result["total_buildings"] == 41
    assert result["geocoded"] == 41
    assert result["failed"] == 0

    # Verify buildings have coordinates
    ungeocoded = conn.execute("SELECT count(*) FROM buildings WHERE latitude IS NULL").fetchone()[0]
    assert ungeocoded == 0


def test_geocode_propagates_to_doors(conn):
    create_tables(conn)
    import_voter_file(conn, FIXTURE_PATH, "nys_boe")

    geocode_buildings(conn, provider=MockGeocodingProvider())

    # Doors should have coordinates from their building
    geocoded_doors = conn.execute("SELECT count(*) FROM doors WHERE latitude IS NOT NULL").fetchone()[0]
    total_doors = conn.execute("SELECT count(*) FROM doors").fetchone()[0]
    assert geocoded_doors == total_doors


def test_geocode_propagates_to_voters(conn):
    create_tables(conn)
    import_voter_file(conn, FIXTURE_PATH, "nys_boe")

    geocode_buildings(conn, provider=MockGeocodingProvider())

    # Voters should have coordinates from their building
    geocoded_voters = conn.execute("SELECT count(*) FROM voter_file WHERE latitude IS NOT NULL").fetchone()[0]
    assert geocoded_voters == 537


def test_geocode_partial_match(conn):
    create_tables(conn)
    import_voter_file(conn, FIXTURE_PATH, "nys_boe")

    result = geocode_buildings(conn, provider=PartialMockProvider())

    assert result["geocoded"] + result["failed"] == 41
    assert result["geocoded"] > 0
    assert result["failed"] > 0


def test_geocode_idempotent(conn):
    create_tables(conn)
    import_voter_file(conn, FIXTURE_PATH, "nys_boe")

    geocode_buildings(conn, provider=MockGeocodingProvider())
    result2 = geocode_buildings(conn, provider=MockGeocodingProvider())

    # Second run should find no ungeocoded buildings
    assert result2["total_buildings"] == 0


def test_export_geojson(conn):
    create_tables(conn)
    import_voter_file(conn, FIXTURE_PATH, "nys_boe")
    geocode_buildings(conn, provider=MockGeocodingProvider())

    geojson = export_geojson(conn, "buildings")

    assert geojson["type"] == "FeatureCollection"
    assert len(geojson["features"]) == 41
    assert geojson["features"][0]["geometry"]["type"] == "Point"
    assert "coordinates" in geojson["features"][0]["geometry"]
    assert "building_id" in geojson["features"][0]["properties"]
