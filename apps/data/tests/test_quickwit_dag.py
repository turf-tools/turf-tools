"""Hamilton tests for the Quickwit DAG.

The regular test exercises the DAG end-to-end on a 1,000-row sample. Two larger
benchmarks (100k and full-file) are available behind the
``RUN_QUICKWIT_BENCHMARKS=1`` env flag so they can be run manually without
slowing down the default test suite.
"""

from __future__ import annotations

import os
import shutil
import signal
import subprocess
import textwrap
import time
from contextlib import contextmanager
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

import pytest
from hamilton import driver

from src.dags import quickwit, voter_file_loader

VOTER_FILE_URL = str(
    Path(__file__).resolve().parents[1]
    / "fixtures"
    / "nys-voters-2026-03-08-10k-sample.parquet"
)


def _find_quickwit_binary() -> Path | None:
    """Prefer a repo-local v0.8.2 binary; fall back to whatever's on PATH."""
    local = Path(__file__).resolve().parents[3] / "quickwit-v0.8.2" / "quickwit"
    if local.exists():
        return local
    on_path = shutil.which("quickwit")
    return Path(on_path) if on_path else None


QUICKWIT_BINARY_PATH = _find_quickwit_binary()
QUICKWIT_INDEX_TEMPLATE_PATH = Path(__file__).resolve().parents[1] / "quickwit" / "persons.yaml"

BASE_TRANSFORMATION_QUERY = """
SELECT
    raw.sboe_id AS external_id,
    'ny_sboe' AS external_id_type,
    raw.first_name,
    raw.last_name,
    concat_ws(
        ' ',
        nullif(raw.res_house_number, ''),
        nullif(raw.res_half_code, ''),
        nullif(raw.res_pre_direction, ''),
        nullif(raw.res_street_name, ''),
        nullif(raw.res_post_direction, '')
    ) AS address_line_1,
    CASE
        WHEN raw.res_apartment IS NOT NULL AND raw.res_apartment != ''
        THEN concat_ws(' ', nullif(raw.res_apartment_type, ''), raw.res_apartment)
        ELSE NULL
    END AS address_line_2,
    raw.res_city AS city,
    'NY' AS state,
    raw.res_zip5 AS zip5,
    nullif(raw.res_zip4, '') AS zip4,
    to_json(
        {
            county_code: raw.county_code,
            status: raw.status
        }
    ) AS other_properties
FROM raw
"""


def _http_json(method: str, url: str, body: str | None = None, content_type: str | None = None) -> dict:
    request = Request(url, method=method)
    if body is not None:
        request.data = body.encode("utf-8")
    if content_type is not None:
        request.add_header("Content-Type", content_type)
    try:
        with urlopen(request, timeout=20) as response:
            payload = response.read().decode("utf-8")
            return {"status": response.status, "body": payload}
    except HTTPError as exc:
        return {"status": exc.code, "body": exc.read().decode("utf-8")}
    except URLError as exc:
        raise RuntimeError(f"HTTP request failed: {exc}") from exc


def _wait_for_server(endpoint: str, timeout: float = 30.0) -> None:
    deadline = time.time() + timeout
    last_error: Exception | None = None
    while time.time() < deadline:
        try:
            response = _http_json("GET", f"{endpoint}/api/v1/version")
            if response["status"] == 200:
                return
        except Exception as exc:  # noqa: BLE001
            last_error = exc
        time.sleep(0.2)
    raise RuntimeError(f"Quickwit server did not become ready: {last_error}")


@contextmanager
def _running_quickwit(binary_path: Path, config_path: Path) -> subprocess.Popen[str]:
    process = subprocess.Popen(  # noqa: S603
        [str(binary_path), "run", "--config", str(config_path)],
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
    )
    try:
        _wait_for_server("http://127.0.0.1:7280")
        yield process
    finally:
        if process.poll() is None:
            process.send_signal(signal.SIGTERM)
            try:
                process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=5)


