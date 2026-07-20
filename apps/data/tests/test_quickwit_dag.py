"""Integration test for the Quickwit person-search path.

Stands up a throwaway Quickwit — its own Postgres metastore database, data dir,
and port — indexes a handful of synthetic persons through the real DAG
`local-ingest` node, and searches the live searcher. This is the exact
create-index → local-ingest → serve flow the import uses (and the same
Postgres-metastore concurrency the spike validated), on ~5 rows.

Skips when the `quickwit` binary isn't on PATH, so a machine without it (some CI)
doesn't fail — it runs locally, where `pnpm dev:search` needs the binary anyway.
"""

from __future__ import annotations

import asyncio
import os
import shutil
import signal
import socket
import subprocess
import textwrap
import time
import types
import urllib.parse
from contextlib import closing, contextmanager
from pathlib import Path  # noqa: TC003 — used at runtime in fixtures

import pytest
from hamilton import driver

from src import quickwit as qw_client
from src.dags import quickwit
from src.models import TableRef
from src.settings import get_settings

pytestmark = [
    pytest.mark.integration,
    pytest.mark.skipif(shutil.which("quickwit") is None, reason="quickwit binary not on PATH"),
]

# A handful of persons with overlapping names/addresses so searches are unambiguous.
_SAMPLE = [
    # external_id, ext_type, first, last, addr1, addr2, city, state, zip5, zip4
    ("id1", "test", "JANE", "DOE", "1 MAIN STREET", None, "NEW YORK", "NY", "10001", None),
    ("id2", "test", "JOHN", "SMITH", "2 OAK AVENUE", None, "NEW YORK", "NY", "10002", None),
    ("id3", "test", "JANE", "SMITH", "3 ELM STREET", None, "NEW YORK", "NY", "10003", None),
    ("id4", "test", "MARIA", "GARCIA", "4 PINE STREET", None, "BROOKLYN", "NY", "11201", None),
    ("id5", "test", "JOHN", "DOE", "5 MAIN STREET", None, "BROOKLYN", "NY", "11202", None),
]


def _free_port() -> int:
    with closing(socket.socket(socket.AF_INET, socket.SOCK_STREAM)) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def _run_async(coro) -> None:
    asyncio.new_event_loop().run_until_complete(coro)


@contextmanager
def _metastore_db(admin_url: str, name: str):
    """Create a throwaway Postgres database for Quickwit's metastore; drop it
    (forcing off any lingering connections) on exit."""
    import asyncpg

    async def _create():
        conn = await asyncpg.connect(admin_url)
        try:
            await conn.execute(f'DROP DATABASE IF EXISTS "{name}" WITH (FORCE)')
            await conn.execute(f'CREATE DATABASE "{name}"')
        finally:
            await conn.close()

    async def _drop():
        conn = await asyncpg.connect(admin_url)
        try:
            await conn.execute(f'DROP DATABASE IF EXISTS "{name}" WITH (FORCE)')
        finally:
            await conn.close()

    _run_async(_create())
    try:
        yield urllib.parse.urlparse(admin_url)._replace(path=f"/{name}").geturl()
    finally:
        _run_async(_drop())


def _write_config(tmp_path: Path, port: int, metastore_uri: str) -> Path:
    data_dir = tmp_path / "qwdata"
    data_dir.mkdir(parents=True, exist_ok=True)
    config = tmp_path / "quickwit.yaml"
    config.write_text(
        textwrap.dedent(f"""
            version: 0.7
            listen_address: 127.0.0.1
            rest:
              listen_port: {port}
            data_dir: {data_dir}
            metastore_uri: {metastore_uri}
        """).strip()
        + "\n",
        encoding="utf-8",
    )
    return config


