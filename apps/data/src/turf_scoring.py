"""Turf quality scoring over the blockface graph.

A turf is a set of buildings; each building sits at a position along a
blockface. The score treats canvassing a turf as walking the span from
the first selected building to the last selected building on each
blockface, plus the cost of getting from each blockface to the next one.

    turf cost  = Σ walked blockface spans + Σ chain transition costs
    turf score = turf cost / doors          (lower is better)

Transitions come from ``blockface_relationships``: moving between two
touching blockfaces costs that pair's ``crossing_cost_m`` (hinges are
free, crossing a local street is cheap, arterials are expensive,
barriers are prohibitive). Between non-touching blockfaces the cost is
the cheapest path through intermediate blockfaces, paying each
intermediate's full length (you have to walk along it) plus each
crossing on the way — computed with Dijkstra over the blockface graph.

The chain order is a greedy nearest-neighbor open path, best over all
starting blockfaces. Turfs are small (a handful of blockfaces), so this
is both fast and close to optimal; it's an *estimator* for ranking
cuts, not a router.

Model approximations:

- Only addressable blockfaces (addrfeat) exist in the graph, so paths
  through unaddressed street segments aren't available. Most of the
  time this just overestimates a detour, but a blockface can be fully
  cut off from the addressable network by unaddressed edges (a street
  facing a park or the inside of a complex: no `across` partner, and
  only plaza/park edges at its nodes). Transitions to such blockfaces
  fall back to straight-line distance between blockface midpoints times
  the configured Euclidean detour factor — the graph can't see the real
  path, so it estimates instead of declaring the turf broken. The graph
  counts these in ``fallback_pairs`` for observability; modeling
  unaddressed edges as connector vertices would make those fallback
  estimates unnecessary.
- Pairs that are unreachable *and* lack midpoint geometry pay the
  configured unreachable-transition cost per hop rather than infinity,
  so aggregate scores stay rankable.

Zone-level score
----------------

All turfs in a zone are cut to roughly the same door target, so
per-turf ``cost / doors`` values are directly comparable. The zone
score is the **power mean** of per-turf scores:

    zone score = ( mean(scoreᵢᵖ) )^(1/p)

- p = 1 is the plain mean (total walking per door across the zone);
- p → ∞ is the worst turf alone.
- p = 3 sits between: the mean still matters, but a single terrible
  turf drags the zone score hard — matching the goal that no turf is
  *too* bad rather than that the average is pretty.

The power mean is unweighted across turfs on purpose: a tiny awful
turf should hurt as much as a big awful one — someone still has to
walk it for very few doors.
"""

import heapq
import math
from collections import defaultdict
from dataclasses import dataclass

import duckdb
from src.models import TableRef
from src.settings import get_turf_score_settings

TurfBuilding = tuple[str, int, float]
"""A building represented as (blockface_id, door_count, position_m)."""


@dataclass(frozen=True)
class TurfScore:
    turf_id: str
    blockface_count: int
    walk_m: float  # sum of walked spans along blockfaces
    transition_m: float  # greedy chain transition total
    doors: int
    score: float  # (walk_m + transition_m) / doors


@dataclass(frozen=True)
class ZoneScore:
    zone_score: float  # configured power mean
    mean_score: float
    worst_score: float
    turfs: list[TurfScore]


