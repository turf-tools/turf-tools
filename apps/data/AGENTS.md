# Data Package

This package builds the voter-data tables that the web and native apps query
against. It loads voter files, matches addresses against TIGER blockfaces,
refines positions with OpenStreetMap data, and aggregates everything into
canonical Person / Building / Door records.

## Tooling

### Use `uv`

Run everything through `uv` — even ad-hoc one-off scripts. Don't reach for `pip`
or a global Python.

### Hamilton + DuckDB

The pipeline is a [Hamilton](https://github.com/dagworks-inc/hamilton) DAG
backed by DuckDB with two DuckLake catalogs attached:

- `ducklake` — voter / Person data (per-organization schemas)
- `geo_ducklake` — TIGER blockfaces, OSM buildings, landuse polygons, boundary shapes

Both catalogs share **one DuckDB connection** (`src/duckdb.get_connection`),
so cross-catalog joins are free — no data copying.

### Hamilton node return values: `TableRef`

Hamilton nodes don't return DataFrames or relations. They execute their work
against the shared DuckDB connection and return a `TableRef` dataclass
(`src/models.py`):

```python
TableRef(catalog="ducklake", schema="default", table="persons_geocoded", version=N)
```

Downstream nodes accept these as inputs and use them to locate data in
DuckLake. The `version` field is the DuckLake snapshot version at the time
the node finished — useful for time-travel queries during debugging.

### SQL style

Most nodes use plain SQL strings via `conn.execute(f"…")`. The DuckDB
relational API (`rel.filter()`, `rel.aggregate()`, etc.) is available but
rarely used in this codebase — the SQL is more readable for the kind of
multi-CTE work this pipeline does.

## Naming conventions

### DAG nodes

Every node has a **noun** name describing its data. The function name matches
the table suffix when materialized: `persons_decomposed` produces
`{slug}_persons_decomposed`. Within a family, names use a stage qualifier:
`persons_transformed`, `persons_validated`, `persons_decomposed`,
`persons_candidates`, `persons_scored`, `persons_best_match`,
`persons_geocoded`.

Some nodes (e.g. `persons_validated`) don't materialize a new table — they
pass through the `TableRef` they received after running checks. Consumers
don't need to know whether a fresh table was written.

### voter vs person

The input is a **voter file** — a parquet dump from a state BOE. The
downstream canonical schema is **Person** (`src/models.py`). We keep
"voter_file" in input-side names (`voter_file_url`, `voter_file_loader.py`,
`{slug}_voters_raw`) because that's literally what's being loaded.
Everything after validation uses "person" because rows conform to the
Person schema regardless of source.

### Per-organization namespace

`ducklake` schemas are per-organization: `ducklake.{organization_slug}.*`.
The slug is the URL/SQL-safe identifier stored alongside `organizationId`
in `organizations` (`packages/db/src/schema/organizations.ts`).

`geo_ducklake` is organization-agnostic — TIGER and OSM data is shared
across all orgs in the same state.

## The Hamilton modules

| Module              | Role                                                                                     | Output catalog            |
| ------------------- | ---------------------------------------------------------------------------------------- | ------------------------- |
| `voter_file_loader` | Parse voter parquet → Person schema                                                      | `ducklake.{org}`          |
| `tiger`             | TIGER shapefiles → `blockface_final`                                                     | `geo_ducklake.tiger`      |
| `osm`               | OSM PBF → `osm_building_lookup` + raw OSM tables                                         | `geo_ducklake.osm`        |
| `matching`          | Voter ↔ TIGER blockface (`persons_best_match`)                                           | `ducklake.{org}`          |
| `geocode`           | Lat/lon assignment (`refined_positions`, `osm_only_matches`)                             | `ducklake.{org}`          |
| `assembly`          | Canonical Person record (`canonical_addresses`, `persons_geocoded`, `geocoding_summary`) | `ducklake.{org}`          |
| `aggregate`         | `persons_geocoded` → `buildings_geocoded` + `doors_geocoded`                             | `ducklake.{org}`          |
| `boundaries`        | Derive polygons (EDs, zips) from voter data + TIGER blocks                               | `geo_ducklake.boundaries` |
| `quickwit`          | Stream Person records into a Quickwit search index                                       | external                  |

`tiger` and `osm` are symmetric — both extract geographic reference
data into `geo_ducklake`. `matching`, `geocode`, `assembly`, and
`aggregate` form the per-voter pipeline that consumes those references.

### voter_file_loader

```
voters_raw → persons_transformed → persons_validated
```

`voters_raw` ingests the parquet as-is. `persons_transformed` runs the
state-specific SQL in `src/transformations.py` to map raw fields to
the Person schema. `persons_validated` is a passthrough that runs Pydantic
checks.

### tiger

```
tiger_addrfeat_raw ─┐
                    ├─► blockface_unpivoted → blockface_normalized → blockface_final
tiger_edges_raw  ───┘
address_tokens ──────────────────────────────────────────► blockface_final
```

Downloads TIGER/Line shapefiles per state/county/year, joins them into one
blockface table. Each TIGER edge has both a left and right side with
independent house-number ranges; `blockface_unpivoted` splits each edge
into two rows (one per side).

`blockface_final` carries:

- house-number range (from, to) + parity (odd/even/mixed)
- side (left/right)
- equivalency-expanded `street_name_tokens` (so `"E 14th St"` tokenizes to
  `[e, east, 14, 14th, fourteenth, st, street, saint]`)
- a `GEOMETRY` representing the edge line

The expansion uses `EQUIVALENT_TOKEN_GROUPS` from `src/addressing.py`.

### osm

```
osm_pbf → osm_buildings_polygons    (osmium-derived building polygons + area centroids)
        → osm_addresses              (raw OSM addressed elements)
        → osm_landuse_residential    (assembled landuse polygons)

osm_addresses + osm_landuse_residential + address_tokens
    → osm_building_lookup            (per-building keyed for fast join)
```

Symmetric to `tiger`: extracts OSM reference data into
`geo_ducklake.osm`. The downstream `geocode` module consumes
`osm_building_lookup` along with `blockface_final` for coordinate
assignment.

`osm_building_lookup` is one row per OSM-known building, keyed on
`(zip_code, canonical_key, housenumber_norm)`, carrying:

- `osm_lat`, `osm_lon` — area-weighted centroid
- `street` — the raw OSM tag (used as canonical for building_id)
- `in_residential_complex` — true if the building's centroid is inside
  a `landuse=residential` polygon

### matching

```
persons_validated → persons_decomposed → persons_candidates
                                              │
blockface_final ──────────────────────────────┘
                                              │
                                       persons_scored
                                              │
                                       persons_best_match
```

The voter ↔ TIGER blockface step. Produces the highest-scoring blockface
per voter; coordinate assignment is downstream in `geocode`.

- `persons_decomposed` — parse `address_line_1` into house number,
  prefix, half_code, street tokens. Tokens have `STREET_REWRITES`
  applied before tokenization (see "Street-name handling").
- `persons_candidates` — for each voter, find every TIGER blockface
  where the zip/parity/prefix/range matches and the token overlap
  clears the "≥ 2 total + ≥ 1 distinctive" bar.
- `persons_scored` — score each candidate by token overlap + numeric-
  token bonus.
- `persons_best_match` — pick the highest-scoring blockface per voter
  (`ROW_NUMBER` + ranking).

### geocode

```
persons_best_match + persons_decomposed + blockface_final + osm_building_lookup
    → refined_positions              (TIGER-matched voter lat/lon)

persons_decomposed + persons_best_match + osm_building_lookup
                                       + blockface_final + address_tokens
    → osm_only_matches               (TIGER-miss voter lat/lon + snapped blockface)
```

The actual coordinate-assignment step. Two paths, mutually exclusive
(each voter appears in exactly one):

1. **`refined_positions`** — for TIGER-matched voters: project the OSM
   building centroid onto the matched blockface (or use the OSM centroid
   directly when the building is inside a `landuse=residential` polygon).
   A 1D shove keeps distinct buildings on the same blockface ≥ 4 m apart.
2. **`osm_only_matches`** — for TIGER-miss voters: derive a
   canonical_key from the raw voter address, look them up directly in
   OSM, and snap to the nearest blockface in their zip for downstream
   grouping.

`position_source` values:

- `osm_matched` — TIGER blockface, with the OSM-projected fraction along it
  - 7 m perpendicular offset
- `osm_complex` — OSM centroid used directly (no road projection), for
  voters inside a `landuse=residential` polygon (Co-op City, Stuy Town, …)
- `tiger_only` — DENSE_RANK rank-ramp fallback when no OSM building matched
- `osm_only` — TIGER-miss voter rescued via direct OSM lookup

### assembly

```
persons_best_match  + refined_positions + osm_only_matches + persons_decomposed
    → canonical_addresses

persons_validated + canonical_addresses + refined_positions + osm_only_matches
                                        + persons_best_match
    → persons_geocoded
    → geocoding_summary
```

- `canonical_addresses` — produce the canonical `address_line_1` and
  `matched_tokens` for each voter. Uses OSM street when available, falls
  back to TIGER `full_name` (see "Street-name handling").
- `persons_geocoded` — final canonical Person record: identity fields
  from the voter file, canonical address, lat/lon from
  `refined_positions` OR `osm_only_matches`, `building_id` + `door_id`
  derived from the canonical address.
- `geocoding_summary` — match-rate diagnostics, broken down by
  `position_source`.

### aggregate

```
persons_geocoded → buildings_geocoded
                 → doors_geocoded
```

A **building** is one physical structure: `address_line_1 + zip5`. A **door**
is one unit within a building: `address_line_1 + address_line_2 + zip5`.
lat/lng is the centroid of contained voters — they share an address so
coordinates match within float noise.

### boundaries

Loads administrative polygons (NYC Election Districts, ZIP areas, Census
tracts, etc.) into `geo_ducklake.boundaries.{key_group}`. Three loaders
write to the same shape:

- `boundary_from_blocks` (preferred) — union the TIGER census blocks where
  voters with each key live. No external shapefile needed; polygons match
  the voter file by construction.
- `boundary_from_geojson` — external GeoJSON (NYC Open Data, custom exports).
- `boundary_from_table` — already in DuckLake (TIGER ZCTAs, tracts, etc.).

### quickwit

Streams the Person records into a pre-existing Quickwit index for full-text
search. Uses the Quickwit CLI's `tool local-ingest` command over NDJSON
stdin.

## Street-name handling

The hardest part of the pipeline. Three sources, three transforms, three
uses. Everything lives in `src/addressing.py`.

### Three sources, three spellings

| Source               | Example for FDR Drive                                          | Notes                                          |
| -------------------- | -------------------------------------------------------------- | ---------------------------------------------- |
| Voter file (NYS BOE) | `"FRANKLIN D ROOSEVELT DRIVE"`, `"FDR DRIVE"`, `"F D R DRIVE"` | All-caps; abbreviations vary; occasional typos |
| TIGER (US Census)    | `"F D R Dr"`                                                   | USPS-abbreviated, authoritative for spelling   |
| OSM (community)      | `"FDR Drive"`                                                  | Inconsistent across contributors               |

### Three transforms (in order)

1. **`STREET_REWRITES`** — phrase-level regex find/replace before
   tokenization. Targets known synonyms that nothing else would collapse:
   `fdr` → `f d r`, `franklin d/delano roosevelt` → `f d r`. Applied
   uniformly on every source (voter, TIGER, OSM).

2. **`tokenize_street_sql`** — lowercase + trim, split on non-alphanumerics,
   dedupe, sort. Same recipe on every source.

3. **`EQUIVALENT_TOKEN_GROUPS`** — a table of synonyms loaded into
   `geo_ducklake.tiger.address_tokens`. Tokens that mean the same thing
   join groups: `[st, street, saint]`, `[ave, avenue, av]`, `[1st, first]`,
   etc. On both TIGER and OSM sides, the raw tokens get _expanded_ with
   every equivalent token in any joined group. So `"F D R Dr"` ends up
   with `[f, d, r, dr, drive]` — both forms present.

### Three uses of the tokens

Once everything is tokenized + expanded, the same token set is used for
three different purposes:

**A. Token-overlap matching** (in `persons_candidates`)

Voter tokens **intersect** TIGER blockface tokens. Passes if there are ≥ 2
overlapping tokens AND at least one is _distinctive_ (not in
`GENERIC_STREET_TOKENS`). Generic tokens (`east`, `street`, `avenue`, …)
don't identify a street on their own; intersect-only on those is
suspicious.

**B. `canonical_key`** (for OSM lookup)

For strict-equality matching against `osm_building_lookup`. Recipe: take
expanded tokens, drop generics, sort, join with `|`. So both `"F D R Dr"`
(TIGER) and `"FDR Drive"` (OSM) produce `canonical_key = "d|f|r"`. The
lookup is keyed on `(zip_code, canonical_key, housenumber_norm)`.

**C. `address_line_1`** (the human-readable display string)

This is what users see and what `building_id` is derived from. It is NOT a
tokenized form — it's a real address string like `"691 FDR DRIVE"`. Two
possible sources:

- **OSM `street`** (preferred when the voter matched an OSM building)
- **TIGER `full_name`** (when no OSM match)

We prefer OSM because OSM tags one street per building. Every voter at a
given building gets the same `osm_street`, regardless of how they wrote
the address. TIGER, by contrast, has multiple blockfaces for the same
physical street with different aliases (`"7th Ave"` vs `"Adam Clayton
Powell Jr Blvd"`), so voters at one building can get different `full_name`s
and end up with different `building_id`s. The OSM-canonical choice
prevents that whole class of dupe.

### Two different canonical-isms

The word "canonical" gets overloaded. There are two related-but-distinct
ideas:

- **TIGER is canonical for spelling standardization.** USPS-abbreviated
  form, used as the equivalency-group source of truth. When we have no
  better signal, TIGER's `full_name` is the canonical display string.
- **OSM is canonical for per-building identity.** Once we've matched a
  voter to a specific OSM building, that building's `osm_street` is the
  authoritative spelling **for that building**. Used so all voters at the
  same building share `address_line_1` and `building_id`.

These align most of the time. They diverge for streets that TIGER tags
under multiple aliases — and that's where the per-building rule wins.

### `housenumber_norm`

Queens hyphens (`132-01`, `132-1`) and OSM leading-zero padding can make
the same housenumber look different across sources. We normalize: strip
leading zeros after `^` or `-`, then strip hyphens entirely. So `132-01`,
`132-1`, and `13201` all become `1321`. Used in
`osm_building_lookup.housenumber_norm` for join keys; the original
`housenumber` is kept for display.

## building_id and door_id

```
building_id = "{address_line_1}|{zip5}"
door_id     = "{address_line_1}|{address_line_2}|{zip5}"
```

These are derived in `persons_geocoded`. The `|` separator keeps them
unambiguous. Single-family doors get an empty middle segment
(`address_line_1||zip5`) so `building_id` and `door_id` never collide.

`aggregate.buildings_geocoded` and `aggregate.doors_geocoded` GROUP BY
these keys to produce one row per physical structure / unit.

## Incremental vs non-incremental nodes

Most nodes are **incremental** — `CREATE TABLE IF NOT EXISTS` + insert
only new rows (`WHERE external_id NOT IN (SELECT external_id FROM …)`).
Re-running the pipeline after adding voters or a new county only processes
the new data.

The exceptions (drop + recreate every run) are:

- `refined_positions` — window functions partition on `blockface_id`; new
  voters would change everyone else's rank, so we have to recompute the
  whole table.
- `osm_only_matches` — same reason (the snap is keyed on the full set).
- `osm_building_lookup` — depends on `STREET_REWRITES` and equivalency
  groups, both of which can change between runs.
- `canonical_addresses` — `INSERT INTO … WHERE NOT IN` style, but the row
  set depends on whichever source matched per voter, so a re-run with new
  source data has to re-evaluate.
- `persons_geocoded` — pure assembly, cheap to redo.
- `geocoding_summary` — cheap diagnostic aggregate, always overwrites.

When you change anything upstream of these (matching rules, token rules,
OSM rewrites), you should `pnpm data:clear && pnpm data:mock` to fully
rebuild. Skipping the clear means you'll see the old behavior for already-
processed voters.

## Graph visualization

When a Hamilton module is added or modified, regenerate the visualizations:

```
uv run update-visualizations
```

Writes one PNG per module (`voter_file_loader_graph.png`, `tiger_graph.png`,
`osm_graph.png`, `matching_graph.png`, `geocode_graph.png`,
`assembly_graph.png`, `aggregate_graph.png`, `boundaries_graph.png`,
`quickwit_graph.png`) plus a combined `pipeline_graph.png` into `docs/`.
Graphviz must be installed (`brew install graphviz`).
