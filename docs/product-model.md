# Product model

Living record of the product-level model that the web admin UI, the data
pipeline, and the native canvasser app all share. Written down so nobody has
to reconstruct it from code. Intended audience: contributors + future-you.
Incomplete by design — deferrable questions are flagged at the end.

## Vocabulary

| Term             | What it is                                                               | Notes                                                                                   |
| ---------------- | ------------------------------------------------------------------------ | --------------------------------------------------------------------------------------- |
| **Organization** | The tenant — an org using Field Tools.                                   | Has a `slug` (URL/SQL-safe id) used to namespace DuckLake tables.                       |
| **Person**       | A canvassable record. The canonical schema in `apps/data/src/models.py`. | Usually sourced from a state/BOE voter file, but the schema is general.                 |
| **Segment**      | A query over Person data.                                                | Standalone, reusable across campaigns. Composable.                                      |
| **Zone group**   | A container for a set of zones, pinned to one key group.                 | Key group is immutable once set.                                                        |
| **Key group**    | The type of administrative unit zones are built from.                    | Strings like `"nyc_eds"`, `"nyc_zips"`, `"census_tract"`. Resolved by the data service. |
| **Zone**         | A named set of keys within a zone group.                                 | E.g. "Bushwick North" = a specific set of ED ids.                                       |
| **Campaign**     | Glue between a segment, a zone group, and a script.                      | Has dates + metadata. Zones become available for turf cutting under the campaign.       |
| **Turf**         | A specific polygon cut within a campaign's zone.                         | Assigned to a canvasser. Immutable once cut (marked stale if parents change).           |

## Entity relationships

```
organizations ─── segments (many)
      │            └── query (jsonb, referencing other segments via segmentRef)
      │
      ├── zone_groups (many)
      │       └── zones (many) — each with keys[]
      │
      ├── scripts (many)
      │
      └── campaigns (many)
              ├── segment (1, fk)
              ├── zone_group (1, fk)
              ├── script (1, fk)
              └── turfs (many) — cut from one zone of the zone_group each
```

Segments, zone groups, and scripts are **standalone**: referenced by campaigns,
not owned by them. One segment can be used by many campaigns.

## The three editors

The admin UI has three primary authoring surfaces, each with a clear focus.
Iteration between them is expected and natural — users hop between segment ↔
zone until both feel right, then commit in a campaign.

| Tool                | Route             | Authors                                           | Map's job                                                                                              |
| ------------------- | ----------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| **Segment editor**  | `/segments/$id`   | A voter query (filters, composition, geo-filters) | Visualize who matches the in-progress query; click-to-select primitive for populating geo filter lists |
| **Zone editor**     | `/zones/$groupId` | Named sets of keys inside a zone group            | Zone-assignment state + optional segment overlay for density context                                   |
| **Campaign editor** | `/campaigns/$id`  | The commitment: segment × zone group × script     | Shows the committed combination + turf-cutter entry per zone                                           |

Each is _authoring_ one thing. The other concerns are _consulted_ (visualized)
but not edited there.

### Separation of concerns

- **Segments reference voter fields only.** No `zoneRef` in the query DSL.
  A "base voters in these EDs" segment has `{ field: "electionDistrict", in: [...] }`
  with the ED list baked in as strings. If the user wants to initialize that
  list from a zone, a one-shot "Copy keys from zone X" button does it at
  author time with no ongoing coupling.
- **Zones reference keys only.** No `segmentRef` or segment metadata inside
  zones. A zone is `{ keys[], name, zoneGroupId }`.
- **Campaigns are thin commitments.** They don't author zones or segments —
  they pick existing ones. If the user wants to edit a zone or segment from
  the campaign workspace, deep-link to the appropriate editor.

### What "locked" means in the campaign workspace

Only the **references** are locked (which segment, which zone group). The
contents of those entities stay editable from either surface. Editing a zone
in a campaign workspace = editing the canonical zone, visible to all
campaigns that reference its zone group. Turfs from affected campaigns are
marked stale via timestamp comparison.

## Shared UI primitive: key picker on a map

Both the zone editor and the segment editor's geo-filter helper need the same
interaction: render all polygons for a key group, let the user click/shift-click
to build a set of keys. Different destinations:

