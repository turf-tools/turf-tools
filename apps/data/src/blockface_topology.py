"""Pure geometric classification of blockface-to-blockface relationships.

A blockface is one side (left/right) of one TIGER edge. Two blockfaces
that touch — at a shared intersection node, or as the two sides of the
same edge — relate in one of a few walkable ways:

  - ``hinge``        same physical corner; walk around it, cross nothing
  - ``across``       opposite sides of the same edge; cross your own street
  - ``continue``     walk straight through the intersection (the two edges
                     leave the node in roughly opposite directions),
                     crossing the intervening street once
  - ``turn``         one crossing onto a blockface heading a different way
  - ``kitty_corner`` diagonal corners; cross two streets
  - ``other``        anything needing three or more crossings

``continue`` vs ``turn`` is decided by bearing opposition, not street
name: name tokens are useless for this (nearly every pair of streets
shares a generic suffix token like "st"), and a street that changes
name as it crosses an avenue still *continues* for a walker.

Which of these applies is a function of the *angular arrangement* of
edges around the node. The model used here is the wedge (corner) sort:

  1. Every edge incident to a node gets a departure bearing (the
     direction the edge leaves the node).
  2. Sorting the edges radially (CCW, ascending bearing) splits the
     plane around the node into wedges — the angular gaps between
     consecutive edges. Each wedge is one physical corner of the
     intersection.
  3. Each blockface-end lands in exactly one wedge, determined by its
     edge's sorted position and which side of the edge it is. TIGER
     left/right is relative to the edge's digitized direction
     (from-node → to-node), so the assignment flips depending on which
     end of the edge the node is: facing away from the node along the
     departure bearing, digitized-left is the CCW-adjacent wedge at the
     from-end but the CW-adjacent wedge at the to-end.
  4. Stepping between adjacent wedges means physically crossing the
     edge that separates them. The relationship between two
     blockface-ends is the min-cost circular path between their wedges
     (min summed crossing cost, not min crossing count — at an
     asymmetric intersection it can be cheaper to cross two side
     streets than one arterial).

Degenerate node shapes need no special-casing: a degree-2 shape point
puts consecutive same-side blockfaces in the same wedge (free hinge); a
cul-de-sac stub has a single wedge that wraps the dead end, so a
blockface's own two sides hinge around it; a divided boulevard's median
shows up as two crossings.

Everything in this module is pure Python over plain values — no DuckDB —
so the tricky bookkeeping is unit-testable against hand-built
intersections. The SQL half (extracting nodes, bearings, and MTFCC codes
from TIGER tables) lives in ``src/dags/blockface_relationships.py``.

Bearings use math convention: degrees CCW from east (+x), in a metric
projection, normalized to [0, 360). Ascending bearing = CCW radial order.
"""

from dataclasses import dataclass

# Cost, in equivalent extra meters walked, that makes a crossing not
# worth taking. Finite (not inf) so min()/sum() arithmetic stays sane,
# but far above any real walking distance within a turf.
BARRIER_COST_M = 100_000.0

# Crossing penalty by TIGER MTFCC of the edge being crossed.
# penalty_class is a coarse human-readable bucket; crossing_cost_m is
# the number the scorer consumes. Tunable — reclassifying costs does
# not require re-deriving topology, only re-running the classifier.
_CROSSING_PENALTIES: dict[str, tuple[str, float]] = {
    # Pedestrian ways: they split wedges (you're on a different corner)
    # but crossing them costs nothing.
    "S1710": ("none", 0.0),  # walkway/pedestrian trail
    "S1720": ("none", 0.0),  # stairway
    "S1820": ("none", 0.0),  # bike path
    "S1830": ("none", 0.0),  # bridle path
    # Small local crossings.
    "S1730": ("minor", 5.0),  # alley
    "S1740": ("minor", 10.0),  # private road
    "S1780": ("minor", 10.0),  # parking lot road
    "S1500": ("minor", 15.0),  # vehicular trail (4WD)
    "S1400": ("minor", 15.0),  # local neighborhood street
    # Real streets with real traffic.
    "S1200": ("major", 60.0),  # secondary road (state/county highway)
    "S1640": ("major", 60.0),  # service drive along limited-access road
    # Do-not-cross.
    "S1100": ("barrier", BARRIER_COST_M),  # primary road / limited access
    "S1630": ("barrier", BARRIER_COST_M),  # ramp
}

