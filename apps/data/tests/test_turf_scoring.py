"""Unit tests for turf scoring on hand-built blockface graphs."""

import pytest

from src.settings import TurfScoreSettings
from src.turf_scoring import BlockfaceGraph, score_turf, score_zone, turf_walk_cost


def _chain_graph() -> BlockfaceGraph:
    """A, B, C, D in a row (100m each), free hinges between neighbors."""
    lengths = {"A": 100.0, "B": 100.0, "C": 100.0, "D": 100.0}
    edges = [("A", "B", 0.0), ("B", "C", 0.0), ("C", "D", 0.0)]
    return BlockfaceGraph(lengths, edges)


class TestWalkCost:
    def test_single_blockface_has_no_transitions(self):
        walk, trans = turf_walk_cost(_chain_graph(), {"B": (0.0, 100.0)})
        assert (walk, trans) == (100.0, 0.0)

    def test_adjacent_chain_is_lengths_only(self):
        walk, trans = turf_walk_cost(
            _chain_graph(),
            {"A": (0.0, 100.0), "B": (0.0, 100.0), "C": (0.0, 100.0)},
        )
        assert walk == 300.0
        assert trans == 0.0

    def test_gap_pays_the_skipped_blockface(self):
        # Turf {A, C}: getting from A to C walks along B (100m).
        walk, trans = turf_walk_cost(_chain_graph(), {"A": (0.0, 100.0), "C": (0.0, 100.0)})
        assert walk == 200.0
        assert trans == 100.0

    def test_direct_crossing_beats_detour(self):
        # A and C also touch directly (e.g. kitty-corner, 30m-equivalent):
        # cheaper than walking the 100m of B.
        lengths = {"A": 100.0, "B": 100.0, "C": 100.0}
        edges = [("A", "B", 0.0), ("B", "C", 0.0), ("A", "C", 30.0)]
        g = BlockfaceGraph(lengths, edges)
        _, trans = turf_walk_cost(g, {"A": (0.0, 100.0), "C": (0.0, 100.0)})
        assert trans == 30.0

    def test_crossing_costs_accumulate_along_chain(self):
        lengths = {"A": 100.0, "B": 100.0, "C": 100.0}
        edges = [("A", "B", 15.0), ("B", "C", 60.0)]
        g = BlockfaceGraph(lengths, edges)
        _, trans = turf_walk_cost(
            g,
            {"A": (0.0, 100.0), "B": (0.0, 100.0), "C": (0.0, 100.0)},
        )
        assert trans == 75.0  # best chain A->B->C from either end

    def test_greedy_picks_the_best_start(self):
        # Starting mid-chain forces a doubled-back transition; starting
        # at an end walks straight through. Best-of-starts must find it.
        walk, trans = turf_walk_cost(
            _chain_graph(),
            {bf: (0.0, 100.0) for bf in ("A", "B", "C", "D")},
        )
        assert trans == 0.0

    def test_disconnected_pair_falls_back_to_euclidean_detour(self):
        lengths = {"A": 100.0, "Z": 50.0}
        midpoints = {"A": (0.0, 0.0), "Z": (300.0, 400.0)}  # 500m apart
        g = BlockfaceGraph(lengths, [], midpoints)
        _, trans = turf_walk_cost(g, {"A": (0.0, 100.0), "Z": (0.0, 50.0)})
        assert trans == 500.0 * g.euclidean_detour_factor
        assert g.fallback_pairs == 1

    def test_disconnected_pair_without_geometry_pays_the_broken_hop(self):
        lengths = {"A": 100.0, "Z": 50.0}
        g = BlockfaceGraph(lengths, [])
        _, trans = turf_walk_cost(g, {"A": (0.0, 100.0), "Z": (0.0, 50.0)})
        assert trans == g.unreachable_transition_m
        assert g.fallback_pairs == 0

    def test_connected_pair_never_uses_the_fallback(self):
        lengths = {"A": 100.0, "B": 100.0}
        midpoints = {"A": (0.0, 0.0), "B": (1.0, 0.0)}
        g = BlockfaceGraph(lengths, [("A", "B", 60.0)], midpoints)
        _, trans = turf_walk_cost(g, {"A": (0.0, 100.0), "B": (0.0, 100.0)})
        assert trans == 60.0  # graph cost, even though euclid*factor is smaller
        assert g.fallback_pairs == 0

    def test_unknown_blockface_raises(self):
        with pytest.raises(KeyError):
            turf_walk_cost(_chain_graph(), {"A": (0.0, 100.0), "NOPE": (0.0, 1.0)})

    def test_min_cost_edge_wins_duplicate_relationships(self):
        # A pair can relate at two nodes; the graph must keep the min.
        lengths = {"A": 100.0, "B": 100.0}
        g = BlockfaceGraph(lengths, [("A", "B", 60.0), ("A", "B", 0.0)])
        _, trans = turf_walk_cost(g, {"A": (0.0, 100.0), "B": (0.0, 100.0)})
        assert trans == 0.0


