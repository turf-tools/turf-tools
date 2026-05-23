import { expect, test } from "vite-plus/test";
import { normalizeEmail } from "../src/lib/normalize-email";

test("lowercases + trims", () => {
  expect(normalizeEmail("  Foo@Example.com  ")).toBe("foo@example.com");
});

test("strips dots in gmail local part", () => {
  expect(normalizeEmail("first.last@gmail.com")).toBe("firstlast@gmail.com");
  expect(normalizeEmail("F.I.R.S.T@gmail.com")).toBe("first@gmail.com");
});

test("preserves dots for non-gmail", () => {
  expect(normalizeEmail("first.last@outlook.com")).toBe("first.last@outlook.com");
});

test("preserves plus-addressing for gmail", () => {
  expect(normalizeEmail("user+test@gmail.com")).toBe("user+test@gmail.com");
  expect(normalizeEmail("u.s.e.r+test@gmail.com")).toBe("user+test@gmail.com");
});

test("plus tags remain distinct after normalization", () => {
  expect(normalizeEmail("user+a@gmail.com")).not.toBe(normalizeEmail("user+b@gmail.com"));
});

test("aliases googlemail.com to gmail.com", () => {
  expect(normalizeEmail("first.last@googlemail.com")).toBe("firstlast@gmail.com");
});

test("dots after the plus are preserved", () => {
  // We strip dots only before the first `+` so tag identity stays
  // exactly what the user typed.
  expect(normalizeEmail("user+t.est@gmail.com")).toBe("user+t.est@gmail.com");
});