@contextmanager
def _running_searcher(config_path: Path, endpoint: str):
    proc = subprocess.Popen(  # noqa: S603
        ["quickwit", "run", "--config", str(config_path)],  # noqa: S607
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        env={**os.environ, "QW_DISABLE_TELEMETRY": "1"},
    )
    try:
        deadline = time.time() + 40
        while time.time() < deadline:
            try:
                if qw_client._request("GET", f"{endpoint}/health/livez")[0] == 200:
                    break
            except Exception:  # noqa: BLE001
                pass
            time.sleep(0.3)
        else:
            raise RuntimeError("quickwit did not become ready")
        yield
    finally:
        proc.send_signal(signal.SIGTERM)
        try:
            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait(timeout=5)


def _seed_table(conn) -> TableRef:
    values = ",\n".join("(" + ", ".join("NULL" if v is None else f"'{v}'" for v in row) + ")" for row in _SAMPLE)
    conn.execute(f"""
        CREATE OR REPLACE TABLE memory.main.persons_tiny AS
        SELECT * FROM (VALUES {values}) AS t(
            external_id, external_id_type, first_name, last_name,
            address_line_1, address_line_2, city, state, zip5, zip4
        )
    """)
    return TableRef(catalog="memory", schema="main", table="persons_tiny", version=0)


def test_quickwit_index_and_search(dual_conn, tmp_path):
    """create-index → local-ingest a tiny sample → the live searcher serves it."""
    settings = get_settings()
    port = _free_port()
    endpoint = f"http://127.0.0.1:{port}"
    index_id = "persons_qwtest"

    qw_settings = types.SimpleNamespace(quickwit_url=endpoint)
    with _metastore_db(settings.database_url, "quickwit_test") as metastore_uri:
        config_path = _write_config(tmp_path, port, metastore_uri)
        with _running_searcher(config_path, endpoint):
            # Create the per-version index, then bulk-index the sample via the real
            # DAG node — concurrently with the running searcher (safe on Postgres).
            qw_client.ensure_index(qw_settings, index_id)
            persons_ref = _seed_table(dual_conn)
            result = (
                driver.Builder()
                .with_modules(quickwit)
                .build()
                .execute(
                    final_vars=["quickwit_build_manifest_stub"],
                    inputs={
                        "persons_table_ref": persons_ref,
                        "quickwit_binary_path": "quickwit",
                        "quickwit_config_path": str(config_path),
                        "quickwit_index_id": index_id,
                        "quickwit_batch_size": 2,
                        "conn": dual_conn,
                    },
                )["quickwit_build_manifest_stub"]
            )
            assert result.indexed_doc_count == 5
            assert result.batch_count == 3  # ceil(5 / 2)

            # The already-running searcher picks up the published splits.
            deadline = time.time() + 30
            while time.time() < deadline:
                if qw_client.search(qw_settings, index_id, "state:NY")["numHits"] == 5:
                    break
                time.sleep(0.5)
            else:
                pytest.fail("indexed docs never became searchable")

            assert qw_client.search(qw_settings, index_id, "last_name:DOE")["numHits"] == 2
            assert qw_client.search(qw_settings, index_id, "first_name:JANE AND last_name:SMITH")["numHits"] == 1
            main_st = qw_client.search(qw_settings, index_id, "address_line_1:MAIN")
            assert main_st["numHits"] == 2
            assert {h["first_name"] for h in main_st["hits"]} == {"JANE", "JOHN"}

            # Alphabetical (last, first) order via the packed u64 sort keys. On
            # 0.8.2 the `-` prefix ascends, so this is A→Z.
            ordered = qw_client.search(
                qw_settings, index_id, "state:NY", sort_by="-sort_key_hi,-sort_key_lo"
            )
            assert [(h["last_name"], h["first_name"]) for h in ordered["hits"]] == [
                ("DOE", "JANE"),
                ("DOE", "JOHN"),
                ("GARCIA", "MARIA"),
                ("SMITH", "JANE"),
                ("SMITH", "JOHN"),
            ]

            # A version with no index yet returns empty rather than erroring.
            assert qw_client.search(qw_settings, "persons_does_not_exist", "state:NY") == {"numHits": 0, "hits": []}
