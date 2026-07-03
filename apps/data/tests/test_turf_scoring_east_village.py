"""Real-data validation: score the manually-cut East Village sample.

The sample cut (186 turfs, ~80 doors each) was made by a human and is
known-good. The scorer must (a) give it a sane score with no broken
turfs, (b) rank most small perturbations of it as worse, and (c) rank a
random partition as dramatically worse.

Thresholds are deliberately looser than the measured values (2026-07-03:
zone 10.35, moves 81/100 worse, swaps 100/100 worse, random partition
20.7x) so the test asserts the *shape* of the scoring landscape, not
exact numbers — the manual cut is good, not assumed optimal, and a
scorer that ranked it as unbeatable would be overfit.

Runs in ~10s; skips when the TIGER cache is cold.
"""

import json
import random
import tempfile
import time
from pathlib import Path

import pytest

import duckdb
from src.dags.blockface_relationships import blockface_relationships
from src.dags.tiger import blockface_unpivoted, tiger_addrfeat_raw, tiger_edges_raw
from src.turf_scoring import load_blockface_graph, score_zone

FIXTURE = Path(__file__).resolve().parents[1] / "fixtures" / "sample-turf-east-village.json"

MAX_SETUP_AND_SCORE_SECONDS = 30.0
PERTURBATION_TRIALS = 60


def _cache_warm(tiger_cache_dir: str) -> bool:
    cache = Path(tiger_cache_dir)
    return (cache / "addrfeat" / "tl_2024_36061_addrfeat.zip").exists() and (
        cache / "edges" / "tl_2024_36061_edges.zip"
    ).exists()


@pytest.fixture(scope="module")
def setup(tiger_cache_dir):
    if not _cache_warm(tiger_cache_dir):
        pytest.skip("TIGER cache for county 36061 not present; warm it via the pipeline integration test.")

    started = time.time()
    with open(FIXTURE) as f:
        data = json.load(f)
    buildings = {b["buildingId"]: b for b in data["buildings"]}
    assignment = {bid: t["turfId"] for t in data["turfs"] for bid in t["buildingIds"]}

    with tempfile.TemporaryDirectory() as tmpdir:
        conn = duckdb.connect()
        for ext in ("ducklake", "spatial"):
            conn.install_extension(ext)
            conn.load_extension(ext)
        conn.execute(f"ATTACH 'ducklake:{tmpdir}/geo.ducklake' AS geo_ducklake (DATA_PATH '{tmpdir}/geo_data/')")
        conn.execute(f"ATTACH 'ducklake:{tmpdir}/voter.ducklake' AS ducklake (DATA_PATH '{tmpdir}/voter_data/')")
        conn.execute("USE ducklake")
        addrfeat = tiger_addrfeat_raw("2024", "36", ["061"], tiger_cache_dir, conn)
        edges = tiger_edges_raw("2024", "36", ["061"], tiger_cache_dir, conn)
        unpivoted = blockface_unpivoted(addrfeat, edges, conn)
        rels = blockface_relationships(unpivoted, edges, conn, None)
        graph = load_blockface_graph(conn, unpivoted, rels)
        conn.close()

    def build_turfs(assign: dict[str, str]) -> dict[str, list[tuple[str, int]]]:
        turfs: dict[str, list[tuple[str, int]]] = {}
        for bid, tid in assign.items():
            b = buildings[bid]
            turfs.setdefault(tid, []).append((b["blockfaceId"], b["doorCount"]))
        return turfs

    base = score_zone(graph, build_turfs(assignment))
    yield {
        "graph": graph,
        "buildings": buildings,
        "assignment": assignment,
        "build_turfs": build_turfs,
        "base": base,
        "elapsed": time.time() - started,
    }


def test_setup_and_scoring_stay_inside_the_time_budget(setup):
    assert setup["elapsed"] < MAX_SETUP_AND_SCORE_SECONDS


def test_manual_cut_scores_sane(setup):
    base = setup["base"]
    assert len(base.turfs) == 186
    # Every turf priced from real graph paths — nothing near the
    # broken-turf sentinel, worst turf within a plausible walking range.
    assert base.zone_score < 20.0
    assert base.worst_score < 60.0
    assert base.mean_score < base.zone_score  # power mean sits above the mean
    # The Euclidean fallback exists for park-facing blockfaces cut off
    # from the addressable graph; it must stay rare.
    assert setup["graph"].fallback_pairs < 30


def test_moving_buildings_between_turfs_usually_worsens(setup):
    # Gentlest realistic perturbation: move one building into the turf
    # of its nearest neighbor in another turf. The manual cut is good,
    # not optimal — some moves may genuinely improve it — but most must
    # rank worse.
    rng = random.Random(42)
    assignment, buildings = setup["assignment"], setup["buildings"]
    coords = {bid: (b["lng"], b["lat"]) for bid, b in buildings.items()}
    bids = sorted(assignment)

    def nearest_other_turf(bid: str, assign: dict[str, str]) -> str:
        x0, y0 = coords[bid]
        best = None
        for other, tid in assign.items():
            if tid == assign[bid]:
                continue
            x, y = coords[other]
            # ~NYC latitude: 1 deg lat is ~1.32x a deg of lng in meters.
            d = (x - x0) ** 2 + ((y - y0) * 1.32) ** 2
            if best is None or d < best[0]:
                best = (d, tid)
        return best[1]

    worse = 0
    for _ in range(PERTURBATION_TRIALS):
        assign = dict(assignment)
        bid = rng.choice(bids)
        assign[bid] = nearest_other_turf(bid, assign)
        z = score_zone(setup["graph"], setup["build_turfs"](assign))
        if z.zone_score > setup["base"].zone_score:
            worse += 1
    assert worse >= 0.70 * PERTURBATION_TRIALS


def test_swapping_buildings_between_turfs_almost_always_worsens(setup):
    rng = random.Random(42)
    assignment = setup["assignment"]
    bids = sorted(assignment)
    worse = 0
    for _ in range(PERTURBATION_TRIALS):
        assign = dict(assignment)
        b1, b2 = rng.sample(bids, 2)
        while assign[b1] == assign[b2]:
            b1, b2 = rng.sample(bids, 2)
        assign[b1], assign[b2] = assign[b2], assign[b1]
        z = score_zone(setup["graph"], setup["build_turfs"](assign))
        if z.zone_score > setup["base"].zone_score:
            worse += 1
    assert worse >= 0.90 * PERTURBATION_TRIALS


def test_random_partition_is_dramatically_worse(setup):
    rng = random.Random(42)
    assignment = setup["assignment"]
    bids = sorted(assignment)
    shuffled = bids[:]
    rng.shuffle(shuffled)
    assign = {nb: assignment[ob] for nb, ob in zip(shuffled, bids, strict=True)}
    z = score_zone(setup["graph"], setup["build_turfs"](assign))
    assert z.zone_score > 5.0 * setup["base"].zone_score
