# Quickwit Notes

This file records the behavior we verified locally for Quickwit `0.8.2` and the conclusions that matter for the data app.

Quickwit binary used for testing:

```bash
./quickwit-v0.8.2/quickwit
```

## Our Use Case

We want the data app to:

- take a voter-file `TableRef` produced by the Hamilton graphs
- index it on the dedicated large build machine
- avoid writing a giant temporary NDJSON file to disk
- append to an already-created Quickwit index
- keep serving/search compute separate from indexing compute

That is now implemented in `src/dags/quickwit.py`.

## Confirmed Quickwit Behavior

These points were tested directly against the local `0.8.2` binary.

### `tool local-ingest` works without a running Quickwit node

Once the target index already exists, `quickwit tool local-ingest` can run with no long-lived Quickwit server running during ingest.

Practical flow:

1. Start a Quickwit server briefly.
1. Create the index.
1. Stop the server.
1. Run `tool local-ingest` repeatedly on the builder machine.

OR:

1. Create an index against an already running small Quickwit server
1. Run `tool local-ingest`

### `tool local-ingest` appends

If `--overwrite` is not used, repeated `tool local-ingest` runs append to the existing index.

### `tool local-ingest` supports stdin in `0.8.2`

This is the most important result for us.

We do **not** need a giant NDJSON file on disk. We can stream NDJSON batches to `tool local-ingest` via stdin.

### FIFO / named-pipe input is not supported as `--input-path`

Using a FIFO path failed. So the bounded-disk solution is stdin, not `--input-path` on a named pipe.

### Reusing the same filename for multiple `tool local-ingest` runs is unsafe

Re-ingesting a file at the same path caused the follow-up ingest to fail. So if we ever use file-based ingest again, file paths should be unique.

For the main DAG we avoid this problem entirely by using stdin.

## Hamilton DAG Shape

The Quickwit DAG follows the same Hamilton style as the other graphs.

Current nodes:

- `quickwit_source_voter_data`
- `quickwit_document_count`
- `quickwit_local_ingest_result`
- `quickwit_build_manifest_stub`

Input:

- `voter_file_table_ref: TableRef`

The DAG assumes the target Quickwit index already exists.

## JSON Construction Strategy

We originally built Python dicts and called `json.dumps(...)` row-by-row in Python.

That was replaced with DuckDB-side JSON construction:

```sql
SELECT to_json(
  struct_pack(...)
) AS ndjson_line
FROM <source_table>
```

Python now only:

- fetches batches of prebuilt NDJSON lines
- joins each batch with newlines
- sends the batch to `quickwit tool local-ingest` via stdin

This keeps the DAG simple and was measurably faster.

## Performance Findings

### 100k rows

After moving NDJSON construction into DuckDB:

- loader: `15.16s`
- ingest: `7.32s`
- rows indexed: `100,000`
- batch size tested: `25,000`

Before the DuckDB-side JSON change, ingest time was `7.82s`, so this saved about `0.5s` on the 100k run.

### 2M rows batch-size sweep

Measured ingest times:

- `25,000`: `162.84s`
- `50,000`: `78.59s`
- `100,000`: `41.52s`
- `250,000`: `25.93s`
- `500,000`: `17.74s`
- `1,000,000`: `13.46s`
- `2,000,000`: `11.70s`

Conclusion: for 2M rows, larger batches were consistently faster.

### Full file (`13,494,914` rows)

Measured ingest times:

- `1,000,000`: `124.30s`
- `2,000,000`: `90.97s`
- `5,000,000`: `85.10s`

Conclusion: for the full file, `5,000,000` was fastest among the tested values, with `2,000,000` close enough that it may be the safer operational default if memory matters.

## Batch Size Default

The app default remains:

```python
quickwit_batch_size = 1_000_000
```

Why keep the default at `1,000,000` even though larger values were faster?

- it is materially faster than small batches
- it keeps memory pressure lower than `2M` or `5M`
- it is a safer default for more machines and more datasets

If the builder machine has ample memory and maximum throughput is the priority, larger batch sizes can be used.

## Memory Notes

We measured the actual NDJSON payload for `1,000,000` voter rows with the current schema:

- average NDJSON line length: `281.66` bytes
- total NDJSON payload: `281,662,260` bytes
- about `281.7 MB` decimal / `268.6 MiB` binary

That is only the raw JSON payload.

With the current implementation, each batch is still held in Python as:

1. a list of NDJSON strings
1. one newline-joined batch string passed to `subprocess.run(...)`

So practical memory usage is higher than raw payload size.

Rule of thumb:

- `1M` rows: budget about `~1 GiB` of free headroom
- `2M` rows: expect meaningfully more
- `5M` rows: multi-GB working memory is likely

The current implementation successfully handled `5M` batches in this environment.

## How Quickwit Merges Splits Here

In this setup, the `tool local-ingest` process itself acts as the indexer.

That means:

- it creates splits
- it applies the index merge policy
- it uploads/publishes the resulting index artifacts

There is no separate long-lived search node or background worker doing normal split merging for this offline build path.

## Recommended Operating Guidance

For now:

- keep the default batch size at `1_000_000`
- increase to `2_000_000` or `5_000_000` only on machines with enough memory
- prefer stdin streaming over file-based ingest
- treat the Quickwit index as already-created infrastructure

If we want to reduce memory pressure further, the next improvement is to replace the current `subprocess.run(input=...)` approach with a streaming `Popen(...).stdin.write(...)` implementation.
