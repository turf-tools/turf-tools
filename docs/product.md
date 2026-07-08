# Product

Living record of the product-level model that the web admin UI, the data
pipeline, and the native canvasser app all share. Written down so nobody has
to reconstruct it from code. Intended audience: contributors + future-you.
Incomplete by design — deferrable questions are flagged at the end.

## Vocabulary

| Term             | What it is                                                               | Notes                                                                                   |
| ---------------- | ------------------------------------------------------------------------ | --------------------------------------------------------------------------------------- |
| **Organization** | The tenant — an org using Field Tools.                                   | Has a `slug` (URL/SQL-safe id) used to namespace DuckLake tables.                       |
| **Person**       | A canvassable record. The canonical schema in `apps/data/src/models.py`. | Usually sourced from a state/BOE voter file, but the schema is general.                 |
| **Segment**      | A criteria definition (filter set) over Person data.                     | Standalone, reusable across campaigns.                                                  |
| **Zone group**   | A container for a set of zones, pinned to one key group.                 | Key group is immutable once set.                                                        |
| **Key group**    | The type of administrative unit zones are built from.                    | Strings like `"nyc_eds"`, `"nyc_zips"`, `"census_tract"`. Resolved by the data service. |
| **Zone**         | A named set of keys within a zone group.                                 | E.g. "Bushwick North" = a specific set of ED ids.                                       |
| **Campaign**     | Glue between a segment, a zone group, and a script.                      | Has dates + metadata. Zones become available for turf cutting under the campaign.       |
| **Turf**         | A specific polygon cut within a campaign's zone.                         | Has a draft phase while being authored, then published as an immutable snapshot.        |

## Entity relationships

```
organizations ─── segments (many)
      │            └── criteria (jsonb)
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
              ├── turf_drafts (many) — author-time scratchpad, replaced on each save
              └── turfs (many) — published snapshots, cut from one zone each
                      └── turf_data (1) — the buildings → doors → persons blob
```

Segments, zone groups, and scripts are **standalone**: referenced by campaigns,
not owned by them. One segment can be used by many campaigns.

## The admin surfaces

The admin UI has four primary surfaces plus the cutter. Each editor authors
one thing; the other concerns are _consulted_ (visualized) but not edited
there. Iteration between them is expected and natural — users hop between
segment ↔ zone until both feel right, then commit in a campaign and cut turf.

| Tool                | Route                                | Authors                                       | Map's job                                                                                            |
| ------------------- | ------------------------------------ | --------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| **Segment editor**  | `/segments?segmentId=…`              | Person-data criteria (filter set)             | Visualize who matches the in-progress criteria; click-to-select primitive for populating geo filters |
| **Zone editor**     | `/zones?groupId=…`                   | Named sets of keys inside a zone group        | Zone-assignment state + optional segment overlay for density context                                 |
| **Campaign editor** | `/campaigns?campaignId=…`            | The commitment: segment × zone group × script | Shows the committed combination + turf-cutter entry per zone                                         |
| **Turfs view**      | `/turfs?campaignId=…`                | (read-only) — list of published turfs         | n/a — table view, no map                                                                             |
| **Turf cutter**     | `/campaigns/$campaignId/cut/$zoneId` | Polygon-drawn turfs within a single zone      | Drawing surface; buildings ∩ polygon become the turf's deployable artifact                           |

The active entity id lives in URL search params, not in the path. Loaders
redirect to the alphabetical-first survivor when the URL id is missing or
invalid — handles delete, bookmark, and direct-link cases automatically.

### Creating entities

Creation is **dialog-free** by default: "New segment" / "New script" immediately
creates an auto-named `Untitled segment` (numbered — `Untitled segment 2`, …) and
drops the user into the editor; they rename later. The name is deferrable, so a
naming step is pure friction — especially for the throwaway "scratch" segments
users spin up to try an idea. A creation **dialog** is reserved for the cases
where creation needs up-front config that can't be edited in afterward: **zones**
(key type) and **campaigns** (the segment × zone group × script bindings).

### Separation of concerns

- **Segments reference voter fields only.** No `zoneRef` in the criteria DSL.
  A "base voters in these EDs" segment has `{ field: "electionDistrict", in: [...] }`
  with the ED list baked in as strings. If the user wants to initialize that
  list from a zone, a one-shot "Copy keys from zone X" button does it at
  author time with no ongoing coupling. (Button itself not yet built.)
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

## Shared UI primitive: key picker on a map (design intent)

Both the zone editor and the segment editor's geo-filter helper need the same
interaction: render all polygons for a key group, let the user click/shift-click
to build a set of keys. Different destinations:

- Zone editor: selected keys → `zones.keys` array
- Segment editor geo filter: selected keys → `segment.criteria` in-clause

The intent is one component, one primitive. Currently the zone editor has its
polygon-click flow built; the segment editor's geo-filter doesn't yet wire up
to the same primitive — the click-to-select interaction lives only in zones.
Folding the two together is a follow-up.

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

- **Through apps/web RPC** (oRPC over HTTP): anything dynamic/typed/needs auth
  — list queries, mutations, counts, the turf-data blob fetched by canvasser
  app. Normal API surface, lives in `apps/web/src/rpc/`.
- **Direct to apps/data over HTTP**: large static-ish data the web layer
  doesn't need to mediate. Two endpoints today:
  - `GET /key-groups/{key_group}/geojson?v={version}` — boundary polygons.
    Cached aggressively (`Cache-Control: immutable`); version is the zone
    group's `updatedAt` as Unix millis, so when seed contents change, URLs
    change and caches bust.
  - `POST /query` — opaque SQL evaluation against the persons/buildings
    tables; used by `apps/web` for criteria counts, point overlays, and
    per-key aggregates. (Not exposed publicly — only the web RPC layer
    calls it.)
