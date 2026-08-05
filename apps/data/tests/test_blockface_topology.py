"""Unit tests for the pure wedge/corner classification.

Every test hand-builds a node from bearings — no DuckDB — and asserts
the classification a human reaches by looking at the drawing. The
canonical fixture is a standard 4-way: MAIN ST running east-west, CROSS
ST running north-south, all four edges digitized *away* from the center
node:

                    N (CROSS ST)
              NW wedge │ NE wedge
        W ─────────────┼───────────── E   (MAIN ST)
              SW wedge │ SE wedge
                    S (CROSS ST)
"""

from src.blockface_topology import (
    BARRIER_COST_M,
    Blockface,
    EdgeEnd,
    Relationship,
    across_relationships,
    classify_node,
    crossing_penalty,
)


def _edge(line: str, end: str, bearing: float, mtfcc: str = "S1400") -> EdgeEnd:
    return EdgeEnd(tiger_line_id=line, end=end, bearing_deg=bearing, feature_class_code=mtfcc)


def _bf(line: str, side: str) -> Blockface:
    return Blockface(blockface_id=f"{line}:{side}", tiger_line_id=line, side=side)


def _both_sides(*lines: str) -> dict[tuple[str, str], Blockface]:
    return {(line, side): _bf(line, side) for line in lines for side in ("left", "right")}


def _four_way(mtfcc_by_line: dict[str, str] | None = None) -> list[EdgeEnd]:
    """E/N/W/S edges leaving the node at 0/90/180/270 degrees."""
    codes = mtfcc_by_line or {}
    return [
        _edge("E", "from", 0.0, codes.get("E", "S1400")),
        _edge("N", "from", 90.0, codes.get("N", "S1400")),
        _edge("W", "from", 180.0, codes.get("W", "S1400")),
        _edge("S", "from", 270.0, codes.get("S", "S1400")),
    ]


FOUR_WAY_BLOCKFACES = _both_sides("E", "N", "W", "S")


def _by_pair(rels: list[Relationship]) -> dict[tuple[str, str], Relationship]:
    index = {}
    for r in rels:
        key = (r.blockface_id_a, r.blockface_id_b)
        assert key not in index, f"duplicate pair at one node: {key}"
        index[key] = r
    return index


def _get(rels: list[Relationship], a: str, b: str) -> Relationship:
    key = tuple(sorted((a, b)))
    return _by_pair(rels)[key]