class BlockfaceGraph:
    """Blockfaces with lengths, connected by min-cost relationship edges.

    Transition costs are computed lazily with Dijkstra and cached, so
    scoring many overlapping candidate cuts of one zone stays cheap.
    """

    def __init__(
        self,
        lengths_m: dict[str, float],
        edges: list[tuple[str, str, float]],
        midpoints_m: dict[str, tuple[float, float]] | None = None,
        *,
        unreachable_transition_m: float | None = None,
        euclidean_detour_factor: float | None = None,
    ):
        settings = get_turf_score_settings()
        self.lengths_m = lengths_m
        self.midpoints_m = midpoints_m or {}
        self.unreachable_transition_m = (
            settings.turf_score_unreachable_transition_m
            if unreachable_transition_m is None
            else unreachable_transition_m
        )
        self.euclidean_detour_factor = (
            settings.turf_score_euclidean_detour_factor if euclidean_detour_factor is None else euclidean_detour_factor
        )
        self.fallback_pairs = 0
        self._adjacency: dict[str, dict[str, float]] = defaultdict(dict)
        for a, b, cost in edges:
            if a not in lengths_m or b not in lengths_m:
                continue
            existing = self._adjacency[a].get(b)
            if existing is None or cost < existing:
                self._adjacency[a][b] = cost
                self._adjacency[b][a] = cost
        self._pair_cache: dict[tuple[str, str], float] = {}

    def transition_cost(self, a: str, b: str) -> float:
        """Cheapest way from blockface a to blockface b.

        Crossing costs along the way, plus the full length of every
        *intermediate* blockface walked (a and b are already paid for
        by the turf itself). Symmetric.
        """
        if a == b:
            return 0.0
        key = (a, b) if a < b else (b, a)
        cached = self._pair_cache.get(key)
        if cached is not None:
            return cached
        self._fill_pairs_from(a, {b})
        return self._pair_cache[key]

    def _fill_pairs_from(self, source: str, targets: set[str]) -> None:
        """Dijkstra from source, caching transition costs to `targets`.

        Uniform edge weight cost(u,v) + length(v) makes the search
        target-independent; the target's own length is subtracted when
        caching. Early-exits once every target is settled. Unreachable
        targets cache the Euclidean-detour fallback.
        """
        remaining = {t for t in targets if t != source}
        dist: dict[str, float] = {source: 0.0}
        heap: list[tuple[float, str]] = [(0.0, source)]
        settled: set[str] = set()
        while heap and remaining:
            d, u = heapq.heappop(heap)
            if u in settled:
                continue
            settled.add(u)
            if u in remaining:
                remaining.discard(u)
                key = (source, u) if source < u else (u, source)
                self._pair_cache[key] = d - self.lengths_m[u]
            for v, crossing in self._adjacency[u].items():
                nd = d + crossing + self.lengths_m[v]
                if nd < dist.get(v, float("inf")):
                    dist[v] = nd
                    heapq.heappush(heap, (nd, v))
        for t in remaining:
            key = (source, t) if source < t else (t, source)
            self._pair_cache[key] = self._disconnected_cost(source, t)

    def _disconnected_cost(self, a: str, b: str) -> float:
        pa, pb = self.midpoints_m.get(a), self.midpoints_m.get(b)
        if pa is None or pb is None:
            return self.unreachable_transition_m
        self.fallback_pairs += 1
        return math.hypot(pa[0] - pb[0], pa[1] - pb[1]) * self.euclidean_detour_factor


def turf_walk_cost(
    graph: BlockfaceGraph,
    blockface_spans_m: dict[str, tuple[float, float]],
) -> tuple[float, float]:
    """Return walked-blockface and transition distances for one turf.

    Each value in ``blockface_spans_m`` is the minimum and maximum
    building position used by the turf on that blockface. Positions are
    distances in meters from the start of the blockface geometry.
    """
    missing = [b for b in blockface_spans_m if b not in graph.lengths_m]
    if missing:
        raise KeyError(f"blockfaces not in graph: {missing[:5]}{'…' if len(missing) > 5 else ''}")
    invalid = [
        b for b, (start, end) in blockface_spans_m.items() if start < 0 or end < start or end > graph.lengths_m[b]
    ]
    if invalid:
        raise ValueError(f"invalid blockface spans: {invalid[:5]}{'…' if len(invalid) > 5 else ''}")
    walk_m = sum(end - start for start, end in blockface_spans_m.values())
    if len(blockface_spans_m) <= 1:
        return walk_m, 0.0

    ids = sorted(blockface_spans_m)
    for source in ids:
        uncached = {
            t for t in ids if t != source and ((source, t) if source < t else (t, source)) not in graph._pair_cache
        }
        if uncached:
            graph._fill_pairs_from(source, uncached)

    best = float("inf")
    for start in ids:
        total = 0.0
        current, unvisited = start, set(ids) - {start}
        while unvisited:
            nxt = min(unvisited, key=lambda b: (graph.transition_cost(current, b), b))
            total += graph.transition_cost(current, nxt)
            current = nxt
            unvisited.discard(nxt)
            if total >= best:
                break
        best = min(best, total)
    return walk_m, best


