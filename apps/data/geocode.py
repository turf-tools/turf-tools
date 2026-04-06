import csv
import io
import logging
from abc import ABC, abstractmethod
from dataclasses import dataclass

import duckdb
import requests

logger = logging.getLogger("uvicorn")


# ── Types ─────────────────────────────────────────────────────────


@dataclass
class AddressInput:
    id: str
    street: str
    city: str
    state: str
    zip: str


@dataclass
class GeocodingResult:
    id: str
    latitude: float | None
    longitude: float | None
    matched: bool


# ── Provider abstraction ──────────────────────────────────────────


class GeocodingProvider(ABC):
    @abstractmethod
    def geocode_batch(self, addresses: list[AddressInput]) -> list[GeocodingResult]:
        """Geocode a batch of addresses. Returns results in the same order."""
        ...


class CensusGeocodingProvider(GeocodingProvider):
    """US Census Bureau batch geocoder. Free, no API key."""

    BATCH_URL = "https://geocoding.geo.census.gov/geocoder/locations/addressbatch"
    MAX_BATCH_SIZE = 1000

    def geocode_batch(self, addresses: list[AddressInput]) -> list[GeocodingResult]:
        results: list[GeocodingResult] = []

        for i in range(0, len(addresses), self.MAX_BATCH_SIZE):
            chunk = addresses[i : i + self.MAX_BATCH_SIZE]
            results.extend(self._geocode_chunk(chunk))

        return results

    def _geocode_chunk(self, addresses: list[AddressInput]) -> list[GeocodingResult]:
        # Build CSV in memory
        buf = io.StringIO()
        writer = csv.writer(buf)
        for addr in addresses:
            writer.writerow([addr.id, addr.street, addr.city, addr.state, addr.zip])

        buf.seek(0)
        response = requests.post(
            self.BATCH_URL,
            files={"addressFile": ("addresses.csv", buf.getvalue(), "text/csv")},
            data={"benchmark": "Public_AR_Current", "vintage": "Current_Current"},
            timeout=120,
        )
        response.raise_for_status()

        results = []
        reader = csv.reader(io.StringIO(response.text))
        for row in reader:
            if len(row) < 6:
                continue
            record_id = row[0].strip().strip('"')
            match_status = row[2].strip().strip('"')

            if match_status == "Match":
                coords = row[5].strip().strip('"')
                try:
                    lng, lat = coords.split(",")
                    results.append(
                        GeocodingResult(
                            id=record_id,
                            longitude=float(lng),
                            latitude=float(lat),
                            matched=True,
                        )
                    )
                except (ValueError, IndexError):
                    results.append(GeocodingResult(id=record_id, latitude=None, longitude=None, matched=False))
            else:
                results.append(GeocodingResult(id=record_id, latitude=None, longitude=None, matched=False))

        return results


# ── Geocoding orchestration ───────────────────────────────────────


def geocode_buildings(conn: duckdb.DuckDBPyConnection, provider: GeocodingProvider | None = None) -> dict:
    """Geocode all buildings without coordinates, then propagate to doors and voter_file."""
    if provider is None:
        provider = CensusGeocodingProvider()

    # Get ungeocoded buildings
    rows = conn.execute("""
        SELECT building_id, house_number, street_name, city, state, zip
        FROM buildings
        WHERE latitude IS NULL
    """).fetchall()

    if not rows:
        return {"total_buildings": 0, "geocoded": 0, "failed": 0}

    addresses = [
        AddressInput(
            id=row[0],
            street=f"{row[1] or ''} {row[2] or ''}".strip(),
            city=row[3] or "",
            state=row[4] or "",
            zip=row[5] or "",
        )
        for row in rows
    ]

    logger.info("Geocoding %d buildings...", len(addresses))
    results = provider.geocode_batch(addresses)

    geocoded = 0
    failed = 0
    for result in results:
        if result.matched and result.latitude is not None and result.longitude is not None:
            conn.execute(
                "UPDATE buildings SET latitude = ?, longitude = ? WHERE building_id = ?",
                [result.latitude, result.longitude, result.id],
            )
            geocoded += 1
        else:
            failed += 1

    # Propagate coordinates from buildings to doors
    conn.execute("""
        UPDATE doors SET
            latitude = b.latitude,
            longitude = b.longitude
        FROM buildings b
        WHERE doors.building_id = b.building_id
          AND b.latitude IS NOT NULL
          AND doors.latitude IS NULL
    """)

    # Propagate coordinates from buildings to voter_file
    conn.execute("""
        UPDATE voter_file SET
            latitude = b.latitude,
            longitude = b.longitude
        FROM buildings b
        WHERE voter_file.building_id = b.building_id
          AND b.latitude IS NOT NULL
          AND voter_file.latitude IS NULL
    """)

    logger.info("Geocoding complete: %d geocoded, %d failed", geocoded, failed)

    return {
        "total_buildings": len(addresses),
        "geocoded": geocoded,
        "failed": failed,
    }


def export_geojson(conn: duckdb.DuckDBPyConnection, table: str = "buildings") -> dict:
    """Export geocoded records as GeoJSON for visual verification."""
    rows = conn.execute(f"""
        SELECT * FROM {table}
        WHERE latitude IS NOT NULL AND longitude IS NOT NULL
    """).fetchall()

    columns = [desc[0] for desc in conn.execute(f"DESCRIBE {table}").fetchall()]

    features = []
    for row in rows:
        record = dict(zip(columns, row, strict=True))
        lat = record.pop("latitude")
        lng = record.pop("longitude")
        features.append(
            {
                "type": "Feature",
                "geometry": {"type": "Point", "coordinates": [lng, lat]},
                "properties": record,
            }
        )

    return {
        "type": "FeatureCollection",
        "features": features,
    }
