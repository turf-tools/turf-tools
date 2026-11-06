# Importers

An importer loads a voter file (or similar source) and produces `persons_validated`, the canonical table the shared geocode pipeline reads, plus the `Manifest` of filterable fields. An importer is chosen when initially creating an import, and importing every subsequent version uses the same importer.

Below we document the currently supported importer formats. We plan to expand this list over time.

## Formats

### New York State Voter File (`nys_voter_file`)

The NYSVOTER statewide export, laid out per the state's "Data File Layout for voter list exports from NYSVOTER". It includes 47 fields, with a list and order specified in `nys_voter_file/decode.py`. Accepted formats are:

- **`.txt`** — the raw export as the state ships it: no header, every field quoted, Latin-1. Fields are read by position.
- **`.csv`** — either the raw export (no header, read like the `.txt`) or a UTF-8 CSV whose first row names the columns.
- **`.parquet`** — columns named after the layout's fields.

Named columns match the layout's raw field names case-insensitively (`RZIP5`, `rzip5`, and `RZip5` are all fine). The fields the transform reads are required; the rest of the layout is optional, and columns outside it are ignored. A file missing required fields fails with the list of what's missing.

## Adding an importer

Each importer is a package here: `importer.py` defines the class (the `Importer` protocol in `base.py`), supporting stages sit beside it, and the class is registered in `registry.py` and mirrored in the web's `apps/web/src/lib/importers.ts`.

An importer first reads its source into `persons_raw`, naming each column after the source's own field name via `raw_column_name` in `base.py` (lowercased, with anything but letters and digits as `_`, so `RZIP5` becomes `rzip5`). Its transform is then the only place columns are renamed, onto the `Person` schema. Import filters name these raw columns, from the importer's `FILTER_COLUMNS`.

Each package must include `sample_data/sample.<ext>` with one file per accepted format. These should be small files with a repeated set of invented people, each in its format's exact layout, all built by a corresponding `make_sample.py`. For testing, `tests/test_importers.py` loads every sample of every registered importer and runs the same checks on each (required columns, unique IDs, filters, repeatable results). It also checks that all of an importer's samples produce identical people. Tests that are unique to a specific format can go in a format-specific test file, like `tests/test_nys_voter_file.py`.
