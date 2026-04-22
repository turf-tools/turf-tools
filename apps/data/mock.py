"""Set up mock data for development.

This is dev-only scaffolding, parallel to packages/db/src/mock.ts. Together
the two scripts create useful test data: mock.ts creates the
Postgres rows (org, user, campaign, script, universe, turf), and this script
populates DuckLake + Quickwit + the turf data blob that the seeded turf
points at.

Steps performed:
  1. Import the ED fixture into voter_file/buildings/doors.
  2. Geocode the buildings via Census.
  3. Index voters into Quickwit (requires Quickwit to be running).
  4. Build the mock turf data blob and write it to local turf storage.

For a fresh run, do `pnpm clear` first.

Usage:
    pnpm data:mock
"""

from datetime import date

import duckdb

from src.db import create_tables, get_connection
from geocode import geocode_buildings
from import_voter_file import import_voter_file
from index_quickwit import run_index
from src.settings import get_settings
from turf.storage import blob_url, write_turf_data

# Must match packages/db/src/mock.ts
SEEDED_TURF_ID = "00000000-0000-4000-8000-000000000006"
SEEDED_TURF_NAME = "Default Turf"
DEFAULT_VOTER_FILE_ID = "nys_boe"
DEFAULT_VOTER_FILE_VERSION = 1

FIXTURE_PATH = "fixtures/nys-voters-2026-03-08-ad-65-ed-39.parquet"


def build_turf_data(
    conn: duckdb.DuckDBPyConnection,
    turf_id: str,
    name: str,
    voter_file_id: str,
    voter_file_version: int,
) -> dict:
    """Assemble a turf data blob + bounding-box geometry from DuckLake.

    The first mock turf targets a single election district fixture, so the whole
    imported voter file version is treated as one turf. When TIGER-based cutting
    lands this is replaced by real per-turf selection.
    """
    buildings_rows = conn.execute(
        """
        SELECT DISTINCT
            b.building_id,
            b.house_number,
            b.street_name,
            b.city,
            b.state,
            b.zip,
            b.latitude,
            b.longitude
        FROM buildings b
        WHERE b.building_id IN (
            SELECT DISTINCT building_id FROM voter_file
            WHERE voter_file_id = ? AND voter_file_version = ?
        )
        """,
        [voter_file_id, voter_file_version],
    ).fetchall()

    doors_rows = conn.execute(
        """
        SELECT DISTINCT d.door_id, d.building_id, d.unit
        FROM doors d
        WHERE d.door_id IN (
            SELECT DISTINCT door_id FROM voter_file
            WHERE voter_file_id = ? AND voter_file_version = ?
        )
        """,
        [voter_file_id, voter_file_version],
    ).fetchall()

    people_rows = conn.execute(
        """
        SELECT voter_id, door_id, first_name, last_name, party, date_of_birth, gender
        FROM voter_file
        WHERE voter_file_id = ? AND voter_file_version = ?
        """,
        [voter_file_id, voter_file_version],
    ).fetchall()

    persons_by_door: dict[str, list[dict]] = {}
    for voter_id, door_id, first_name, last_name, party, date_of_birth, gender in people_rows:
        persons_by_door.setdefault(str(door_id), []).append(
            {
                "personId": str(voter_id),
                "firstName": first_name,
                "lastName": last_name,
                "party": party,
                "age": _compute_age(date_of_birth),
                "gender": gender,
            }
        )

    doors_by_building: dict[str, list[dict]] = {}
    for door_id, building_id, unit in doors_rows:
        door_id_s = str(door_id)
        doors_by_building.setdefault(str(building_id), []).append(
            {
                "doorId": door_id_s,
                "unit": unit,
                "persons": persons_by_door.get(door_id_s, []),
            }
        )

    # TODO(duplicate-coordinates): two buildings can end up at the exact same
    # lat/lng, either because Census's geocoder collapsed them (it interpolates
    # off TIGER street segment endpoints, which isn't sub-building precise) or
    # because the voter file has two address forms for the same physical
    # building. The native app handles this badly — stacked pins look like one,
    # and tap routes to whichever feature MapLibre returns first.
    #
    # Two layers of fix when we get back to this:
    #   1. DATA: a post-geocode reconciliation pass that detects buildings
    #      sharing a coordinate and either merges them (if they're really one
    #      building with two address forms) or applies a small spatial offset
    #      (if they're really two buildings the geocoder couldn't distinguish).
    #      TIGER-based geocoding (Track B) should make this much rarer.
    #   2. UI: even with a data fix, defensive disambiguation in the native
    #      app — when a tap hits multiple features at the same screen point,
    #      show an iOS action sheet listing the options instead of silently
    #      picking one. Lives in apps/native/src/components/map/TurfMap.tsx.
    buildings: list[dict] = []
    lats: list[float] = []
    lngs: list[float] = []
    for building_id, house_number, street_name, city, state, zip_code, latitude, longitude in buildings_rows:
        building_id_s = str(building_id)
        buildings.append(
            {
                "buildingId": building_id_s,
                "latitude": latitude,
                "longitude": longitude,
                "address": {
                    "houseNumber": house_number,
                    "street": street_name,
                    "city": city,
                    "state": state,
                    "zip": zip_code,
                },
                "doors": doors_by_building.get(building_id_s, []),
            }
        )
        if latitude is not None and longitude is not None:
            lats.append(latitude)
            lngs.append(longitude)

    return {
        "turfId": turf_id,
        "name": name,
        "voterFileId": voter_file_id,
        "voterFileVersion": voter_file_version,
        "geometry": _bbox_polygon(lats, lngs),
        "buildings": buildings,
    }