def _write_quickwit_runtime(tmp_path: Path, index_id: str) -> tuple[Path, Path]:
    data_dir = tmp_path / "qwdata"
    data_dir.mkdir(parents=True, exist_ok=True)
    config_path = tmp_path / "quickwit.yaml"
    config_path.write_text(
        textwrap.dedent(
            f"""
            version: 0.7
            listen_address: 127.0.0.1
            rest:
              listen_port: 7280
            data_dir: {data_dir}
            """
        ).strip()
        + "\n",
        encoding="utf-8",
    )

    index_config_path = tmp_path / "index.yaml"
    index_config_path.write_text(
        QUICKWIT_INDEX_TEMPLATE_PATH.read_text(encoding="utf-8").replace("index_id: persons", f"index_id: {index_id}"),
        encoding="utf-8",
    )
    return config_path, index_config_path


def _create_index(endpoint: str, index_config_path: Path) -> None:
    response = _http_json(
        "POST",
        f"{endpoint}/api/v1/indexes",
        body=index_config_path.read_text(encoding="utf-8"),
        content_type="application/yaml",
    )
    if response["status"] not in {200, 201}:
        raise RuntimeError(f"Failed to create index: {response}")


def _describe_index(endpoint: str, index_id: str) -> str:
    response = _http_json("GET", f"{endpoint}/api/v1/indexes/{index_id}/describe")
    if response["status"] != 200:
        raise RuntimeError(f"Failed to describe index: {response}")
    return response["body"]


def _build_transformation_query(limit: int | None = None) -> str:
    if limit is None:
        return BASE_TRANSFORMATION_QUERY
    return f"{BASE_TRANSFORMATION_QUERY}\nLIMIT {limit}"


def _run_quickwit_benchmark(
    dual_conn,
    tmp_path: Path,
    organization_slug: str,
    row_limit: int | None,
    batch_size: int,
) -> dict:
    if QUICKWIT_BINARY_PATH is None or not QUICKWIT_BINARY_PATH.exists():
        raise RuntimeError(
            "Quickwit binary not found. Install from https://install.quickwit.io "
            "or drop the v0.8.2 tarball at <repo>/quickwit-v0.8.2/."
        )

    index_id = f"{organization_slug}-index"
    config_path, index_config_path = _write_quickwit_runtime(tmp_path, index_id)
    endpoint = "http://127.0.0.1:7280"

    with _running_quickwit(QUICKWIT_BINARY_PATH, config_path):
        _create_index(endpoint, index_config_path)

    loader_driver = driver.Builder().with_modules(voter_file_loader).build()
    loader_start = time.perf_counter()
    loader_result = loader_driver.execute(
        final_vars=["validated_persons"],
        inputs={
            "voter_file_url": VOTER_FILE_URL,
            "organization_slug": organization_slug,
            "transformation_query": _build_transformation_query(row_limit),
            "conn": dual_conn,
        },
    )
    loader_elapsed = time.perf_counter() - loader_start
    validated_persons = loader_result["validated_persons"]

    quickwit_driver = driver.Builder().with_modules(quickwit).build()
    ingest_start = time.perf_counter()
    ingest_result = quickwit_driver.execute(
        final_vars=["quickwit_build_manifest_stub"],
        inputs={
            "persons_table_ref": validated_persons,
            "quickwit_binary_path": str(QUICKWIT_BINARY_PATH),
            "quickwit_config_path": str(config_path),
            "quickwit_index_id": index_id,
            "quickwit_batch_size": batch_size,
            "conn": dual_conn,
        },
    )["quickwit_build_manifest_stub"]
    ingest_elapsed = time.perf_counter() - ingest_start

    with _running_quickwit(QUICKWIT_BINARY_PATH, config_path):
        describe_body = _describe_index(endpoint, index_id)

    return {
        "organization_slug": organization_slug,
        "row_limit": row_limit,
        "batch_size": batch_size,
        "loader_elapsed_seconds": loader_elapsed,
        "ingest_elapsed_seconds": ingest_elapsed,
        "manifest_stub": ingest_result,
        "describe_body": describe_body,
    }


class TestQuickwitGraph:
    def test_quickwit_graph_via_hamilton_driver(self, dual_conn, tmp_path):
        """Quickwit DAG should index a 1,000-row voter sample into an existing index."""
        result = _run_quickwit_benchmark(
            dual_conn=dual_conn,
            tmp_path=tmp_path,
            organization_slug="quickwit_test_sample",
            row_limit=1_000,
            batch_size=500,
        )

        manifest_stub = result["manifest_stub"]
        assert manifest_stub.indexed_doc_count == 1_000
        assert manifest_stub.batch_count == 2
        assert manifest_stub.manifest_written is False
        assert '"num_published_docs":1000' in result["describe_body"].replace(" ", "")


