import tempfile
from pathlib import Path

import pytest

import duckdb
from src.duckdb import OPERATIONAL_PG_ALIAS


@pytest.fixture()
def operational_conn():
    """In-memory DuckDB with a synthetic operational-Postgres catalog.

    Endpoint SQL names operational tables through OPERATIONAL_PG_ALIAS;
    attaching a memory catalog under that alias runs the exact
    production SQL with no Postgres. Tests create the app.* tables they
    need.
    """
    c = duckdb.connect()
    c.execute(f"ATTACH ':memory:' AS {OPERATIONAL_PG_ALIAS}")
    c.execute(f"CREATE SCHEMA {OPERATIONAL_PG_ALIAS}.app")
    yield c
    c.close()


@pytest.fixture()
def conn():
    """Create an isolated DuckLake connection using a temp directory."""
    with tempfile.TemporaryDirectory() as tmpdir:
        c = duckdb.connect()
        c.install_extension("ducklake")
        c.load_extension("ducklake")
        catalog = f"{tmpdir}/test.ducklake"
        data_dir = f"{tmpdir}/data/"
        c.execute(f"ATTACH 'ducklake:{catalog}' AS ducklake (DATA_PATH '{data_dir}')")
        c.execute("USE ducklake")
        yield c
        c.close()


@pytest.fixture()
def dual_conn():
    """Create an isolated connection with both ducklake and ducklake_geo attached.

    Mirrors the production setup in db.get_connection() but uses temp directories
    so tests are fully isolated and leave no state on disk.
    """
    with tempfile.TemporaryDirectory() as tmpdir:
        c = duckdb.connect()
        c.install_extension("ducklake")
        c.load_extension("ducklake")
        c.install_extension("spatial")
        c.load_extension("spatial")

        # Voter catalog
        catalog = f"{tmpdir}/test.ducklake"
        data_dir = f"{tmpdir}/data/"
        c.execute(f"ATTACH 'ducklake:{catalog}' AS ducklake (DATA_PATH '{data_dir}')")

        # Geo catalog
        geo_catalog = f"{tmpdir}/geo_test.ducklake"
        geo_data_dir = f"{tmpdir}/geo_data/"
        c.execute(f"ATTACH 'ducklake:{geo_catalog}' AS ducklake_geo (DATA_PATH '{geo_data_dir}')")

        c.execute("USE ducklake")
        yield c
        c.close()


@pytest.fixture(scope="session")
def tiger_cache_dir() -> str:
    """Shared on-disk TIGER cache reused across borough tests."""
    path = Path(__file__).parent.parent / "tiger_cache"
    path.mkdir(parents=True, exist_ok=True)
    return str(path)


@pytest.fixture(scope="session")
def osm_cache_dir() -> str:
    """Shared on-disk OSM PBF cache reused across pipeline tests.

    Points at apps/data/osm_cache by default so the dev seed-persons cache
    is reused. First run downloads ~500MB; subsequent runs are cache hits.
    """
    path = Path(__file__).parent.parent / "osm_cache"
    path.mkdir(parents=True, exist_ok=True)
    return str(path)