def score_turf(graph: BlockfaceGraph, turf_id: str, buildings: list[TurfBuilding]) -> TurfScore:
    """Score one turf from its buildings and positions along blockfaces."""
    doors = sum(door_count for _, door_count, _ in buildings)
    if doors <= 0:
        raise ValueError(f"turf {turf_id} has no doors")
    spans: dict[str, tuple[float, float]] = {}
    for blockface_id, _, position_m in buildings:
        if blockface_id in spans:
            start, end = spans[blockface_id]
            spans[blockface_id] = (min(start, position_m), max(end, position_m))
        else:
            spans[blockface_id] = (position_m, position_m)
    walk_m, transition_m = turf_walk_cost(graph, spans)
    return TurfScore(
        turf_id=turf_id,
        blockface_count=len(spans),
        walk_m=walk_m,
        transition_m=transition_m,
        doors=doors,
        score=(walk_m + transition_m) / doors,
    )


def score_zone(
    graph: BlockfaceGraph,
    turfs: dict[str, list[TurfBuilding]],
    power: float | None = None,
) -> ZoneScore:
    """Score a full cut: every turf in the zone, aggregated by power mean."""
    if not turfs:
        raise ValueError("no turfs to score")
    if power is None:
        power = get_turf_score_settings().turf_score_zone_power
    if power <= 0:
        raise ValueError("power must be greater than zero")
    turf_scores = [score_turf(graph, turf_id, buildings) for turf_id, buildings in turfs.items()]
    scores = [t.score for t in turf_scores]
    mean = sum(scores) / len(scores)
    zone = (sum(s**power for s in scores) / len(scores)) ** (1.0 / power)
    return ZoneScore(zone_score=zone, mean_score=mean, worst_score=max(scores), turfs=turf_scores)


def load_blockface_graph(
    conn: duckdb.DuckDBPyConnection,
    blockface_unpivoted: TableRef,
    blockface_relationships: TableRef,
) -> BlockfaceGraph:
    """Build the graph from DuckLake: lengths and midpoints from
    blockface geometry (UTM 18N meters), edges from the min-cost
    relationship per pair."""
    lengths: dict[str, float] = {}
    midpoints: dict[str, tuple[float, float]] = {}
    for bf_id, length, mx, my in conn.execute(f"""
        WITH prepared AS (
            SELECT blockface_id, ANY_VALUE(ST_Transform(geom, 'OGC:CRS84', 'EPSG:32618')) AS geom_m
            FROM {blockface_unpivoted.fqn}
            GROUP BY blockface_id
        )
        SELECT blockface_id, ST_Length(geom_m),
               ST_X(ST_LineInterpolatePoint(geom_m, 0.5)),
               ST_Y(ST_LineInterpolatePoint(geom_m, 0.5))
        FROM prepared
    """).fetchall():
        lengths[bf_id] = length
        midpoints[bf_id] = (mx, my)
    edges = conn.execute(f"""
        SELECT blockface_id_a, blockface_id_b, min(crossing_cost_m)
        FROM {blockface_relationships.fqn}
        GROUP BY 1, 2
    """).fetchall()
    return BlockfaceGraph(lengths, edges, midpoints)
