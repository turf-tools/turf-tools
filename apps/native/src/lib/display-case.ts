// Display casing for text: labels, voter-file names, addresses and units. Kept
// identical in apps/web/src/lib/display-case.ts and
// apps/native/src/lib/display-case.ts.
//
// Addresses are stored in capitals and names keep the voter file's case
// (see "Capitalization" in apps/data/AGENTS.md), so addresses are always
// title-cased here, and names only when the file wrote them in capitals; every
// name gets the Mc and apostrophe fixes.

// Title-case a label ("presidential primary" → "Presidential Primary",
// "FL 2" → "Fl 2"): the first letter of each word and of each segment after a
// hyphen or apostrophe. Returns "" for null/undefined/empty.
export function titleCase(text: string | null | undefined): string {
  if (!text) return "";
  return text.toLowerCase().replace(/(?:^|[\s\-'])\p{L}/gu, (c) => c.toUpperCase());
}

// Generational suffixes keep their capitals in names.
const NAME_CAPITALS = new Set(["II", "III", "IV"]);

// Quadrants and route prefixes keep their capitals in addresses.
const ADDRESS_CAPITALS = new Set(["NE", "NW", "SE", "SW", "US", "SR"]);

// Lowercased inside an address, never as its first word ("Avenue of the Americas").
const ADDRESS_MINOR = new Set(["of", "the", "and"]);

// A word that starts with a digit keeps its capitals except an ordinal
// ending: "100A", "16D", "77th", "2nd".
function numberCase(word: string): string {
  return word
    .toUpperCase()
    .replace(/^(\d+)(ST|ND|RD|TH)$/u, (_m, n: string, s: string) => n + s.toLowerCase());
}

// One word: "O'BRIEN" → "O'Brien", "MARY-JANE" → "Mary-Jane",
// "MCDONALD" → "McDonald", "JOHN'S" → "John's", "100A" and "77th" as above.
function wordCase(word: string, capitals: Set<string>): string {
  const upper = word.toUpperCase();
  if (capitals.has(upper)) return upper;
  if (/^\d/u.test(word)) return numberCase(word);
  return word
    .toLowerCase()
    .replace(/(^|[-'])(\p{L})/gu, (_m, sep: string, letter: string) => sep + letter.toUpperCase())
    .replace(/'S$/u, "'s")
    .replace(
      /(^|[-'])Mc(\p{L})/gu,
      (_m, sep: string, letter: string) => `${sep}Mc${letter.toUpperCase()}`,
    );
}

// Surnames voter files write without their apostrophe ("OBRIEN"): Irish O'
// names, two Caribbean families (O'Garro, O'Farrill) and Italian D' names.
// Hand-kept, since nothing in "OBRIEN" says an apostrophe was there; "ODELL"
// and "DARCY" are names in their own right.
const APOSTROPHE_NAMES = new Map(
  [
    "O'Brien",
    "O'Connor",
    "O'Neill",
    "O'Donnell",
    "O'Connell",
    "O'Sullivan",
    "O'Leary",
    "O'Neil",
    "O'Hara",
    "O'Reilly",
    "O'Neal",
    "O'Keefe",
    "O'Rourke",
    "O'Shea",
    "O'Malley",
    "O'Toole",
    "O'Grady",
    "O'Hare",
    "O'Loughlin",
    "O'Keeffe",
    "O'Callaghan",
    "O'Shaughnessy",
    "O'Dea",
    "O'Mara",
    "O'Donoghue",
    "O'Boyle",
    "O'Meara",
    "O'Gorman",
    "O'Byrne",
    "O'Donovan",
    "O'Bryan",
    "O'Bryant",
    "O'Dwyer",
    "O'Flaherty",
    "O'Dowd",
    "O'Regan",
    "O'Farrell",
    "O'Mahony",
    "O'Quinn",
    "O'Day",
    "O'Higgins",
    "O'Reardon",
    "O'Hair",
    "O'Garro",
    "O'Farrill",
    "D'Agostino",
    "D'Alessandro",
    "D'Ambrosio",
    "D'Alessio",
    "D'Orazio",
    "D'Amore",
    "D'Antuono",
    "D'Amour",
  ].map((name) => [name.replace("'", "").toUpperCase(), name]),
);

// "Mc" before a name takes a capital whatever case the voter file used:
// "Mcdonald" → "McDonald", "Thomas-Mcgee" → "Thomas-McGee".
function mcCase(name: string): string {
  return name.replace(
    /(^|[\s\-'])Mc(\p{Ll})/gu,
    (_m, sep: string, letter: string) => `${sep}Mc${letter.toUpperCase()}`,
  );
}

// Any part of a name. In capitals it's title-cased ("MCDONALD" → "McDonald",
// "III" stays); in mixed case it keeps the voter file's casing ("DeLeon").
// Either way "Mc" takes a capital, and a backtick is read as an apostrophe.
export function nameCase(text: string | null | undefined): string {
  const trimmed = (text ?? "").trim().replace(/`/gu, "'");
  if (!trimmed) return "";
  const cased = /\p{Ll}/u.test(trimmed)
    ? trimmed
    : trimmed
        .split(/\s+/)
        .map((word) => wordCase(word, NAME_CAPITALS))
        .join(" ");
  return mcCase(cased);
}

// A last name: `nameCase`, then apostrophes back where a lone O or D stood
// before a name ("O RIORDAN" → "O'Riordan") and on listed names ("OBRIEN" →
// "O'Brien"). Surnames only: "D SCOTT" and "ONEIL" are first names as written.
export function surnameCase(text: string | null | undefined): string {
  return nameCase(text)
    .replace(/^([OoDd]) (?=\p{L}{3})/u, (_m, letter: string) => `${letter.toUpperCase()}'`)
    .replace(/\p{L}+/gu, (word) => APOSTROPHE_NAMES.get(word.toUpperCase()) ?? word);
}

// A street address or city: "1234 SW 152ND AVE" → "1234 SW 152nd Ave".
export function addressCase(text: string | null | undefined): string {
  const trimmed = (text ?? "").trim();
  if (!trimmed) return "";
  return trimmed
    .split(/\s+/)
    .map((word, i) =>
      i > 0 && ADDRESS_MINOR.has(word.toLowerCase())
        ? word.toLowerCase()
        : wordCase(word, ADDRESS_CAPITALS),
    )
    .join(" ");
}

// Words naming the kind of unit: the USPS secondary unit designators
// (Publication 28, Appendix C2) plus the spelled-out and local forms voter files
// use. Every other word in a unit line is the unit's own code and keeps its
// capitals ("16D", "PHV", "GA").
const UNIT_WORDS = new Set([
  // USPS
  "APT",
  "BSMT",
  "BLDG",
  "DEPT",
  "FL",
  "FRNT",
  "HNGR",
  "KEY",
  "LBBY",
  "LOT",
  "LOWR",
  "OFC",
  "PH",
  "PIER",
  "REAR",
  "RM",
  "SIDE",
  "SLIP",
  "SPC",
  "STOP",
  "STE",
  "TRLR",
  "UNIT",
  "UPPR",
  // Voter files
  "APARTMENT",
  "BUILDING",
  "SUITE",
  "ROOM",
  "FLOOR",
  "FLR",
  "FRONT",
  "NUM",
  "TOP",
  "GROUND",
  "GRND",
  "PVT",
  "HSE",
  "BOX",
]);

// Unit words that keep their capitals: they don't read as abbreviations
// title-cased ("Bsmt", "Ph").
const UNIT_CAPITALS = new Set(["PH", "BSMT", "FRNT", "PVT", "HSE"]);

// A unit line: "APT 16D" → "Apt 16D", "2FL" → "2 Fl", "2ND FLOOR" →
// "2nd Floor", "PVT HSE" stays. A bare code says nothing about what it is, so
// it reads as an apartment ("16D" → "Apt 16D", "#3B" → "Apt 3B"), and a bare
// ordinal as a floor ("2ND" → "2nd Fl").
export function unitCase(text: string | null | undefined): string {
  const words = (text ?? "")
    .trim()
    .replace(/^#\s*/u, "")
    .split(/\s+/)
    .filter(Boolean)
    .flatMap((word) => {
      const glued = /^(\d+)(\p{L}+)$/u.exec(word);
      return glued && UNIT_WORDS.has(glued[2].toUpperCase()) ? [glued[1], glued[2]] : [word];
    });
  if (words.length === 0) return "";
  const named = words.some((word) => UNIT_WORDS.has(word.toUpperCase()));
  const cased = words
    .map((word) => {
      const upper = word.toUpperCase();
      if (UNIT_CAPITALS.has(upper)) return upper;
      if (UNIT_WORDS.has(upper)) return titleCase(word);
      return /^\d/u.test(word) ? numberCase(word) : word;
    })
    .join(" ");
  if (named) return cased;
  return /^\d+(st|nd|rd|th)$/u.test(cased) ? `${cased} Fl` : `Apt ${cased}`;
}