_PENALTY_RANK = {"none": 0, "minor": 1, "major": 2, "barrier": 3}


def crossing_penalty(feature_class_code: str | None) -> tuple[str, float]:
    """Return ``(penalty_class, cost_m)`` for crossing one edge.

    Unknown street codes get a conservative ``major``; rail (R*) and
    hydrography (H*) are physical barriers.
    """
    if feature_class_code is None:
        return ("major", 60.0)
    known = _CROSSING_PENALTIES.get(feature_class_code)
    if known is not None:
        return known
    if feature_class_code.startswith(("R", "H")):
        return ("barrier", BARRIER_COST_M)
    return ("major", 60.0)


def _worst_penalty_class(classes: list[str]) -> str:
    if not classes:
        return "none"
    return max(classes, key=lambda c: _PENALTY_RANK[c])


@dataclass(frozen=True)
class EdgeEnd:
    """One end of one TIGER edge, incident to the node being classified.

    ``end`` says which end of the edge touches the node ('from' or 'to',
    in the edge's digitized direction). A self-loop edge contributes two
    EdgeEnds to the same node.
    """

    tiger_line_id: str
    end: str  # 'from' | 'to'
    bearing_deg: float  # departure bearing at the node, degrees CCW from east
    feature_class_code: str | None


@dataclass(frozen=True)
class Blockface:
    """One addressable side of one TIGER edge."""

    blockface_id: str
    tiger_line_id: str
    side: str  # 'left' | 'right'


@dataclass(frozen=True)
class Relationship:
    """One walkable relationship between two blockfaces.

    ``node_id`` is None for mid-block ``across`` rows. A pair may have
    rows at more than one node (e.g. parallel edges sharing both
    endpoints) — consumers should take the min-cost row per pair.
    """

    blockface_id_a: str  # normalized: a < b
    blockface_id_b: str
    kind: str
    node_id: str | None
    crossed_line_ids: tuple[str, ...]
    crossed_classes: tuple[str, ...]  # MTFCC per crossed edge ('' when unknown)
    penalty_class: str
    crossing_cost_m: float


@dataclass(frozen=True)
class _BlockfaceEnd:
    """A blockface-end placed in a wedge at the node under classification."""

    blockface: Blockface
    wedge: int
    bearing_deg: float  # departure bearing of the blockface's edge


# Two edges "continue" through a node when their departure bearings are
# at least this far apart (180 deg = perfectly straight through).
_CONTINUE_MIN_OPPOSITION_DEG = 135.0


def classify_node(
    node_id: str,
    edge_ends: list[EdgeEnd],
    blockfaces_by_line_side: dict[tuple[str, str], Blockface],
) -> list[Relationship]:
    """Classify every blockface pair meeting at one node.

    ``edge_ends`` must contain every *physical* edge incident to the node
    (streets, rail, hydro — anything that separates corners), not just
    the addressable ones. ``blockfaces_by_line_side`` maps
    ``(tiger_line_id, side)`` to the blockfaces in scope; only pairs of
    in-scope blockfaces are emitted, but out-of-scope edges still shape
    the wedges and price the crossings.

    Same-line pairs (the two sides of one edge) are skipped unless they
    share a wedge (the cul-de-sac hinge): the mid-block ``across``
    relationship covers crossing your own street, and duplicating it
    here with the same cost would add rows without information.
    """
    if not edge_ends:
        return []

    # 1. Radial sort. Deterministic tiebreak for coincident bearings.
    ordered = sorted(edge_ends, key=lambda e: (e.bearing_deg, e.tiger_line_id, e.end))
    k = len(ordered)

    # 2. Wedge assignment. Wedge i spans CCW from edge i to edge (i+1)%k;
    # moving CCW from wedge i to wedge i+1 crosses edge (i+1)%k, moving
    # CW from wedge i to wedge i-1 crosses edge i.
    bf_ends: list[_BlockfaceEnd] = []
    for i, edge in enumerate(ordered):
        for side in ("left", "right"):
            bf = blockfaces_by_line_side.get((edge.tiger_line_id, side))
            if bf is None:
                continue
            # Facing away from the node along the departure bearing:
            # at the from-end we face *with* the digitization, so
            # digitized-left is CCW of the ray (wedge i); at the to-end
            # we face *against* it, so left/right flip.
            wedge = i if (edge.end == "from") == (side == "left") else (i - 1) % k
            bf_ends.append(_BlockfaceEnd(blockface=bf, wedge=wedge, bearing_deg=edge.bearing_deg))

    # 3. Pairwise min-cost circular paths.
    penalties = [crossing_penalty(e.feature_class_code) for e in ordered]
    out: list[Relationship] = []
    for i, a in enumerate(bf_ends):
        for b in bf_ends[i + 1 :]:
            if a.blockface.blockface_id == b.blockface.blockface_id:
                continue  # self-loop edge: same blockface at both ends
            same_line = a.blockface.tiger_line_id == b.blockface.tiger_line_id
            if a.wedge == b.wedge:
                crossed: list[int] = []
            else:
                if same_line:
                    continue  # covered by the mid-block `across` row
                crossed = _min_cost_crossing(a.wedge, b.wedge, k, penalties)
            out.append(_build_relationship(node_id, ordered, a, b, crossed))
    return out


