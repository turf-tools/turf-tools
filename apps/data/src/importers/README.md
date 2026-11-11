# Importers

An importer loads a voter file (or similar source) and produces `persons_validated`, the canonical table the shared geocode pipeline reads, plus the `Manifest` of filterable fields. An importer is chosen when initially creating an import, and importing every subsequent version uses the same importer.

Below we document the currently supported importer formats. We plan to expand this list over time.

## Formats

### New York State Voter File (`nys_voter_file`)

The NYSVOTER statewide export, laid out per the state's "Data File Layout for voter list exports from NYSVOTER". It includes 47 fields, with a list and order specified in `nys_voter_file/decode.py`. Accepted formats are:

- **`.txt`** — the raw export as the state ships it: no header, every field quoted, Latin-1. Fields are read by position.
- **`.csv`** — either the raw export (no header, read like the `.txt`) or a CSV (UTF-8 or Latin-1) whose first row names the columns.
- **`.parquet`** — columns named after the layout's fields.

A parquet may store codes as numbers: county and ZIP codes get their leading zeros back. Named columns match the layout's raw field names case-insensitively (`RZIP5`, `rzip5`, and `RZip5` are all fine). The fields the transform reads are required; the rest of the layout is optional, and columns outside it are ignored. A file missing required fields fails with the list of what's missing.

Purged records (status `P`) are dropped on read: they're no longer registrations, and a file that includes them lists a voter once per past county registration. A voter listed more than once keeps their current record (active over inactive, then the latest registration date), chosen before any import filter so a slice sees where the voter is registered now.

### Florida Voter File (`fl_voter_file`)

The Division of Elections' monthly voter extract, laid out per its "Voter Extract File Layout" (May 2026). It takes the two zips as the state distributes them:

- **Voter detail** (required) — `YYYYMMDD_VoterDetail.zip`, 67 county files named `CNT_YYYYMMDD.txt`, 38 tab-delimited fields each, field list in `fl_voter_file/decode.py`.
- **Voter history** (optional) — `YYYYMMDD_VoterHistory.zip`, county files named `CNT_H_YYYYMMDD.txt`, 5 fields each.

Members are found by name inside each zip, so the zips' own filenames don't matter. Quoting is off (stray `"` appear in names and addresses). Voters who requested a public-records exemption are dropped on read: their protected fields are all `*`. History joins on voter ID alone, because a history row records the county the voter lived in at the time. Only counted ballots become history (codes A, E, Y); `OTH` elections (local, municipal, special) get the `other` type. Precincts are only unique within a county, so they're stored county-prefixed (`DAD-135`).

## Adding an importer

Each importer is a package here: `importer.py` defines the class (the `Importer` protocol in `base.py`), supporting stages sit beside it, and the class is registered in `registry.py`. The class declares its `LABEL`, the files it reads (`SOURCES`, each a key, label, description, and whether it's required), and the columns a dataset may be filtered on (`FILTERS`). The web reads all of this from the data server's `GET /importers`, so the import form, its checks, and the dataset page's labels need no web changes. `load` receives the files as a mapping keyed by `SOURCES` and calls `check_import_inputs` before reading anything.

An importer first reads its source into `persons_raw`, naming each column after the source's own field name via `raw_column_name` in `base.py` (lowercased, with anything but letters and digits as `_`, so `RZIP5` becomes `rzip5`). Its transform is then the only place columns are renamed, onto the `Person` schema. Import filters name these raw columns, from the importer's `FILTERS`. When the source records each person's county, the transform fills `county_fips` with the 5-digit Census county code (`36061`), mapped from the source's own county codes; the import then downloads street data for just those counties. Leave it NULL otherwise and the ZIP code stands in.

Each person must come out once: validation rejects repeated IDs. If the source can list someone more than once, the transform picks one record per ID with `one_record_per_id_sql` (`dedupe.py`), ordered by the importer's own preference, before applying the import filter.

Each package must include sample files in `sample_data/`, named after the source they fill: `<source key>.<ext>`. The files that share an extension form one sample, a complete set of sources in one accepted format (NYS has three: `file.txt`, `file.csv`, and `file.parquet`; Florida has one: `detail.zip` with `history.zip`). These should be small files with a repeated set of invented people, each in its format's exact layout, all built by a corresponding `make_sample.py`. For testing, `tests/test_importers.py` loads every sample of every registered importer and runs the same checks on each (required columns, unique IDs, filters, repeatable results). It also checks that all of an importer's samples produce identical people. Tests that are unique to a specific format can go in a format-specific test file, like `tests/test_nys_voter_file.py`.
