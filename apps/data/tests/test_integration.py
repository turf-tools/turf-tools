"""Integration test for the full data pipeline.

Prerequisites:
  1. pnpm clear
  2. pnpm dev (wait for all services to be ready)
  3. pnpm test:integration
"""

import requests

DATA_URL = "http://localhost:8000"
FIXTURE = "fixtures/nys-voters-2026-03-08-ad-65-ed-39.parquet"


def check_service(url: str, name: str) -> None:
    try:
        resp = requests.get(f"{url}/healthcheck", timeout=2)
        resp.raise_for_status()
    except requests.ConnectionError:
        raise SystemExit(f"{name} is not running at {url}") from None


def main():
    print("Checking services...")
    check_service(DATA_URL, "Data service")

    print("\n1. Importing voter file...")
    resp = requests.post(
        f"{DATA_URL}/voter-file/import",
        json={"file_path": FIXTURE, "voter_file_id": "nys_boe"},
        timeout=30,
    )
    resp.raise_for_status()
    result = resp.json()
    assert result["voter_file_version"] == 1, f"Expected version 1, got {result['voter_file_version']}"
    assert result["voters_imported"] == 537, f"Expected 537 voters, got {result['voters_imported']}"
    assert result["buildings"] == 41, f"Expected 41 buildings, got {result['buildings']}"
    assert result["doors"] == 390, f"Expected 390 doors, got {result['doors']}"
    print(f"   Imported {result['voters_imported']} voters, {result['buildings']} buildings, {result['doors']} doors")

    print("\n2. Geocoding buildings...")
    resp = requests.post(f"{DATA_URL}/buildings/geocode", timeout=120)
    resp.raise_for_status()
    result = resp.json()
    assert result["total_buildings"] == 41, f"Expected 41 buildings, got {result['total_buildings']}"
    assert result["geocoded"] > 0, "No buildings were geocoded"
    print(f"   Geocoded {result['geocoded']}/{result['total_buildings']} buildings ({result['failed']} failed)")

    print("\n3. Verifying GeoJSON export...")
    resp = requests.get(f"{DATA_URL}/buildings/geojson", timeout=10)
    resp.raise_for_status()
    geojson = resp.json()
    assert len(geojson["features"]) == result["geocoded"], "GeoJSON count doesn't match geocoded count"
    coords = geojson["features"][0]["geometry"]["coordinates"]
    assert len(coords) == 2, "GeoJSON coordinates should have [lng, lat]"
    print(f"   {len(geojson['features'])} buildings with coordinates")

    print("\n4. Indexing into Quickwit...")
    resp = requests.post(f"{DATA_URL}/people/index", timeout=30)
    resp.raise_for_status()
    result = resp.json()
    assert result["indexed"] == 537, f"Expected 537 indexed, got {result['indexed']}"
    print(f"   Indexed {result['indexed']} records")

    print("\n5. Searching...")
    resp = requests.get(f"{DATA_URL}/people/search", params={"q": "last_name:FOK"}, timeout=10)
    resp.raise_for_status()
    result = resp.json()
    assert result["total"] == 1, f"Expected 1 result for FOK, got {result['total']}"
    assert result["hits"][0]["first_name"] == "WAI CHING"
    hit = result["hits"][0]
    print(f"   Found {result['total']} result for 'last_name:FOK': {hit['first_name']} {hit['last_name']}")

    resp = requests.get(f"{DATA_URL}/people/search", params={"q": "smith"}, timeout=10)
    resp.raise_for_status()
    result = resp.json()
    assert result["total"] == 1, f"Expected 1 result for 'smith', got {result['total']}"
    print(f"   Found {result['total']} result for 'smith'")

    print("\n✓ All integration tests passed!")


if __name__ == "__main__":
    main()
