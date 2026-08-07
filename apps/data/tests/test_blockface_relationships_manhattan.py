"""Real-data test: relationship derivation on Manhattan TIGER, zip 10003.

Loads the cached Manhattan (county 061) TIGER shapefiles into an
isolated tempdir DuckLake and derives blockface relationships scoped to
zip 10003 (East Village). Golden counts captured 2026-07-03 against
TIGER 2024; re-baseline (with an explanation in the PR description)
when the crossing-cost table or classification rules intentionally
change.

Skips when the TIGER cache is cold so the default suite never hits the
network — run the full pipeline integration test (or `seed-persons`)
once to warm `apps/data/tiger_cache/`.

The whole module (load + two derivations + assertions) runs in a few
seconds; a hard 30s ceiling on the scoped derivation guards against
pathological regressions (e.g. accidentally classifying every node in
the county per zip).
"""

import tempfile
import time
from pathlib import Path

import pytest

import duckdb
from src.dags.blockface_relationships import blockface_relationships
from src.dags.tiger import blockface_unpivoted, tiger_addrfeat_raw, tiger_edges_raw

ZIP = "10003"

# Golden numbers captured 2026-07-03, TIGER 2024, county 36061, zip 10003.
GOLDEN = {
    "blockfaces_in_zip": 461,
    "total_rows": 1907,
    "kinds": {"turn": 588, "kitty_corner": 421, "hinge": 386, "continue": 333, "across": 179},
    "penalties": {"minor": 1521, "none": 386},
    # 2 blockfaces are isolated (no relationships) — disconnected
    # fragments at the zip edge.
    "blockfaces_with_relationships": 459,
}

MAX_DERIVATION_SECONDS = 30.0


def _cache_warm(tiger_cache_dir: str) -> bool:
    cache = Path(tiger_cache_dir)
    return (cache / "addrfeat" / "tl_2024_36061_addrfeat.zip").exists() and (
        cache / "edges" / "tl_2024_36061_edges.zip"
    ).exists()


@pytest.fixture(scope="module")
def manhattan(tiger_cache_dir):
    """Manhattan blockfaces + edges in a tempdir DuckLake, plus the
    zip-scoped relationships table. Module-scoped: one load, all tests."""
    if not _cache_warm(tiger_cache_dir):
        pytest.skip("TIGER cache for county 36061 not present; warm it via the pipeline integration test.")

    with tempfile.TemporaryDirectory() as tmpdir:
        conn = duckdb.connect()
        for ext in ("ducklake", "spatial"):
            conn.install_extension(ext)
            conn.load_extension(ext)
        conn.execute(f"ATTACH 'ducklake:{tmpdir}/geo.ducklake' AS ducklake_geo (DATA_PATH '{tmpdir}/geo_data/')")
        conn.execute(f"ATTACH 'ducklake:{tmpdir}/voter.ducklake' AS ducklake (DATA_PATH '{tmpdir}/voter_data/')")
        conn.execute("USE ducklake")

        addrfeat = tiger_addrfeat_raw("2024", "36", ["061"], tiger_cache_dir, conn)
        edges = tiger_edges_raw("2024", "36", ["061"], tiger_cache_dir, conn)
        unpivoted = blockface_unpivoted(addrfeat, edges, conn)

        started = time.time()
        rels = blockface_relationships(unpivoted, edges, conn, [ZIP])
        elapsed = time.time() - started

        yield {"conn": conn, "unpivoted": unpivoted, "rels": rels, "elapsed": elapsed}
        conn.close()


def test_derivation_stays_inside_the_time_budget(manhattan):
    assert manhattan["elapsed"] < MAX_DERIVATION_SECONDS


def test_golden_counts(manhattan):
    conn, rels, unpivoted = manhattan["conn"], manhattan["rels"], manhattan["unpivoted"]
    n_bf = conn.execute(
        f"SELECT count(DISTINCT blockface_id) FROM {unpivoted.fqn} WHERE zip_code = ?", [ZIP]
    ).fetchone()[0]
    assert n_bf == GOLDEN["blockfaces_in_zip"]
    assert conn.execute(f"SELECT count(*) FROM {rels.fqn}").fetchone()[0] == GOLDEN["total_rows"]
    kinds = dict(conn.execute(f"SELECT kind, count(*) FROM {rels.fqn} GROUP BY 1").fetchall())
    assert kinds == GOLDEN["kinds"]
    penalties = dict(conn.execute(f"SELECT penalty_class, count(*) FROM {rels.fqn} GROUP BY 1").fetchall())
    assert penalties == GOLDEN["penalties"]


def test_structural_invariants(manhattan):
    conn, rels = manhattan["conn"], manhattan["rels"]
    fqn = rels.fqn

    # Pair ids are normalized and (a, b, node) is unique.
    assert conn.execute(f"SELECT count(*) FROM {fqn} WHERE blockface_id_a >= blockface_id_b").fetchone()[0] == 0
    assert (
        conn.execute(f"""
            SELECT count(*) FROM (
                SELECT 1 FROM {fqn}
                GROUP BY blockface_id_a, blockface_id_b, node_id HAVING count(*) > 1
            )
        """).fetchone()[0]
        == 0
    )

    # Kind semantics.
    assert (
        conn.execute(f"""
            SELECT count(*) FROM {fqn}
            WHERE kind = 'hinge' AND (crossing_cost_m != 0 OR len(crossed_line_ids) != 0 OR penalty_class != 'none')
        """).fetchone()[0]
        == 0
    )
    assert (
        conn.execute(f"""
            SELECT count(*) FROM {fqn}
            WHERE kind = 'across'
              AND (node_id IS NOT NULL
                   OR len(crossed_line_ids) != 1
                   OR crossed_line_ids[1] != split_part(blockface_id_a, ':', 1))
        """).fetchone()[0]
        == 0
    )
    assert conn.execute(f"SELECT count(*) FROM {fqn} WHERE kind != 'across' AND node_id IS NULL").fetchone()[0] == 0
    assert (
        conn.execute(
            f"SELECT count(*) FROM {fqn} WHERE kind = 'kitty_corner' AND len(crossed_line_ids) != 2"
        ).fetchone()[0]
        == 0
    )
    assert (
        conn.execute(f"SELECT count(*) FROM {fqn} WHERE len(crossed_line_ids) != len(crossed_classes)").fetchone()[0]
        == 0
    )

    # Every relationship endpoint is a blockface in the scoped zip.
    unpivoted = manhattan["unpivoted"]
    assert (
        conn.execute(f"""
            SELECT count(*) FROM (
                SELECT blockface_id_a AS id FROM {fqn} UNION SELECT blockface_id_b FROM {fqn}
            )
            WHERE id NOT IN (SELECT blockface_id FROM {unpivoted.fqn} WHERE zip_code = '{ZIP}')
        """).fetchone()[0]
        == 0
    )


def test_nearly_every_blockface_participates(manhattan):
    conn, rels = manhattan["conn"], manhattan["rels"]
    n = conn.execute(f"""
        SELECT count(DISTINCT id) FROM (
            SELECT blockface_id_a AS id FROM {rels.fqn} UNION SELECT blockface_id_b FROM {rels.fqn}
        )
    """).fetchone()[0]
    assert n == GOLDEN["blockfaces_with_relationships"]