class TestFourWay:
    def test_pair_count_and_kind_histogram(self):
        rels = classify_node("X", _four_way(), FOUR_WAY_BLOCKFACES)
        # 8 blockface-ends -> C(8,2)=28 pairs, minus 4 same-line pairs
        # (covered by mid-block `across`). Each wedge holds 2 ends:
        # 4 same-wedge hinges, 8 diagonal (2-crossing) pairs, and 12
        # one-crossing pairs of which the 4 straight-through ones are
        # continues.
        assert len(rels) == 24
        kinds = {}
        for r in rels:
            kinds[r.kind] = kinds.get(r.kind, 0) + 1
        assert kinds == {"hinge": 4, "continue": 4, "turn": 8, "kitty_corner": 8}

    def test_hinges_are_the_four_corners(self):
        rels = classify_node("X", _four_way(), FOUR_WAY_BLOCKFACES)
        hinges = {(r.blockface_id_a, r.blockface_id_b) for r in rels if r.kind == "hinge"}
        assert hinges == {
            ("E:left", "N:right"),  # NE corner
            ("N:left", "W:right"),  # NW corner
            ("S:right", "W:left"),  # SW corner
            ("E:right", "S:left"),  # SE corner
        }
        for r in rels:
            if r.kind == "hinge":
                assert r.crossed_line_ids == ()
                assert r.crossing_cost_m == 0.0
                assert r.penalty_class == "none"

    def test_continue_crosses_the_side_street(self):
        rels = classify_node("X", _four_way(), FOUR_WAY_BLOCKFACES)
        north_sidewalk = _get(rels, "E:left", "W:right")
        assert north_sidewalk.kind == "continue"
        assert north_sidewalk.crossed_line_ids == ("N",)
        south_sidewalk = _get(rels, "E:right", "W:left")
        assert south_sidewalk.kind == "continue"
        assert south_sidewalk.crossed_line_ids == ("S",)
        assert south_sidewalk.crossing_cost_m == crossing_penalty("S1400")[1]

    def test_kitty_corner_crosses_two_streets(self):
        rels = classify_node("X", _four_way(), FOUR_WAY_BLOCKFACES)
        diagonal = _get(rels, "E:left", "W:left")  # NE quadrant to SW quadrant
        assert diagonal.kind == "kitty_corner"
        assert len(diagonal.crossed_line_ids) == 2
        assert diagonal.crossing_cost_m == 2 * crossing_penalty("S1400")[1]

    def test_turn_crossing_own_street_to_reach_the_other(self):
        # NE corner of MAIN to SE corner of CROSS: cross MAIN's eastern
        # segment once. The edges head 0° and 270° — not opposite — so
        # this is a 'turn' even though it's a single crossing.
        rels = classify_node("X", _four_way(), FOUR_WAY_BLOCKFACES)
        r = _get(rels, "E:left", "S:left")
        assert r.kind == "turn"
        assert r.crossed_line_ids == ("E",)

    def test_min_cost_path_routes_around_barriers(self):
        # N and W are primary roads; E and S are local. NE corner to SW
        # corner: the CCW path (cross N, cross W) costs 2 barriers; the
        # CW path (cross E, cross S) costs 2 local streets. The cheap
        # direction must win even though both cross two streets.
        edges = _four_way({"N": "S1100", "W": "S1100"})
        rels = classify_node("X", edges, FOUR_WAY_BLOCKFACES)
        r = _get(rels, "N:right", "S:right")  # NE corner to SW corner
        assert r.kind == "kitty_corner"
        assert set(r.crossed_line_ids) == {"E", "S"}
        assert r.crossing_cost_m == 2 * crossing_penalty("S1400")[1]
        assert r.penalty_class == "minor"

    def test_barrier_crossing_reports_barrier_penalty(self):
        # Continuing along MAIN's north sidewalk must cross N. With N
        # and S both primary, there is no cheap way around (any detour
        # also crosses a primary), so the row carries the barrier.
        edges = _four_way({"N": "S1100", "S": "S1100"})
        rels = classify_node("X", edges, FOUR_WAY_BLOCKFACES)
        north_sidewalk = _get(rels, "E:left", "W:right")
        assert north_sidewalk.kind == "continue"
        assert north_sidewalk.penalty_class == "barrier"
        assert north_sidewalk.crossing_cost_m == BARRIER_COST_M


class TestDigitizationFlip:
    def test_to_end_flips_left_right(self):
        # Same physical cross as TestFourWay, but the eastern MAIN
        # segment is digitized *toward* the node (node is its to-end).
        # Its digitized-right is then the physical north side, so E:right
        # must land where E:left landed before — the NE corner hinge
        # with N:right.
        edges = [
            _edge("E", "to", 0.0),
            _edge("N", "from", 90.0),
            _edge("W", "from", 180.0),
            _edge("S", "from", 270.0),
        ]
        rels = classify_node("X", edges, FOUR_WAY_BLOCKFACES)
        ne_corner = _get(rels, "E:right", "N:right")
        assert ne_corner.kind == "hinge"
        se_corner = _get(rels, "E:left", "S:left")
        assert se_corner.kind == "hinge"
        # And the north-sidewalk continue is now E:right <-> W:right.
        r = _get(rels, "E:right", "W:right")
        assert r.kind == "continue"
        assert r.crossed_line_ids == ("N",)


