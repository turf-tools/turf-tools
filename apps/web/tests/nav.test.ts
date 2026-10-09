import { test, expect } from "vite-plus/test";
import { homeNavItem, PRIMARY, SECONDARY, visibleNavItems } from "../src/lib/nav";

test("a lead sees the turfs board plus personal pages", () => {
  expect(visibleNavItems(PRIMARY, "lead").map((i) => i.label)).toEqual(["Turfs"]);
  expect(visibleNavItems(SECONDARY, "lead").map((i) => i.label)).toEqual(["Settings", "Account"]);
  expect(homeNavItem("lead").label).toBe("Turfs");
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
