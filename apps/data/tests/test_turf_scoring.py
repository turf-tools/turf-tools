"""Unit tests for turf scoring on hand-built blockface graphs."""

import pytest

from src.turf_scoring import (
    EUCLIDEAN_DETOUR_FACTOR,
    UNREACHABLE_TRANSITION_M,
    BlockfaceGraph,
    score_turf,
    score_zone,
    turf_walk_cost,
)


def _chain_graph() -> BlockfaceGraph:
    """A, B, C, D in a row (100m each), free hinges between neighbors."""
    lengths = {"A": 100.0, "B": 100.0, "C": 100.0, "D": 100.0}
    edges = [("A", "B", 0.0), ("B", "C", 0.0), ("C", "D", 0.0)]
    return BlockfaceGraph(lengths, edges)


class TestWalkCost:
    def test_single_blockface_has_no_transitions(self):
        walk, trans = turf_walk_cost(_chain_graph(), {"B"})
        assert (walk, trans) == (100.0, 0.0)

    def test_adjacent_chain_is_lengths_only(self):
        walk, trans = turf_walk_cost(_chain_graph(), {"A", "B", "C"})
        assert walk == 300.0
        assert trans == 0.0

    def test_gap_pays_the_skipped_blockface(self):
        # Turf {A, C}: getting from A to C walks along B (100m).
        walk, trans = turf_walk_cost(_chain_graph(), {"A", "C"})
        assert walk == 200.0
        assert trans == 100.0

    def test_direct_crossing_beats_detour(self):
        # A and C also touch directly (e.g. kitty-corner, 30m-equivalent):
        # cheaper than walking the 100m of B.
        lengths = {"A": 100.0, "B": 100.0, "C": 100.0}
        edges = [("A", "B", 0.0), ("B", "C", 0.0), ("A", "C", 30.0)]
        g = BlockfaceGraph(lengths, edges)
        _, trans = turf_walk_cost(g, {"A", "C"})
        assert trans == 30.0

    def test_crossing_costs_accumulate_along_chain(self):
        lengths = {"A": 100.0, "B": 100.0, "C": 100.0}
        edges = [("A", "B", 15.0), ("B", "C", 60.0)]
        g = BlockfaceGraph(lengths, edges)
        _, trans = turf_walk_cost(g, {"A", "B", "C"})
        assert trans == 75.0  # best chain A->B->C from either end

    def test_greedy_picks_the_best_start(self):
        # Starting mid-chain forces a doubled-back transition; starting
        # at an end walks straight through. Best-of-starts must find it.
        walk, trans = turf_walk_cost(_chain_graph(), {"A", "B", "C", "D"})
        assert trans == 0.0

    def test_disconnected_pair_falls_back_to_euclidean_detour(self):
        lengths = {"A": 100.0, "Z": 50.0}
        midpoints = {"A": (0.0, 0.0), "Z": (300.0, 400.0)}  # 500m apart
        g = BlockfaceGraph(lengths, [], midpoints)
        _, trans = turf_walk_cost(g, {"A", "Z"})
        assert trans == 500.0 * EUCLIDEAN_DETOUR_FACTOR
        assert g.fallback_pairs == 1

    def test_disconnected_pair_without_geometry_pays_the_broken_hop(self):
        lengths = {"A": 100.0, "Z": 50.0}
        g = BlockfaceGraph(lengths, [])
        _, trans = turf_walk_cost(g, {"A", "Z"})
        assert trans == UNREACHABLE_TRANSITION_M
        assert g.fallback_pairs == 0

    def test_connected_pair_never_uses_the_fallback(self):
        lengths = {"A": 100.0, "B": 100.0}
        midpoints = {"A": (0.0, 0.0), "B": (1.0, 0.0)}
        g = BlockfaceGraph(lengths, [("A", "B", 60.0)], midpoints)
        _, trans = turf_walk_cost(g, {"A", "B"})
        assert trans == 60.0  # graph cost, even though euclid*factor is smaller
        assert g.fallback_pairs == 0

    def test_unknown_blockface_raises(self):
        with pytest.raises(KeyError):
            turf_walk_cost(_chain_graph(), {"A", "NOPE"})

    def test_min_cost_edge_wins_duplicate_relationships(self):
        # A pair can relate at two nodes; the graph must keep the min.
        lengths = {"A": 100.0, "B": 100.0}
        g = BlockfaceGraph(lengths, [("A", "B", 60.0), ("A", "B", 0.0)])
        _, trans = turf_walk_cost(g, {"A", "B"})
        assert trans == 0.0


class TestScores:
    def test_score_is_cost_per_door(self):
        s = score_turf(_chain_graph(), "t1", [("A", 20), ("A", 10), ("B", 30)])
        assert s.doors == 60
        assert s.walk_m == 200.0
        assert s.transition_m == 0.0
        assert s.score == pytest.approx(200.0 / 60)

    def test_zero_doors_raises(self):
        with pytest.raises(ValueError, match="no doors"):
            score_turf(_chain_graph(), "t1", [("A", 0)])

    def test_splitting_a_blockface_across_turfs_pays_its_length_twice(self):
        g = _chain_graph()
        together = score_zone(g, {"t1": [("A", 30), ("B", 30)]})
        split = score_zone(g, {"t1": [("A", 15), ("B", 15)], "t2": [("A", 15), ("B", 15)]})
        # Same doors overall, but each half-turf walks both full
        # blockfaces: cost per door doubles.
        assert split.zone_score == pytest.approx(2 * together.zone_score)

    def test_zone_power_mean_punishes_the_worst_turf(self):
        g = BlockfaceGraph({"A": 100.0, "B": 100.0, "C": 900.0}, [("A", "B", 0.0)])
        balanced = score_zone(g, {"t1": [("A", 10)], "t2": [("B", 10)]})
        lopsided = score_zone(g, {"t1": [("A", 10)], "t2": [("C", 10)]})
        # Same mean shift would follow from the plain mean too, but the
        # power mean must sit above the mean when spread is high...
        assert lopsided.zone_score > lopsided.mean_score
        # ...and equal it when all turfs are identical.
        assert balanced.zone_score == pytest.approx(balanced.mean_score)
        assert lopsided.worst_score == pytest.approx(900.0 / 10)

    def test_empty_zone_raises(self):
        with pytest.raises(ValueError, match="no turfs"):
            score_zone(_chain_graph(), {})