- Zone editor: selected keys → `zones.keys` array
- Segment editor geo filter: selected keys → `segment.query` in-clause

One component, one primitive. Callers decide what to do with the result.

## Boundary data pipeline

Boundary polygons (ED shapes, ZIP shapes, etc.) live in DuckLake:

```
geo_ducklake.boundaries.{key_group}
    key   VARCHAR
    name  VARCHAR (nullable)
    geom  GEOMETRY (simplified for rendering)
```

One table per key group. Loaded by Hamilton DAGs (`apps/data/src/dags/boundaries.py`):

- `boundary_from_geojson` — for external sources (NYC Open Data, etc.)
- `boundary_from_table` — for TIGER-derived sources already in DuckLake

Seeded via `uv run seed-boundaries` at setup time. When admin-upload UIs
arrive, same loader, different trigger.

## Data flow: web ↔ data

- **Through apps/web RPC**: anything dynamic/typed/needs auth — list queries,
  mutations, counts, search results. Normal API surface.
- **Direct to apps/data over HTTP**: large static-ish blobs — turf data,
  boundary polygons, tile sets. Cached aggressively, fetched by URL, treated
  like S3 objects.

Boundary GeoJSON served as `GET /key-groups/{key_group}/geojson?v={version}`
with `Cache-Control: immutable`. Version is the zone group's `updatedAt` as a
Unix millis string — when seed contents change, URLs change, caches bust.

## Person properties: curation and rendering

The `Person` schema (`apps/data/src/models.py`) is intentionally narrow at
the top level: identity, name, address, plus a generic `other_properties:
dict[str, str | None]`. Everything voter-file-specific that's worth
preserving (party, gender, date of birth, district fields, voter history,
etc.) lives in `other_properties` as string-valued key/value pairs.

Both the admin UI and the native app consume this dict, but they curate
**independently** — different lists, different metadata shapes, different
purposes.

### Native: `OTHER_PROPERTY_KEYS` (display)

Lives in `apps/native/src/lib/voter-properties.ts` (or similar). Each entry
specifies a key + a renderer because some need transformation (e.g. age
computed from `date_of_birth`):

```ts
export const OTHER_PROPERTY_KEYS = [
  { key: "date_of_birth", render: (v: string) => `${computeAgeFromYYYYMMDD(v)}` },
  { key: "gender", render: (v: string) => v.charAt(0).toUpperCase() },
  { key: "party", render: (v: string) => v },
] as const;
```

Adding a badge = append to the list. Removing = delete a line. No type
changes elsewhere.

### Admin: `OTHER_PROPERTY_KEYS` (filters)

Lives in `apps/web/src/lib/voter-properties.ts`. Different shape — filter
metadata for the segment editor's leaf-filter picker:

```ts
export const OTHER_PROPERTY_KEYS = [
  { key: "party",             label: "Party",   kind: "enum", values: ["DEM", "REP", ...] },
  { key: "gender",            label: "Gender",  kind: "enum", values: ["M", "F"] },
  { key: "date_of_birth",     label: "Age",     kind: "age-range" },
  { key: "election_district", label: "ED",      kind: "key-list", keyGroup: "nyc_eds" },
] as const;
```

The `kind` drives the filter UI component (enum dropdown, age-range slider,
key-on-map picker, etc.).

### Why two independent lists

- **Filter-but-not-display**: `election_district` is useful as a filter but
  meaningless as a badge (canvasser sees "65039" — no context).
- **Display-but-not-filter**: rare but possible.
- **Different shapes anyway**: native needs renderers; admin needs filter
  metadata. Forcing one structure would compromise both.

### Age handling

Always raw `date_of_birth` in `other_properties`, never pre-computed `age`.
Native computes at render time. Admin's segment query passes `kind: "age-range"`
and the data service interprets at SQL time using the current date. No
pre-computation, no staleness, single source of truth.

### Turf blob carries the dict generically

`TurfDataPerson` carries a `properties: { [key: string]: string | null }`
field rather than the previous typed `party / age / gender`. The turf-blob
builder copies `other_properties` through unchanged. Adding properties to
the curated set doesn't change the blob shape — only the lists.

