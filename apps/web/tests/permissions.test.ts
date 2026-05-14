import { test, expect } from "vite-plus/test";
import { hasPermission } from "../src/lib/permissions";

test("owner grants every permission", () => {
  expect(hasPermission("owner", "users.manage")).toBe(true);
  expect(hasPermission("owner", "campaigns.write")).toBe(true);
  expect(hasPermission("owner", "segments.write")).toBe(true);
  expect(hasPermission("owner", "zones.write")).toBe(true);
  expect(hasPermission("owner", "turfs.publish")).toBe(true);
});

test("admin grants everything except users.manage", () => {
  expect(hasPermission("admin", "users.manage")).toBe(false);
  expect(hasPermission("admin", "campaigns.write")).toBe(true);
  expect(hasPermission("admin", "segments.write")).toBe(true);
  expect(hasPermission("admin", "zones.write")).toBe(true);
  expect(hasPermission("admin", "turfs.publish")).toBe(true);
});

test("unknown role denies everything", () => {
  expect(hasPermission("turf_cutter", "users.manage")).toBe(false);
  expect(hasPermission("turf_cutter", "campaigns.write")).toBe(false);
  expect(hasPermission("", "campaigns.write")).toBe(false);
});
