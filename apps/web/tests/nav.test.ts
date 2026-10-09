import { test, expect } from "vite-plus/test";
import { homeNavItem, PRIMARY, SECONDARY, visibleNavItems, type NavItem } from "../src/lib/nav";

const labels = (items: NavItem[], role: string) => visibleNavItems(items, role).map((i) => i.label);

test("a turf viewer sees the turfs board plus personal pages", () => {
  expect(labels(PRIMARY, "turf_viewer")).toEqual(["Turfs"]);
  expect(labels(SECONDARY, "turf_viewer")).toEqual(["Settings", "Account"]);
  expect(homeNavItem("turf_viewer").label).toBe("Turfs");
});

test("an analytics viewer sees progress, results and reports", () => {
  expect(labels(PRIMARY, "analytics_viewer")).toEqual(["Progress", "Results", "Reports"]);
  expect(labels(SECONDARY, "analytics_viewer")).toEqual(["Settings", "Account"]);
  expect(homeNavItem("analytics_viewer").label).toBe("Progress");
});

test("a campaign editor sees everything except users and data", () => {
  expect(labels(PRIMARY, "campaign_editor")).toEqual(labels(PRIMARY, "admin"));
  expect(labels(SECONDARY, "campaign_editor")).toEqual(["Settings", "Account"]);
});

test("owner and admin see every tab", () => {
  for (const role of ["owner", "admin"]) {
    expect(visibleNavItems([...PRIMARY, ...SECONDARY], role)).toHaveLength(
      PRIMARY.length + SECONDARY.length,
    );
  }
  expect(homeNavItem("admin").label).toBe("Overview");
});

test("no membership sees nothing gated", () => {
  expect(visibleNavItems(PRIMARY, null)).toEqual([]);
});