def _min_cost_crossing(wa: int, wb: int, k: int, penalties: list[tuple[str, float]]) -> list[int]:
    """Edge indices crossed on the cheaper circular path from wedge wa to wb.

    Ties go to fewer crossings, then to the CCW direction (deterministic).
    """
    ccw = [(wa + step) % k for step in range(1, (wb - wa) % k + 1)]
    cw = [(wa - step + 1) % k for step in range(1, (wa - wb) % k + 1)]
    ccw_cost = sum(penalties[i][1] for i in ccw)
    cw_cost = sum(penalties[i][1] for i in cw)
    if (ccw_cost, len(ccw)) <= (cw_cost, len(cw)):
        return ccw
    return cw


def _build_relationship(
    node_id: str,
    ordered: list[EdgeEnd],
    a: _BlockfaceEnd,
    b: _BlockfaceEnd,
    crossed: list[int],
) -> Relationship:
    crossed_lines = tuple(ordered[i].tiger_line_id for i in crossed)
    crossed_classes = tuple(ordered[i].feature_class_code or "" for i in crossed)
    per_edge = [crossing_penalty(ordered[i].feature_class_code) for i in crossed]
    cost = sum(p[1] for p in per_edge)
    penalty_class = _worst_penalty_class([p[0] for p in per_edge])

    if not crossed:
        kind = "hinge"
    elif len(crossed) == 1:
        opposition = abs(((b.bearing_deg - a.bearing_deg + 180.0) % 360.0) - 180.0)
        kind = "continue" if opposition >= _CONTINUE_MIN_OPPOSITION_DEG else "turn"
    elif len(crossed) == 2:
        kind = "kitty_corner"
    else:
        kind = "other"

    id_a, id_b = sorted((a.blockface.blockface_id, b.blockface.blockface_id))
    return Relationship(
        blockface_id_a=id_a,
        blockface_id_b=id_b,
        kind=kind,
        node_id=node_id,
        crossed_line_ids=crossed_lines,
        crossed_classes=crossed_classes,
        penalty_class=penalty_class,
        crossing_cost_m=cost,
    )


def across_relationships(
    blockfaces: list[Blockface],
    feature_class_by_line: dict[str, str | None],
) -> list[Relationship]:
    """Mid-block ``across`` rows: the two sides of the same edge.

    Node-independent — you can cross your own street anywhere along the
    block — so ``node_id`` is None and the crossing cost is your own
    street's class.
    """
    by_line: dict[str, dict[str, Blockface]] = {}
    for bf in blockfaces:
        by_line.setdefault(bf.tiger_line_id, {})[bf.side] = bf

    out: list[Relationship] = []
    for line_id, sides in by_line.items():
        if "left" not in sides or "right" not in sides:
            continue
        mtfcc = feature_class_by_line.get(line_id)
        penalty_class, cost = crossing_penalty(mtfcc)
        id_a, id_b = sorted((sides["left"].blockface_id, sides["right"].blockface_id))
        out.append(
            Relationship(
                blockface_id_a=id_a,
                blockface_id_b=id_b,
                kind="across",
                node_id=None,
                crossed_line_ids=(line_id,),
                crossed_classes=(mtfcc or "",),
                penalty_class=penalty_class,
                crossing_cost_m=cost,
            )
        )
    return out
