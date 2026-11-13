import { expect, test } from "vite-plus/test";
import { addressCase, nameCase, surnameCase, titleCase, unitCase } from "../src/lib/display-case";

test("a name in capitals is title-cased", () => {
  expect(nameCase("JOHN")).toBe("John");
  expect(nameCase("MCDONALD")).toBe("McDonald");
  expect(nameCase("O'BRIEN")).toBe("O'Brien");
  expect(nameCase("MARY-JANE")).toBe("Mary-Jane");
  expect(nameCase("DE LA CRUZ")).toBe("De La Cruz");
});

test("generational suffixes keep their capitals; Jr and Sr don't", () => {
  expect(nameCase("III")).toBe("III");
  expect(nameCase("II")).toBe("II");
  expect(nameCase("IV")).toBe("IV");
  expect(nameCase("JR")).toBe("Jr");
  expect(nameCase("SR")).toBe("Sr");
});

test("a name the file wrote in mixed case keeps its casing", () => {
  expect(nameCase("McDonald")).toBe("McDonald");
  expect(nameCase("Flores")).toBe("Flores");
  expect(nameCase("  DeLeon ")).toBe("DeLeon");
});

test("Mc takes a capital everywhere, whatever the file's case", () => {
  expect(nameCase("COMEAU-MCDONALD")).toBe("Comeau-McDonald");
  expect(nameCase("Alcima-Mcdonald")).toBe("Alcima-McDonald");
  expect(nameCase("Mcdonald")).toBe("McDonald");
  expect(nameCase("Vargas Mcnally")).toBe("Vargas McNally");
  expect(nameCase("MC KENNA")).toBe("Mc Kenna");
});

test("in a last name, a lone O or D before a name was an apostrophe", () => {
  expect(surnameCase("O RIORDAN")).toBe("O'Riordan");
  expect(surnameCase("D ANGELO")).toBe("D'Angelo");
  expect(surnameCase("O Brien")).toBe("O'Brien");
  expect(surnameCase("K AHMED")).toBe("K Ahmed");
});

test("first names keep a lone initial and aren't looked up as surnames", () => {
  expect(nameCase("D SCOTT")).toBe("D Scott");
  expect(nameCase("O J")).toBe("O J");
  expect(nameCase("ONEIL")).toBe("Oneil");
  expect(nameCase("OMARA")).toBe("Omara");
});

test("listed surnames get their apostrophe back", () => {
  expect(surnameCase("OBRIEN")).toBe("O'Brien");
  expect(surnameCase("Obrien")).toBe("O'Brien");
  expect(surnameCase("OGARRO")).toBe("O'Garro");
  expect(surnameCase("DAGOSTINO")).toBe("D'Agostino");
  expect(surnameCase("SMITH-OCONNOR")).toBe("Smith-O'Connor");
  expect(surnameCase("ONEIL")).toBe("O'Neil");
  expect(surnameCase("ODELL")).toBe("Odell");
  expect(surnameCase("DARCY")).toBe("Darcy");
  expect(surnameCase("OCHOA")).toBe("Ochoa");
  expect(surnameCase("O'BRIEN")).toBe("O'Brien");
});

test("a backtick is read as an apostrophe", () => {
  expect(nameCase("O`BRIEN")).toBe("O'Brien");
  expect(surnameCase("O`Neill")).toBe("O'Neill");
});

test("Mac names are left alone, since MACIAS and MACHADO aren't Mac-names", () => {
  expect(nameCase("MACIAS")).toBe("Macias");
  expect(nameCase("MACDONALD")).toBe("Macdonald");
});

test("addresses keep quadrants and route prefixes in capitals", () => {
  expect(addressCase("1234 SW 152ND AVE")).toBe("1234 SW 152nd Ave");
  expect(addressCase("10 NE 4TH ST")).toBe("10 NE 4th St");
  expect(addressCase("500 US HWY 1")).toBe("500 US Hwy 1");
  expect(addressCase("12 SR 60")).toBe("12 SR 60");
  expect(addressCase("100 E 77TH ST")).toBe("100 E 77th St");
});

test("SR is State Road in an address and Senior in a name", () => {
  expect(addressCase("12 SR 60")).toBe("12 SR 60");
  expect(nameCase("SR")).toBe("Sr");
});

test("of, the and and are lowercased inside an address but not at its start", () => {
  expect(addressCase("1185 AVENUE OF THE AMERICAS")).toBe("1185 Avenue of the Americas");
  expect(addressCase("THE PLAZA")).toBe("The Plaza");
});

test("house numbers keep their capitals; ordinals don't", () => {
  expect(addressCase("100A MAIN ST")).toBe("100A Main St");
  expect(addressCase("75-10 KISSENA BLVD")).toBe("75-10 Kissena Blvd");
  expect(addressCase("47 1/2 WEST ST")).toBe("47 1/2 West St");
  expect(addressCase("21ST AVE")).toBe("21st Ave");
});

test("street words and cities", () => {
  expect(addressCase("99 STOCKTON STREET")).toBe("99 Stockton Street");
  expect(addressCase("321 MCDONALD AVE")).toBe("321 McDonald Ave");
  expect(addressCase("12 ST JOHN'S PL")).toBe("12 St John's Pl");
  expect(addressCase("MIAMI BEACH")).toBe("Miami Beach");
  expect(addressCase("")).toBe("");
  expect(addressCase(null)).toBe("");
});

test("labels are title-cased word by word", () => {
  expect(titleCase("presidential primary")).toBe("Presidential Primary");
  expect(titleCase("FL 2")).toBe("Fl 2");
  expect(titleCase("o'neil-smith")).toBe("O'Neil-Smith");
  expect(titleCase(null)).toBe("");
});

test("unit words are title-cased and unit codes kept as stored", () => {
  expect(unitCase("APT 16D")).toBe("Apt 16D");
  expect(unitCase("UNIT 220")).toBe("Unit 220");
  expect(unitCase("2 FL")).toBe("2 Fl");
  expect(unitCase("2ND FLOOR")).toBe("2nd Floor");
  expect(unitCase("BSMT")).toBe("BSMT");
  expect(unitCase("PH M")).toBe("PH M");
  expect(unitCase("PVT HSE")).toBe("PVT HSE");
  expect(unitCase("SPC 42")).toBe("Spc 42");
  expect(unitCase("LOT H-13")).toBe("Lot H-13");
  expect(unitCase("PO BOX 167")).toBe("PO Box 167");
});

test("a bare unit code reads as an apartment", () => {
  expect(unitCase("16D")).toBe("Apt 16D");
  expect(unitCase("1E")).toBe("Apt 1E");
  expect(unitCase("GA")).toBe("Apt GA");
  expect(unitCase("PHV")).toBe("Apt PHV");
  expect(unitCase("#3B")).toBe("Apt 3B");
  expect(unitCase("# 3B")).toBe("Apt 3B");
});

test("no unit gives an empty string", () => {
  expect(unitCase(null)).toBe("");
  expect(unitCase("  ")).toBe("");
  expect(unitCase("#")).toBe("");
});

test("a floor written run-together is two words", () => {
  expect(unitCase("2FL")).toBe("2 Fl");
  expect(unitCase("1FL")).toBe("1 Fl");
  expect(unitCase("3FLR")).toBe("3 Flr");
  expect(unitCase("16D")).toBe("Apt 16D");
});

test("a bare ordinal reads as a floor", () => {
  expect(unitCase("2ND")).toBe("2nd Fl");
  expect(unitCase("1ST")).toBe("1st Fl");
  expect(unitCase("2ND FLOOR")).toBe("2nd Floor");
});
