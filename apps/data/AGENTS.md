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
- `ducklake_geo` — TIGER blockfaces, OSM buildings, landuse polygons, boundary shapes

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

The input is a **voter file** — a state's voter roll export. The
downstream canonical schema is **Person** (`src/models.py`). We keep
"voter_file" in input-side names (`nys_voter_file`, `NysVoterFileImporter`)
because that's literally what's being loaded.
Everything after validation uses "person" because rows conform to the
Person schema regardless of source.

### Per-organization namespace

`ducklake` schemas are per-organization: `ducklake.{organization_slug}.*`.
The slug is the URL/SQL-safe identifier stored alongside `organizationId`
in `organizations` (`packages/db/src/schema/organizations.ts`).

`ducklake_geo` is organization-agnostic — TIGER and OSM data is shared
across every org and dataset on a deployment. Each import fetches what its
own addresses need (`tiger.geo_extent`): TIGER per county, OSM per state,
each loaded once and reused by later imports.

## The Hamilton modules

| Module       | Role                                                                                     | Output catalog       |
| ------------ | ---------------------------------------------------------------------------------------- | -------------------- |
| `tiger`      | TIGER shapefiles → `blockface_final`                                                     | `ducklake_geo.tiger` |
| `osm`        | OSM PBF → `osm_addresses_keyed` + raw OSM tables                                         | `ducklake_geo.osm`   |
| `matching`   | Voter ↔ TIGER blockface (`persons_best_match`)                                           | `ducklake.{org}`     |
| `geocode`    | Lat/lon assignment (`refined_positions`, `osm_only_matches`)                             | `ducklake.{org}`     |
| `assembly`   | Canonical Person record (`canonical_addresses`, `persons_geocoded`, `geocoding_summary`) | `ducklake.{org}`     |
| `aggregate`  | `persons_geocoded` → `buildings_geocoded` + `doors_geocoded`                             | `ducklake.{org}`     |
| `boundaries` | Derive polygons (EDs, zips) from voter data + TIGER blocks                               | `ducklake.{schema}`  |
| `quickwit`   | Stream Person records into a Quickwit search index                                       | external             |

`tiger` and `osm` are symmetric — both extract geographic reference
data into `ducklake_geo`. `matching`, `geocode`, `assembly`, and
`aggregate` form the per-voter pipeline that consumes those references.

### Importers (ahead of the DAG)

```
source → persons_raw → persons_transformed → persons_validated
```

Importers (`src/importers/`) sit outside Hamilton and hand the DAG its
`persons_validated` input. Each reads its format into `persons_raw`, runs
its state-specific SQL to map raw fields to the Person schema, and
validates the result. Formats and the testing convention are in
`src/importers/README.md`.

### tiger

```
persons_validated + zcta_counties → geo_extent ─► (counties to fetch)

tiger_addrfeat_raw ─┐
                    ├─► blockface_unpivoted → blockface_normalized → blockface_final
tiger_edges_raw  ───┘
address_tokens ──────────────────────────────────────────► blockface_final
```

`geo_extent` maps each address's (state, ZIP) to the counties that ZIP
overlaps, through the Census ZCTA-to-county crosswalk (`zcta_counties`).
The TIGER loaders download those counties' shapefiles (skipping any
already loaded) and join them into one blockface table. Each TIGER edge has both a left and right side with
independent house-number ranges; `blockface_unpivoted` splits each edge
into two rows (one per side).

`blockface_final` carries:

- house-number range (from, to) + parity (odd/even/mixed)
- side (left/right) + prefix
- `full_name` — canonical street name (alias-collapsed; see below)
- `street_tokens_match` — equivalency-expanded union of all alias rows'
  tokens (drives the matching predicate so a voter using any spelling
  matches)
- `street_tokens_lookup` — equivalency-expanded tokens of _only_ the
  canonical full_name (drives the OSM `canonical_key` lookup, so voters
  at the same building hit the same OSM record regardless of which
  alias their raw address used)
- a `GEOMETRY` representing the edge line

**Alias collapse.** When TIGER's addrfeat stores the same physical
blockface under multiple names (a street and its commemorative co-name,
abbreviation variants of the same name, …), those rows share
`(tlid, side, prefix, from, to)`. `blockface_final` collapses them into
one row, picking the canonical `full_name` by its frequency in the
line's own county (alphabetical tiebreak).

Equivalency expansion uses `EQUIVALENT_TOKEN_GROUPS` from
`src/addressing.py`. Rebuilt per state: the collapse needs all of a state's rows.

### osm