@pytest.mark.skipif(
    os.getenv("RUN_QUICKWIT_BENCHMARKS") != "1",
    reason="manual benchmark; set RUN_QUICKWIT_BENCHMARKS=1 to run",
)
def test_quickwit_benchmark_100k(dual_conn, tmp_path):
    result = _run_quickwit_benchmark(
        dual_conn=dual_conn,
        tmp_path=tmp_path,
        organization_slug="quickwit_benchmark_100k",
        row_limit=100_000,
        batch_size=25_000,
    )
    print(
        "\n100k benchmark:",
        {
            "loader_elapsed_seconds": round(result["loader_elapsed_seconds"], 2),
            "ingest_elapsed_seconds": round(result["ingest_elapsed_seconds"], 2),
            "indexed_doc_count": result["manifest_stub"].indexed_doc_count,
            "batch_count": result["manifest_stub"].batch_count,
        },
        flush=True,
    )


@pytest.mark.skipif(
    os.getenv("RUN_QUICKWIT_BENCHMARKS") != "1",
    reason="manual benchmark; set RUN_QUICKWIT_BENCHMARKS=1 to run",
)
def test_quickwit_benchmark_full_file(dual_conn, tmp_path):
    result = _run_quickwit_benchmark(
        dual_conn=dual_conn,
        tmp_path=tmp_path,
        organization_slug="quickwit_benchmark_full",
        row_limit=None,
        batch_size=100_000,
    )
    print(
        "\nFull-file benchmark:",
        {
            "loader_elapsed_seconds": round(result["loader_elapsed_seconds"], 2),
            "ingest_elapsed_seconds": round(result["ingest_elapsed_seconds"], 2),
            "indexed_doc_count": result["manifest_stub"].indexed_doc_count,
            "batch_count": result["manifest_stub"].batch_count,
        },
        flush=True,
    )


@pytest.mark.skipif(
    os.getenv("RUN_QUICKWIT_BENCHMARKS") != "1",
    reason="manual benchmark; set RUN_QUICKWIT_BENCHMARKS=1 to run",
)
@pytest.mark.parametrize("batch_size", [1_000_000, 2_000_000, 5_000_000])
def test_quickwit_benchmark_full_file_batch_sizes(dual_conn, tmp_path, batch_size):
    result = _run_quickwit_benchmark(
        dual_conn=dual_conn,
        tmp_path=tmp_path,
        organization_slug=f"quickwit_full_{batch_size}",
        row_limit=None,
        batch_size=batch_size,
    )
    print(
        "\nFull-file batch-size benchmark:",
        {
            "batch_size": batch_size,
            "loader_elapsed_seconds": round(result["loader_elapsed_seconds"], 2),
            "ingest_elapsed_seconds": round(result["ingest_elapsed_seconds"], 2),
            "indexed_doc_count": result["manifest_stub"].indexed_doc_count,
            "batch_count": result["manifest_stub"].batch_count,
        },
        flush=True,
    )


@pytest.mark.skipif(
    os.getenv("RUN_QUICKWIT_BENCHMARKS") != "1",
    reason="manual benchmark; set RUN_QUICKWIT_BENCHMARKS=1 to run",
)
@pytest.mark.parametrize("batch_size", [25_000, 50_000, 100_000, 250_000, 500_000, 1_000_000, 2_000_000])
def test_quickwit_benchmark_2m_batch_sizes(dual_conn, tmp_path, batch_size):
    result = _run_quickwit_benchmark(
        dual_conn=dual_conn,
        tmp_path=tmp_path,
        organization_slug=f"quickwit_benchmark_2m_{batch_size}",
        row_limit=2_000_000,
        batch_size=batch_size,
    )
    print(
        "\n2M benchmark:",
        {
            "batch_size": batch_size,
            "loader_elapsed_seconds": round(result["loader_elapsed_seconds"], 2),
            "ingest_elapsed_seconds": round(result["ingest_elapsed_seconds"], 2),
            "indexed_doc_count": result["manifest_stub"].indexed_doc_count,
            "batch_count": result["manifest_stub"].batch_count,
        },
        flush=True,
    )
