// Translates segment Criteria (the filter DSL from `filters.ts`) into a
// DuckDB-compatible (where, params) pair. Each endpoint that evaluates
// criteria (counts, points, counts-by-key) wraps its own SELECT around
// `criteriaToWhere`'s output.
//
// All user-supplied values flow through `params`, never through string
// interpolation. Only field metadata from the catalog (column names,
// JSONB key names) lands directly in the SQL string.

import {
  type AgeRangeFilter,
  type Criteria,
  type EnumFilter,
  FILTERS,
  type TextFilter,
} from "./filters";

export class CriteriaError extends Error {}

// SQL expression for a catalog field. Top-level columns are bare
// names; other_properties extracts use ->>, parenthesized to dodge
// DuckDB's precedence trap (->> binds looser than IN/=/ILIKE, so the
// unwrapped form would parse as `other_properties->>('gender' IN
// (?))`). Per-zone aggregation reuses this for GROUP BY targets.
export function columnExprFor(fieldKey: string): string {
  const def = definitionFor(fieldKey);
  return columnExpr(fieldKey, def.source);
}

export function criteriaToWhere(criteria: Criteria): { where: string; params: unknown[] } {
  const clauses: string[] = [];
  const params: unknown[] = [];
  for (const f of criteria.filters) {
    let clause = "";
    if (f.kind === "enum") clause = enumClause(f, params);
    else if (f.kind === "age-range") clause = ageRangeClause(f, params);
    else if (f.kind === "text") clause = textClause(f, params);
    if (clause) clauses.push(clause);
  }
  if (clauses.length === 0) return { where: "", params: [] };
  return { where: `WHERE ${clauses.join(" AND ")}`, params };
}

function columnExpr(key: string, source: "column" | "other_properties"): string {
  if (source === "column") return key;
  return `(other_properties->>'${key}')`;
}

function definitionFor(key: string) {
  const def = FILTERS.find((d) => d.key === key);
  if (!def) throw new CriteriaError(`Unknown field: ${key}`);
  return def;
}

function enumClause(f: EnumFilter, params: unknown[]): string {
  const def = definitionFor(f.key);
  if (def.kind !== "enum") throw new CriteriaError(`Field ${f.key} is not an enum field`);
  if (f.values.length === 0) return "";
  const expr = columnExpr(f.key, def.source);
  const placeholders = f.values.map(() => "?").join(", ");
  params.push(...f.values);
  return `${expr} IN (${placeholders})`;
}

function ageRangeClause(f: AgeRangeFilter, params: unknown[]): string {
  const def = definitionFor(f.key);
  if (def.kind !== "age-range") throw new CriteriaError(`Field ${f.key} is not an age-range field`);
  if (f.min == null && f.max == null) return "";
  const expr = columnExpr(f.key, def.source);
  // SBOE date_of_birth lands as compact YYYYMMDD (e.g. "19670628").
  // try_strptime returns NULL for malformed inputs, which makes the
  // age comparison false → row drops out of the result.
  const dob = `try_strptime(${expr}, '%Y%m%d')::DATE`;
  const ageYears = `extract(year from age(current_date, ${dob}))`;
  const parts: string[] = [];
  if (f.min != null) {
    parts.push(`${ageYears} >= ?`);
    params.push(f.min);
  }
  if (f.max != null) {
    parts.push(`${ageYears} <= ?`);
    params.push(f.max);
  }
  return `(${parts.join(" AND ")})`;
}

function textClause(f: TextFilter, params: unknown[]): string {
  const def = definitionFor(f.key);
  if (def.kind !== "text") throw new CriteriaError(`Field ${f.key} is not a text field`);
  if (f.value.trim().length === 0) return "";
  const expr = columnExpr(f.key, def.source);
  if (def.op === "equals") {
    params.push(f.value);
    return `${expr} = ?`;
  }
  params.push(`%${f.value}%`);
  return `${expr} ILIKE ?`;
}