class TestScores:
    def test_score_is_cost_per_door(self):
        s = score_turf(
            _chain_graph(),
            "t1",
            [("A", 20, 0.0), ("A", 10, 100.0), ("B", 15, 0.0), ("B", 15, 100.0)],
        )
        assert s.doors == 60
        assert s.walk_m == 200.0
        assert s.transition_m == 0.0
        assert s.score == pytest.approx(200.0 / 60)

    def test_zero_doors_raises(self):
        with pytest.raises(ValueError, match="no doors"):
            score_turf(_chain_graph(), "t1", [("A", 0, 50.0)])

    def test_only_the_used_span_of_a_blockface_is_counted(self):
        g = _chain_graph()
        full = score_turf(g, "full", [("A", 10, 0.0), ("A", 10, 100.0)])
        half = score_turf(g, "half", [("A", 10, 0.0), ("A", 10, 50.0)])
        assert full.walk_m == 100.0
        assert half.walk_m == 50.0
        assert half.score == pytest.approx(full.score / 2)

    def test_zone_power_mean_punishes_the_worst_turf(self):
        g = BlockfaceGraph({"A": 100.0, "B": 100.0, "C": 900.0}, [("A", "B", 0.0)])
        balanced = score_zone(
            g,
            {"t1": [("A", 10, 0.0), ("A", 1, 100.0)], "t2": [("B", 10, 0.0), ("B", 1, 100.0)]},
        )
        lopsided = score_zone(
            g,
            {"t1": [("A", 10, 0.0), ("A", 1, 100.0)], "t2": [("C", 10, 0.0), ("C", 1, 900.0)]},
        )
        # Same mean shift would follow from the plain mean too, but the
        # power mean must sit above the mean when spread is high...
        assert lopsided.zone_score > lopsided.mean_score
        # ...and equal it when all turfs are identical.
        assert balanced.zone_score == pytest.approx(balanced.mean_score)
        assert lopsided.worst_score == pytest.approx(900.0 / 11)

    def test_empty_zone_raises(self):
        with pytest.raises(ValueError, match="no turfs"):
            score_zone(_chain_graph(), {})


def test_turf_score_settings_are_overridden_by_environment(monkeypatch):
    monkeypatch.setenv("TURF_SCORE_UNREACHABLE_TRANSITION_M", "1234")
    monkeypatch.setenv("TURF_SCORE_EUCLIDEAN_DETOUR_FACTOR", "2.5")
    monkeypatch.setenv("TURF_SCORE_ZONE_POWER", "1")

    settings = TurfScoreSettings(_env_file=None)
    assert settings.turf_score_unreachable_transition_m == 1234.0
    assert settings.turf_score_euclidean_detour_factor == 2.5
    assert settings.turf_score_zone_power == 1.0

    graph = BlockfaceGraph({"A": 100.0, "B": 200.0}, [])
    assert graph.transition_cost("A", "B") == 1234.0
    zone = score_zone(
        graph,
        {
            "t1": [("A", 1, 0.0), ("A", 1, 100.0)],
            "t2": [("B", 1, 0.0), ("B", 1, 200.0)],
        },
    )
    assert zone.zone_score == pytest.approx(zone.mean_score)