class TestDegenerateNodes:
    def test_t_intersection_through_side_is_free(self):
        # MAIN continues E-W; CROSS stems south only. The north sidewalk
        # of MAIN passes the T without crossing anything (one merged
        # north wedge), while the south sidewalk must cross the stem.
        edges = [
            _edge("E", "from", 0.0),
            _edge("W", "from", 180.0),
            _edge("S", "from", 270.0),
        ]
        bfs = _both_sides("E", "W", "S")
        rels = classify_node("X", edges, bfs)
        north = _get(rels, "E:left", "W:right")
        assert north.kind == "hinge"
        assert north.crossing_cost_m == 0.0
        south = _get(rels, "E:right", "W:left")
        assert south.kind == "continue"
        assert south.crossed_line_ids == ("S",)

    def test_degree_two_shape_point_hinges_same_side(self):
        # Two segments of the same street meeting at a shape point:
        # same-side pairs are free (nothing to cross).
        edges = [_edge("E", "from", 0.0), _edge("W", "from", 180.0)]
        bfs = _both_sides("E", "W")
        rels = classify_node("X", edges, bfs)
        assert _get(rels, "E:left", "W:right").kind == "hinge"
        assert _get(rels, "E:right", "W:left").kind == "hinge"
        # Opposite-side pair still needs one street crossing.
        cross = _get(rels, "E:left", "W:left")
        assert cross.crossing_cost_m == crossing_penalty("S1400")[1]

    def test_cul_de_sac_hinges_around_the_dead_end(self):
        # Degree-1 node: a single wedge wraps the dead end, so the two
        # sides of the same street hinge around it.
        edges = [_edge("E", "to", 180.0)]
        bfs = _both_sides("E")
        rels = classify_node("X", edges, bfs)
        assert len(rels) == 1
        assert rels[0].kind == "hinge"
        assert {rels[0].blockface_id_a, rels[0].blockface_id_b} == {"E:left", "E:right"}

    def test_empty_node(self):
        assert classify_node("X", [], FOUR_WAY_BLOCKFACES) == []

    def test_rail_splits_a_corner_and_is_routed_around(self):
        # A rail line leaves the node at 45°, splitting the old NE wedge
        # between E:left and N:right. Crossing it is a barrier, so the
        # min-cost path walks all the way around the intersection —
        # four local-street crossings beat one rail crossing.
        edges = _four_way() + [_edge("RAIL", "from", 45.0, "R1011")]
        rels = classify_node("X", edges, FOUR_WAY_BLOCKFACES)
        assert all("RAIL" not in (r.blockface_id_a, r.blockface_id_b) for r in rels)
        ne = _get(rels, "E:left", "N:right")
        assert ne.kind == "other"
        assert "RAIL" not in ne.crossed_line_ids
        assert len(ne.crossed_line_ids) == 4
        assert ne.crossing_cost_m == 4 * crossing_penalty("S1400")[1]
        assert ne.penalty_class == "minor"

    def test_pedestrian_way_splits_a_corner_for_free(self):
        # Same shape as the rail case, but the splitter is a walkway:
        # still two different wedges, but crossing it costs nothing.
        edges = _four_way() + [_edge("PATH", "from", 45.0, "S1710")]
        rels = classify_node("X", edges, FOUR_WAY_BLOCKFACES)
        ne = _get(rels, "E:left", "N:right")
        assert ne.crossed_line_ids == ("PATH",)
        assert ne.crossing_cost_m == 0.0
        assert ne.penalty_class == "none"


class TestAcross:
    def test_across_pairs_both_sides(self):
        bfs = [_bf("E", "left"), _bf("E", "right"), _bf("N", "left")]
        rels = across_relationships(bfs, {"E": "S1200", "N": "S1400"})
        assert len(rels) == 1  # N has only one side in scope
        r = rels[0]
        assert r.kind == "across"
        assert r.node_id is None
        assert r.crossed_line_ids == ("E",)
        assert r.penalty_class == "major"
        assert r.crossing_cost_m == crossing_penalty("S1200")[1]

    def test_unknown_class_is_conservative_major(self):
        bfs = [_bf("E", "left"), _bf("E", "right")]
        rels = across_relationships(bfs, {})
        assert rels[0].penalty_class == "major"


class TestPenalties:
    def test_rank_and_examples(self):
        assert crossing_penalty("S1710") == ("none", 0.0)
        assert crossing_penalty("S1400")[0] == "minor"
        assert crossing_penalty("S1200")[0] == "major"
        assert crossing_penalty("S1100") == ("barrier", BARRIER_COST_M)
        assert crossing_penalty("R1011")[0] == "barrier"
        assert crossing_penalty("H3010")[0] == "barrier"
        assert crossing_penalty(None)[0] == "major"
        assert crossing_penalty("S9999")[0] == "major"