- **Points overlay** — served from `POST /api/segment-points` on the web app
  itself, returning a packed `Float32Array` (lng, lat repeated). Bypasses the
  oRPC JSON envelope so the per-byte decode never hits the main thread.

## Person properties: curation and rendering

The `Person` schema (`apps/data/src/models.py`) is intentionally narrow at
the top level: identity, name, address, plus a generic `other_properties:
dict[str, str | None]`. Everything voter-file-specific that's worth
preserving (party, gender, date of birth, district fields, voter history,
etc.) lives in `other_properties` as string-valued key/value pairs.

Both the admin UI and the native app consume this dict, but they curate
**independently** — different code paths, different metadata shapes,
different purposes.

### Native: per-property formatters (display)

Lives in `apps/native/src/lib/turf-data.ts` as small helpers — `formatAge`,
`formatGender`, `formatParty` — each reads from `otherProperties` and applies
the transformation needed for that field (age computed from `date_of_birth`,
gender uppercased to first letter, etc.). Adding a badge today means adding a
formatter and using it in the relevant view.

### Admin: filter definitions

Lives in `apps/web/src/lib/filters.ts` as a `FILTERS` array of discriminated-
union specs. Each filter declares its `key`, `label`, `kind` (`"enum"`,
`"age-range"`, `"text"`, etc.), and where the field lives (`source: "column"`
for top-level columns vs `"other_properties"` for the JSON dict). The `kind`
drives the filter UI component (enum dropdown, age-range slider, free-text
input, etc.).

### Why two independent lists

- **Filter-but-not-display**: `election_district` is useful as a filter but
  meaningless as a badge (canvasser sees "65039" — no context).
- **Display-but-not-filter**: rare but possible.
- **Different shapes anyway**: native needs renderers; admin needs filter
  metadata. Forcing one structure would compromise both.

### Age handling

Always raw `date_of_birth` in `other_properties`, never pre-computed `age`.
Native computes at render time. Admin's age filter passes `kind: "age-range"`
and the data service interprets at SQL time using the current date. No
pre-computation, no staleness, single source of truth.

### Turf blob carries the dict generically

`TurfDataPerson` carries an `otherProperties` field rather than typed
`party / age / gender`. The turf-blob builder copies `other_properties`
through unchanged. Adding properties to the curated lists doesn't change the
blob shape — only the consuming code.

```ts
type TurfDataPerson = {
  personId: string;
  firstName: string | null;
  lastName: string | null;
  otherProperties: Record<string, string | null>;
};
```

### Where the constants live

App-local for now: native formatters in `apps/native/src/lib/turf-data.ts`,
admin filter specs in `apps/web/src/lib/filters.ts`. The lists diverge because
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
- Segment criteria DSL should accept new leaf types additively (e.g.
  `{ flag: "hostile", eq: false }`) without rewrites.
- Zone editor's table should be column-flexible — built-in columns plus
  whichever external columns exist for the key group.
- Ingestion mirrors the voter-file pattern: Hamilton DAG per source, CLI
  seed until an upload UX lands.

## Turf lifecycle

Turfs go through two phases:

1. **Drafts** (`turf_drafts` table) — author-time scratchpad. While the user
   is in the cutter, every polygon edit auto-saves (debounced) by replacing
   the entire drafts set for that `(campaignId, zoneId)`. No partial state
   on the server, no merging logic. Drafts have a polygon and a name; no
   building/door materialization yet.
2. **Published** (`turfs` + `turf_data` tables) — at publish time, the
   batch of drafts for the zone is converted to immutable turf rows. The
   server intersects each polygon with the persons/buildings tables, builds
   the buildings → doors → persons blob, and inserts both `turfs` (one row,
   metadata) and `turf_data` (one row, the heavy blob) in one transaction
   per turf. Batched insert keeps publishing a single zone's turfs to ~3
   round trips instead of dozens.

Turfs are immutable once published. No edit, no delete (yet — see deferred
questions). Re-cutting means deleting and re-publishing — currently a manual
cleanup, scoped as a future PR.

The two-phase model means the cutter UX is fast (autosave, no manual save
ceremony) while the canvassing artifact is stable (a published turf doesn't
change underfoot when the user keeps drawing).

## Staleness

Published turfs can become stale if the segment or zone they were cut
against changes.

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
**published turfs are the deployed artifact, not segments or zones**.
Editing a segment changes the recipe; publishing turf bakes the cake.
Existing turfs in the field don't change when the recipe later changes —
they just become stale relative to it, surfaced via the timestamp rule
above.

This is why we don't need a versioning system (separate
`segment_versions` table, explicit publish step on segments,
`(segmentId, version)` campaign references): the deployment ceremony
already exists, it's just located at "publish turf" rather than at "save
segment." Staleness detection via `updatedAt > createdAt` is sufficient.

### `updatedAt` bumping — current behavior

Today, all of `segments.rename`, `segments.updateCriteria`,
`zoneGroups.rename`, `zones.rename`, and `zones.updateKeys` bump
`updatedAt`. This means cosmetic renames trigger downstream staleness on
turfs even though the recipe didn't actually change.

Trade-off: simple to reason about (any edit = bump), false-positive prone
(renames flag turfs as stale needlessly). The cleaner version would scope
the bump to mutations that actually change turf membership (criteria,
keys) — leaving renames alone. Worth tightening if false-positive
staleness pills become a UX problem; not yet a problem in practice.

Plan for when staleness becomes user-visible: the staleness pill +
"recut" affordance lives on the campaign view, where the user is looking
at turfs. Don't surface anything in the segment / zone editors themselves
— those are upstream and the user shouldn't have to think about
consumers there.

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