```
osm_pbfs → osm_buildings_polygons    (osmium-derived building polygons + area centroids)
         → osm_addresses              (raw OSM addressed elements)
         → osm_landuse_residential    (assembled landuse polygons)

osm_addresses + osm_landuse_residential + address_tokens
    → osm_addresses_keyed            (per element, keyed for voter lookup)
```

Symmetric to `tiger`: extracts OSM reference data into
`ducklake_geo.osm`, from the Geofabrik extract of each `geo_extent` state
not yet loaded (rows carry `state_fips`). The downstream `geocode` module consumes
`osm_addresses_keyed` along with `blockface_final` for coordinate
assignment.

`osm_addresses_keyed` is one row per addressed OSM element, with or
without a ZIP, keyed on `(canonical_key, housenumber_norm)`, carrying:

- `osm_id`, `kind` — the element (OSM numbers nodes and ways separately)
- `zip_code` — the `addr:postcode` tag; NULL for the many OSM imports
  that left it off
- `lat`, `lon` — area-weighted centroid for ways, the node's own point
- `street` — the OSM `addr:street` tag (the displayed street when TIGER
  doesn't name that street in the building's ZIP; see "Address handling")
- `housenumber` — the OSM `addr:housenumber` tag (used by
  `canonical_addresses` to normalize voter-side surface-form variants)
- `in_residential_complex` — true if the element's point is inside a
  `landuse=residential` polygon

Geocoding looks voters up two ways (`src/osm_lookup.py`). By ZIP: one
record per `(zip_code, canonical_key, housenumber_norm)`, the way (over a
node) with the smallest `osm_id` — deterministic across runs. For a voter
the ZIP lookup misses: the record with their key and number nearest their
matched blockface within `NEARBY_MATCH_M` (100 m), whatever ZIP it
carries.

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
  where the zip/parity/prefix/range matches, the token overlap
  clears the "≥ 2 total + ≥ 1 distinctive" bar, and the street numbers
  agree when both names carry one ("Beach 98 Street" never matches
  "Beach 149th St"). Implemented as an
  inverted-index join (unnest each side to one row per distinctive
  token, equi-join on token, then DISTINCT to dedupe by pair) — the
  list-overlap predicate becomes a hash-join key. The hydration step
  re-applies the range/prefix predicate so multi-row-per-blockface_id
  cases (multiple address ranges on one TIGER edge) hydrate
  deterministically.
- `persons_scored` — score each candidate by token overlap + numeric-
  token bonus.
- `persons_best_match` — pick the highest-scoring blockface per voter.
  A tie between different street names goes to the name that best
  matches what the voter wrote: the voter's words it contains, minus its
  words the voter didn't write ("West St" over "Little West St"). Then
  `blockface_id, full_name`, then the narrower of overlapping ranges,
  then the range itself, so every run picks the same row.

### geocode

```
persons_best_match + persons_decomposed + blockface_final + osm_addresses_keyed
    → refined_positions              (TIGER-matched voter lat/lon)

persons_decomposed + persons_best_match + osm_addresses_keyed
                                       + blockface_final + address_tokens
    → osm_only_matches               (TIGER-miss voter lat/lon + snapped blockface)
```

The actual coordinate-assignment step. Two paths, mutually exclusive
(each voter appears in exactly one):

1. **`refined_positions`** — for TIGER-matched voters: find the voter's
   OSM building by ZIP, or by location near the matched blockface when
   the ZIP finds nothing, and project its centroid onto the blockface
   (or use the OSM centroid directly when the projection clamps or the
   building is inside a residential complex). The rank-based fallback
   partitions by `(tiger_line_id, side)` and orders by `(prefix,
house_number, half_code)` so voters across multiple address ranges on
   the same physical TIGER line get distinct ranks, running from the end
   where the side's TIGER range starts. A 1D shove keeps distinct
   buildings on the same blockface ≥ 4 m apart.
2. **`osm_only_matches`** — for TIGER-miss voters: derive a
   canonical_key from the raw voter address, look them up directly in
   OSM (again with bare street numbers read as ordinals when that finds
   nothing: "WEST 127 STREET" as "West 127th Street"), and snap to the
   nearest blockface in their zip for downstream grouping.

`position_source` values:

- `osm_matched` — TIGER blockface, with the OSM-projected fraction along
  it + 7 m perpendicular offset
- `osm_complex` — OSM centroid used directly (no road projection), for
  voters inside a `landuse=residential` polygon