```ts
type TurfDataPerson = {
  personId: string;
  firstName: string | null;
  lastName: string | null;
  properties: { [key: string]: string | null };
};
```

### Where the constants live

App-local for now (`apps/native/src/lib/voter-properties.ts` and
`apps/web/src/lib/voter-properties.ts`). The lists naturally diverge because
their shapes differ — sharing a single source would compromise both. If the
key strings drift accidentally between apps, lift them into a shared
`packages/utils` module then. Until that happens, app-local is fine.

## External data (planned, not built)

Users will need to pull in external per-entity metadata to make good targeting
decisions. Expected shape:

- **Person-level**: `person_flags(external_id, flag_type, value)` —
  hostile contacts, rent-stabilized lists, DNC markers.
- **Door-level**: `door_flags(door_id, flag_type, value)` — security-entrance
  flagging.
- **Building-level**: `building_flags(building_id, flag_type, value)` —
  inaccessible buildings.
- **Key-level**: `key_metadata(key_group, key, column, value)` — other-race
  performance per ED, demographic rollups, tier assignments.

Structural guidance:

- Separate tables keyed per level. Keeps core entities clean, opt-in per org.
- Segment query DSL should accept new leaf types additively (e.g.
  `{ flag: "hostile", eq: false }`) without rewrites.
- Zone editor's table should be column-flexible — built-in columns plus
  whichever external columns exist for the key group.
- Ingestion mirrors the voter-file pattern: Hamilton DAG per source, CLI
  seed until an upload UX lands.

## Staleness

Turfs are immutable once cut but can become stale if the segment or zone
they were cut against changes.

Rule: turf is stale if `segment.updatedAt > turf.createdAt` OR
`zone.updatedAt > turf.createdAt`. Computed at read time, surfaced as a flag
in the RPC response. UI shows a "stale" pill on affected turfs; user decides
whether to re-cut.

Edits to a shared zone or segment from a campaign workspace propagate to all
referencing campaigns. Optional UX safety nets when that matters (warning on
save, cross-campaign usage counts, "save as copy" fork) are deferred.

### Autosave model and the "deployment artifact"

Segments and zones autosave on every edit (debounced, no Save button).
Why this is safe even though they're referenced by active campaigns:
**turfs are the deployed artifact, not segments or zones**. Editing a
segment changes the recipe; cutting turf bakes the cake. Existing turfs
in the field don't change when the recipe later changes — they just
become stale relative to it, surfaced via the timestamp rule above.

This is why we don't need a versioning system (separate
`segment_versions` table, explicit publish step, `(segmentId, version)`
campaign references): the deployment ceremony already exists, it's just
located at "cut turf" rather than at "save segment." Staleness detection
via `updatedAt > createdAt` is sufficient.

Implication: `updatedAt` on segments and zone groups must bump on
edits that affect turf membership (query / keys), but should _not_
bump on cosmetic edits like rename. Be deliberate about which mutations
touch `updatedAt`.

Plan for when this matters: build the campaign editor + turf-cutting UI
first. The staleness pill + "recut" affordance lives on the campaign
view, where the user is looking at turfs. Don't surface anything in the
segment / zone editors themselves — those are upstream and the user
shouldn't have to think about consumers there.

## Deferred questions

- **Tiers / external metadata** as first-class UI — flagged above, not
  scheduled.
- **Mid-campaign edit semantics** beyond timestamp-based staleness (e.g.
  snapshotting on "activate campaign").
- **Size constraints** on zones (the 5,000-door rule, canvasser-shift limits)
  — where they live, how they're surfaced, how they warn.
- **Auth / roles / permissions** — currently no real auth distinction.
  Multi-user phase will need admin / field-director / canvasser roles.
- **Voter-file reimport** — what happens when `nys_boe v2` drops. Does a
  campaign auto-bump its reference? What marks stale?
- **Campaign lifecycle** — draft / active / archived enum + its implications
  for editability and reference-holding.
- **Job runner for long-running data operations** (voter file loads,
  boundary ingests, Quickwit reindexes) — currently manual CLI.

These don't block the current build of the three editors. Worth keeping in
mind so architectural choices stay open to them.
