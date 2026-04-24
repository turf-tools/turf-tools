# Data Package

## Use `uv`

Use `uv` for everything, even running basic temporary scripts.

## DuckDB API Style

Prefer the DuckDB **relational API** and **expression API** over raw SQL strings. Use methods like `conn.read_parquet()`, `rel.filter()`, `rel.project()`, `rel.aggregate()`, `rel.join()`, etc. to construct queries as composable relation objects rather than interpolating SQL.

## Hamilton Graph Pattern

Hamilton nodes in this package do not return actual data. All data lives in DuckLake.

Each node performs its work via the DuckDB relational API against the DuckLake connection and returns a **`TableRef`** dataclass containing:

- **catalog** — the DuckLake catalog name
- **schema** — the schema within the catalog
- **table** — the table name
- **version** — the DuckLake snapshot version at the time the node completed

Downstream nodes accept these table references as inputs and use them to locate the data in DuckLake for subsequent operations. No dataframes or relations are passed between nodes. The `TableRef` dataclass is defined in `models.py`.

## Three-Graph Architecture

There are three Hamilton graphs in this package. All three share a **single DuckDB connection** that has two DuckLake catalogs attached (`ducklake` for voter data, `geo_ducklake` for TIGER geo reference data). The connection is created by `db.get_connection()`.

### Graph 1 — `src/dags/voter_file_loader.py`

Loads and normalises a client voter file into `ducklake`.

```
raw_voter_data → transformed_voter_data → validated_voter_data
```

Output: `ducklake.main.{client}_voters` conforming to the `Person` schema.

### Graph 2 — `src/dags/tiger.py`

Downloads US Census TIGER/Line shapefiles and builds a normalised blockface
table in `geo_ducklake`. This data is reusable across multiple client voter
files — run once per state/county/year combination.

```
tiger_addrfeat_raw ──┐
                      ├─► blockface_unpivoted → blockface_normalized → blockface_final
tiger_edges_raw ─────┘
address_token_table ──────────────────────────────────────────────► blockface_final
```

Key inputs: `tiger_year`, `tiger_state_fips`, `tiger_county_fips`, `tiger_data_dir`.

Output: `geo_ducklake.tiger.blockface` — one row per street side with normalised
house number ranges, parity, expanded street name tokens, node IDs, and geometry.

Token expansion uses `src/address_tokens.py` (`EQUIVALENT_TOKEN_GROUPS`) to ensure
abbreviated and full-form street type tokens (e.g. `st` / `street`,
`ave` / `avenue`) are interchangeable at match time.

### Graph 3 — `src/dags/geocode.py`

Matches voter addresses against TIGER blockfaces and interpolates lat/lon
coordinates along the matched edge geometry. Writes results to `ducklake`.

```
validated_voter_data → decomposed_voter_addresses → candidate_blockfaces
                                                          │
blockface_final ──────────────────────────────────────────┘
                                                          │
                                                   scored_matches
                                                          │
                                                     best_match
                                                          │
                                                  geocoded_voters
                                                          │
                                                geocoding_summary
```

The cross-catalog join between `ducklake.main.{client}_voters_decomposed` and
`geo_ducklake.tiger.blockface` runs on the single shared connection — no data
is copied between catalogs.

Match scoring: token overlap count + numeric token bonus (extra weight when a
numeric token like `"42"` appears in the overlap, reducing false matches on
numbered streets).

Coordinate interpolation: `ST_LineInterpolatePoint(geom, fraction)` where
`fraction = (house_num - range_min) / (range_max - range_min)`, clamped to
`[0, 1]`.

Output tables (all in `ducklake.main.*`):

- `{client}_voters_decomposed` — parsed house numbers and street tokens
- `{client}_voters_candidates` — all matching voter–blockface pairs
- `{client}_voters_scored` — pairs with match scores
- `{client}_voters_best_match` — top-ranked blockface per voter
- `{client}_voters_geocoded` — final lat/lon (NULL for unmatched voters)
- `{client}_geocoding_summary` — match rate diagnostics

## Incremental Processing

All nodes use `CREATE TABLE IF NOT EXISTS` followed by incremental inserts
keyed on a natural identifier (e.g. `external_id`, `blockface_id`,
`(state_fips, county_fips)`). Re-running a graph after adding new counties or
new voter rows will only process the new data. Hamilton's own caching layer
handles node-level skipping.

The exception is `geocoding_summary`, which always overwrites since it is a
cheap diagnostic aggregate.

## Graph Visualization

When a Hamilton graph module is added or modified, regenerate its visualizations:

```
uv run update-visualizations
```

This writes `voter_file_loader_graph.png`, `tiger_graph.png`,
`geocode_graph.png`, and `pipeline_graph.png` into `docs/`. Graphviz (`dot`)
must be installed (`brew install graphviz`).
