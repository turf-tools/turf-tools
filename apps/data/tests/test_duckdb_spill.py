"""The connection builder's spill setup, exercised through a real spill.

Regression: DuckDB only creates the temp_directory *leaf*, so a missing parent
(fresh box, empty /tmp) surfaced as `IOException: Failed to create directory`
at the first operator that went out-of-core — mid-import, at the widest join.
The builder now pre-creates the whole path.
"""

from __future__ import annotations


def test_spill_directory_is_created_and_usable(tmp_path, monkeypatch):
    from src.duckdb import _build_connection
    from src.settings import Settings

    monkeypatch.chdir(tmp_path)  # local-file catalogs land in the tmp dir
    base = tmp_path / "not" / "yet" / "created"
    monkeypatch.setenv("DUCKDB_TEMP_DIRECTORY", str(base))
    settings = Settings(ducklake_metadata_postgres_url=None, ducklake_geo_metadata_postgres_url=None)

    conn = _build_connection(settings, read_only=False)
    try:
        conn.execute("SET memory_limit = '128MB'")
        # Per-thread sort buffers set the op's memory floor even when spilling;
        # the default 12 threads can't fit under a 128MB test limit.
        conn.execute("SET threads = 2")
        # A window sort over ~300MB of generated rows: operator state (unlike
        # in-memory table blocks) is spillable, so this must go out-of-core
        # through the temp dir rather than OOM.
        count = conn.execute("""
            SELECT max(rn) FROM (
                SELECT row_number() OVER (ORDER BY s, i) AS rn
                FROM (SELECT range AS i, repeat('x', 120) AS s FROM range(2000000))
            )
        """).fetchone()[0]
    finally:
        conn.close()

    assert count == 2_000_000
    assert base.exists()
