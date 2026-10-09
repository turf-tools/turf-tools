import { test, expect } from "vite-plus/test";
import { canManage, hasPermission, PERMISSIONS } from "../src/lib/permissions";

test("owner and admin hold every permission", () => {
  for (const p of PERMISSIONS) {
    expect(hasPermission("owner", p)).toBe(true);
    expect(hasPermission("admin", p)).toBe(true);
  }
});

test("lead holds only what the turfs board calls", () => {
  const held = ["turfs.read", "campaigns.read", "walks.read", "walks.write"];
  for (const p of PERMISSIONS) {
    expect(hasPermission("lead", p)).toBe(held.includes(p));
  }
});

test("a permission list requires every entry", () => {
  expect(hasPermission("admin", ["progress.read", "results.read"])).toBe(true);
  expect(hasPermission("lead", ["turfs.read", "progress.read"])).toBe(false);
});

test("unknown roles hold nothing", () => {
  expect(hasPermission("member", "turfs.read")).toBe(false);
});

test("rank: manage members at or below your own rank", () => {
  expect(canManage("owner", "owner")).toBe(true);
  expect(canManage("owner", "admin")).toBe(true);
  expect(canManage("owner", "lead")).toBe(true);
  expect(canManage("admin", "owner")).toBe(false);
  expect(canManage("admin", "admin")).toBe(true);
  expect(canManage("admin", "lead")).toBe(true);
  expect(canManage("lead", "lead")).toBe(true);
  expect(canManage("admin", "member")).toBe(false);
});