- `osm_off_segment` — OSM centroid used directly, for voters whose OSM
  building geometrically projects outside the matched TIGER blockface
  (TIGER's address range exceeds its physical line length). Avoids
  snapping the voter to the wrong endpoint of a too-short segment.
- `tiger_only` — DENSE_RANK rank-ramp fallback when no OSM building
  matched
- `osm_only` — TIGER-miss voter rescued via direct OSM lookup

### assembly

```
persons_best_match  + refined_positions + osm_only_matches + persons_decomposed
                    + address_tokens
    → canonical_addresses

persons_validated + canonical_addresses + refined_positions + osm_only_matches
                                        + persons_best_match
    → persons_geocoded
    → geocoding_summary
```

- `canonical_addresses` — produce the canonical `address_line_1`,
  `matched_tokens` and `building_zip5` for each voter, one address and
  one ZIP per building (see "Address handling").
- `persons_geocoded` — final canonical Person record: identity fields
  from the voter file, canonical address, lat/lon from
  `refined_positions` OR `osm_only_matches`, `building_id` + `door_id`
  derived from the canonical address and `building_zip5`.
- `geocoding_summary` — match-rate diagnostics, broken down by
  `position_source`.

### aggregate

```
persons_geocoded → buildings_geocoded
                 → doors_geocoded
```

A **building** is one physical structure: `address_line_1 + building_zip5`.
A **door** is one unit within a building:
`address_line_1 + address_line_2 + building_zip5`. lat/lng is the centroid
of contained voters.

### boundaries

Loads administrative polygons (NYC Election Districts, ZIP areas, Census
tracts, etc.) into the version's `ducklake.{schema}.{key_group}`. Three loaders
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

## Address handling

The pipeline pulls address strings from three sources, each with its own
spelling conventions:

| Source     | Example for FDR Drive                                          |
| ---------- | -------------------------------------------------------------- |
| Voter file | `"FRANKLIN D ROOSEVELT DRIVE"`, `"FDR DRIVE"`, `"F D R DRIVE"` |
| TIGER      | `"F D R Dr"`                                                   |
| OSM        | `"FDR Drive"`                                                  |

The strategy is straightforward: convert each source to a sorted token
set so the same physical street produces the same tokens regardless of
spelling, then use those tokens for matching and joining. For
human-readable output, pick the most authoritative source as the
display form.

Everything lives in `src/addressing.py`.

### Building blocks

SQL helpers — each is a function returning a SQL fragment that callers
embed in their own queries:

| Helper                                          | Purpose                                                                                                 |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `street_rewrite_sql(col)`                       | Apply phrase-level `STREET_REWRITES` rewrites before tokenizing (e.g. `fdr` → `f d r`).                 |
| `tokenize_street_sql(col)`                      | Produce a sorted, deduped, lowercase-alphanumeric token array.                                          |
| `canonical_key_sql(tokens)`                     | Sort + `\|`-join an (expanded) token array into a join-key string.                                      |
| `housenumber_norm_sql(col)`                     | Normalize a house number: strip leading zeros after `^` or `-`, then strip hyphens. Used as a join key. |
| `housenumber_display_sql(prefix, number, half)` | Assemble the human-readable house-number string.                                                        |

Lookup tables backing them:

- **`STREET_REWRITES`** — phrase-level regex rewrites applied
  uniformly to every source before tokenization (collapsing
  abbreviations that won't be caught by tokenization alone).
- **`EQUIVALENT_TOKEN_GROUPS`** — token synonyms (`[st, street, saint]`,
  `[ave, avenue, av]`, `[1st, first]`, …) materialized into the
  `address_tokens` table. Used to _expand_ a tokenized set with
  equivalent tokens so abbreviations and full forms both appear.
- **`GENERIC_STREET_TOKENS`** — directionals and street-type suffixes
  (`east`, `street`, `avenue`, …) that don't identify a street on
  their own. Used only by the matching predicate (see below).

### The token pipeline

The same three-step pipeline runs on every source — voter raw strings
(`persons_decomposed`), TIGER `full_name` (`blockface_final`), and OSM
`addr:street` (`osm_addresses_keyed`):

```
raw → street_rewrite_sql → tokenize_street_sql → expand via address_tokens
```

After this, the same physical street produces the same token set
everywhere.

### Where the tokens get used

**1. Token-overlap matching** (`persons_candidates`). Voter tokens
intersect TIGER blockface tokens; passes if ≥ 2 tokens overlap and at
least one is non-generic. The non-generic requirement keeps voters
from matching wrong streets that happen to share only directionals or
street-type words.

**2. OSM lookup `canonical_key`** (`refined_positions`,
`osm_only_matches`). `canonical_key_sql(tokens)` produces the join-key
string. Both sides — voter and OSM record — produce the same
canonical_key for the same street, so the OSM lookup is a
strict-equality join on `(canonical_key, housenumber_norm)`, narrowed by
ZIP or by distance from the matched blockface (`src/osm_lookup.py`).
Every token participates: not stripping "generic" suffixes keeps
parallel streets like `60 Place` and `60 Lane` distinct.

**3. Display `address_line_1`** (`canonical_addresses`). The human-
readable canonical address that drives `building_id`, settled once per
building so everyone in it shares one. A building is the OSM record
voters matched (`osm_kind`, `osm_id`), else a TIGER blockface side plus
address.

The street is spelled as TIGER spells it, so one street reads the same
along a block (`EAST 77TH STREET` → `E 77TH ST`). Voters with no OSM
match show TIGER's canonical `full_name` (the most-common alias for the
matched range, picked in `blockface_final`). An OSM building shows how
TIGER-matched voters in the building's ZIP spell its street (the TIGER
name with the same key as OSM's `addr:street`), or OSM's `addr:street`
when TIGER doesn't name that street in the ZIP.

The housenumber part prefers OSM's `addr:housenumber` when it
normalizes to the same string as the voter's parsed form (so
surface-form variants like `646` ↔ `6-46` unify); otherwise keeps the
voter's form (so OSM subunit suffixes like `100A` don't overwrite
voter-correct forms like `100`).