def _compute_age(dob: date | None) -> int | None:
    if dob is None:
        return None
    today = date.today()
    return today.year - dob.year - ((today.month, today.day) < (dob.month, dob.day))


def _bbox_polygon(lats: list[float], lngs: list[float]) -> dict:
    if not lats or not lngs:
        return {"type": "Polygon", "coordinates": [[[0, 0], [0, 0], [0, 0], [0, 0], [0, 0]]]}

    min_lat, max_lat = min(lats), max(lats)
    min_lng, max_lng = min(lngs), max(lngs)
    pad_lat = max((max_lat - min_lat) * 0.05, 0.0005)
    pad_lng = max((max_lng - min_lng) * 0.05, 0.0005)
    sw = [min_lng - pad_lng, min_lat - pad_lat]
    nw = [min_lng - pad_lng, max_lat + pad_lat]
    ne = [max_lng + pad_lng, max_lat + pad_lat]
    se = [max_lng + pad_lng, min_lat - pad_lat]
    return {"type": "Polygon", "coordinates": [[sw, nw, ne, se, sw]]}


def main() -> None:
    settings = get_settings()
    conn = get_connection(settings)
    try:
        create_tables(conn)

        print("1. Importing voter file...")
        result = import_voter_file(conn, FIXTURE_PATH, DEFAULT_VOTER_FILE_ID)
        print(f"   {result['voters_imported']} voters, {result['buildings']} buildings, {result['doors']} doors")

        print("2. Geocoding buildings...")
        result = geocode_buildings(conn)
        print(f"   {result['geocoded']}/{result['total_buildings']} geocoded")

        print("3. Indexing into Quickwit...")
        result = run_index(conn)
        print(f"   {result['indexed']} records indexed")

        print("4. Building mock turf data blob...")
        data = build_turf_data(
            conn,
            turf_id=SEEDED_TURF_ID,
            name=SEEDED_TURF_NAME,
            voter_file_id=DEFAULT_VOTER_FILE_ID,
            voter_file_version=DEFAULT_VOTER_FILE_VERSION,
        )
    finally:
        conn.close()

    write_turf_data(settings, SEEDED_TURF_ID, data)
    n_buildings = len(data["buildings"])
    n_doors = sum(len(b["doors"]) for b in data["buildings"])
    n_persons = sum(len(d["persons"]) for b in data["buildings"] for d in b["doors"])
    print(f"   {n_buildings} buildings, {n_doors} doors, {n_persons} persons in turf blob")
    print(f"   turf_id: {SEEDED_TURF_ID}")
    print(f"   url:     {blob_url(SEEDED_TURF_ID)}")
    print("\n✓ Mock data ready")


if __name__ == "__main__":
    main()
