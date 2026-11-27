import { test, expect } from "vite-plus/test";
import { canManage, hasPermission, PERMISSIONS, ROLE_NAMES } from "../src/lib/permissions";

test("owner and admin hold every permission", () => {
  for (const p of PERMISSIONS) {
    expect(hasPermission("owner", p)).toBe(true);
    expect(hasPermission("admin", p)).toBe(true);
  }
});

test("turf viewer holds only what the turfs board calls", () => {
  const held = ["turfs.read", "campaigns.read", "walks.read", "walks.write"];
  for (const p of PERMISSIONS) {
    expect(hasPermission("turf_viewer", p)).toBe(held.includes(p));
  }
});

test("campaign editor holds everything except users, datasets and person exports", () => {
  for (const p of PERMISSIONS) {
    const denied = p === "users.manage" || p === "datasets.manage" || p === "persons.export";
    expect(hasPermission("campaign_editor", p)).toBe(!denied);
  }
});

test("only owners and admins export people; report exports follow reports.read", () => {
  for (const role of ROLE_NAMES) {
    const ownerOrAdmin = role === "owner" || role === "admin";
    expect(hasPermission(role, "persons.export")).toBe(ownerOrAdmin);
    expect(hasPermission(role, "reports.export")).toBe(hasPermission(role, "reports.read"));
  }
});

test("analytics viewer holds no write and no person-level permission", () => {
  for (const p of PERMISSIONS) {
    if (p.endsWith(".write") || p === "persons.read" || p === "users.manage") {
      expect(hasPermission("analytics_viewer", p)).toBe(false);
    }
  }
  expect(hasPermission("analytics_viewer", ["progress.read", "results.read", "reports.read"])).toBe(
    true,
  );
});

test("a permission list requires every entry", () => {
  expect(hasPermission("admin", ["progress.read", "results.read"])).toBe(true);
  expect(hasPermission("turf_viewer", ["turfs.read", "progress.read"])).toBe(false);
});

test("unknown roles hold nothing", () => {
  expect(hasPermission("member", "turfs.read")).toBe(false);
});

test("rank: manage members at or below your own rank", () => {
  expect(canManage("owner", "owner")).toBe(true);
  expect(canManage("owner", "admin")).toBe(true);
  expect(canManage("owner", "turf_viewer")).toBe(true);
  expect(canManage("admin", "owner")).toBe(false);
  expect(canManage("admin", "admin")).toBe(true);
  expect(canManage("admin", "turf_viewer")).toBe(true);
  expect(canManage("turf_viewer", "turf_viewer")).toBe(true);
  expect(canManage("turf_viewer", "campaign_editor")).toBe(true);
  expect(canManage("admin", "member")).toBe(false);
});
