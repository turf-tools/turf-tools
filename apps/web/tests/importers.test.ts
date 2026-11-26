import { expect, test } from "vite-plus/test";
import { isReadableSource } from "../src/lib/importers";

test("http(s) links and local paths are readable", () => {
  expect(isReadableSource("https://example.com/voters.parquet")).toBe(true);
  expect(isReadableSource("http://example.com/voters.parquet")).toBe(true);
  expect(isReadableSource("/data/voters.parquet")).toBe(true);
  expect(isReadableSource("~/fixtures/voters.parquet")).toBe(true);
  expect(isReadableSource("")).toBe(true);
});

test("other URL schemes are not", () => {
  expect(isReadableSource("s3://bucket/voters.parquet")).toBe(false);
  expect(isReadableSource("gs://bucket/voters.parquet")).toBe(false);
});