`building_zip5` is the most common voter ZIP in the building (lowest
on ties). Voters at one building sometimes write different ZIPs; each
keeps their own `zip5` for filters and exports, and the building's ids
use `building_zip5`.

## building_id and door_id

```
building_id = "{address_line_1}|{building_zip5}"
door_id     = "{address_line_1}|{address_line_2}|{building_zip5}"
```

These are derived in `persons_geocoded`. The `|` separator keeps them
unambiguous. Single-family doors get an empty middle segment
(`address_line_1||building_zip5`) so `building_id` and `door_id` never
collide.

`aggregate.buildings_geocoded` and `aggregate.doors_geocoded` GROUP BY
these keys to produce one row per physical structure / unit; a
building's `zip5` there is its `building_zip5`.

## Incremental vs non-incremental nodes

Most nodes are **incremental** — `CREATE TABLE IF NOT EXISTS` + insert
only new rows (`WHERE external_id NOT IN (SELECT external_id FROM …)`).
Re-running the pipeline after adding voters or a new county only processes
the new data.

The exceptions (drop + recreate every run) are:

- `blockface_final` — alias collapse + canonical-name pick need to see
  all of a state's rows (rebuilt per state).
- `osm_addresses_keyed` — depends on `STREET_REWRITES` and equivalency
  groups, both of which can change between runs (rebuilt per state).
- `refined_positions` — window functions partition on
  `(tiger_line_id, side)`; new voters would change everyone else's
  rank.
- `osm_only_matches` — same reason (the snap is keyed on the full set).
- `persons_geocoded` — pure assembly, cheap to redo.
- `buildings_geocoded` / `doors_geocoded` — aggregations over
  `persons_geocoded`.
- `geocoding_summary` — cheap diagnostic aggregate, always overwrites.

Other tables (`persons_decomposed`, `persons_candidates`,
`persons_scored`, `persons_best_match`, `canonical_addresses`) are
incremental. When you change SQL upstream of these, `pnpm data:clear`
(or `data:clear:all` if geo references changed too) is required to
rebuild — skipping the clear means existing rows keep their old values.

## Determinism

Same input + same code should produce byte-identical output across
runs. To preserve that:

- `arg_max(x, key)` and similar tie-prone aggregates need a tiebreaker
  in `key` (e.g. include `osm_id` after the primary criterion). The
  pure form picks arbitrarily on ties.
- `SELECT DISTINCT ON (k) …` needs an explicit `ORDER BY` that
  uniquely determines the row to keep.
- `ROW_NUMBER() OVER (… ORDER BY a, b, …)` is only deterministic when
  the ORDER BY clause uniquely orders the partition. Include enough
  columns to break every realistic tie.

When adding any of these constructs, lean on the natural keys
(`osm_id`, `blockface_id`, `full_name`, …) for the tiebreaker.

## Graph visualization

When a Hamilton module is added or modified, regenerate the visualizations:

```
uv run update-visualizations
```

Writes one PNG per module (`tiger_graph.png`, `osm_graph.png`,
`matching_graph.png`, `geocode_graph.png`, `assembly_graph.png`,
`aggregate_graph.png`, `boundaries_graph.png`, `quickwit_graph.png`) plus a combined `pipeline_graph.png` into `docs/`.
Graphviz must be installed (`brew install graphviz`).
