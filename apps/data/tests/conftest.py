import tempfile

import duckdb
import pytest


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
