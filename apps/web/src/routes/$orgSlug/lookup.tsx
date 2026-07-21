import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Button } from "~/components/button";
import { EditorHeader } from "~/components/editor-header";
import { Input } from "~/components/input";
import { Pill } from "~/components/pill";
import { formatDate } from "~/lib/format";
import type { ManifestFieldDef } from "~/lib/manifest";
import type { PersonDetail, PersonHit } from "~/rpc/web/persons";
import {
  type PersonSearchFields,
  personDetailQuery,
  personsSearchQuery,
} from "~/lib/queries/persons";
import { manifestQuery } from "~/lib/queries/manifest";
import { DEFAULT_DISPLAY_TIMEZONE } from "~/lib/timezones";
import { useFadeOnce } from "~/lib/use-fade-once";
import { cn, toTitleCase } from "~/lib/utils";

export const Route = createFileRoute("/$orgSlug/lookup")({ component: Lookup });

const PAGE_SIZE = 25;
const TZ = DEFAULT_DISPLAY_TIMEZONE;

// Shared column template for the results header + rows so they stay aligned.
const RESULT_COLS =
  "grid grid-cols-[minmax(0,1fr)_minmax(0,1.5fr)_minmax(0,0.8fr)_4rem_5rem] items-center gap-2 text-sm";

const EMPTY_FIELDS: PersonSearchFields = {
  firstName: "",
  lastName: "",
  address: "",
  city: "",
  zip: "",
  externalId: "",
};

// Voter-file columns already shown in the detail header (name / address block /
// pills) — skipped when rendering the manifest-driven field rows so nothing
// doubles up.
const HEADER_COLUMNS = new Set([
  "first_name",
  "last_name",
  "middle_name",
  "name_suffix",
  "address_line_1",
  "address_line_2",
  "city",
  "state",
  "zip5",
  "zip4",
  "date_of_birth",
  "gender",
  "enrollment",
]);

const ELECTION_TYPE_LABELS: Record<string, string> = {
  general: "General",
  primary: "Primary",
  presidential_primary: "Pres. primary",
};

function Lookup() {
  const shouldFade = useFadeOnce("/lookup");
  const [fields, setFields] = useState<PersonSearchFields>(EMPTY_FIELDS);
  const [debounced, setDebounced] = useState<PersonSearchFields>(EMPTY_FIELDS);
  const [offset, setOffset] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // Search on a pause, not every keystroke.
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(fields), 250);
    return () => clearTimeout(timer);
  }, [fields]);

  // Editing any field is a new search — reset to the first page and clear the
  // open detail (the selected person likely isn't in the new results).
  const setField = (key: keyof PersonSearchFields, value: string) => {
    setFields((f) => ({ ...f, [key]: value }));
    setOffset(0);
    setSelectedId(null);
  };

  const { data, isFetching } = useQuery(personsSearchQuery(debounced, PAGE_SIZE, offset));
  const hits = data?.hits ?? [];
  const total = data?.numHits ?? 0;
  const hasQuery = Object.values(debounced).some((v) => v.trim().length > 0);
  // Distinguishes "results loaded" (show table / no-matches) from "a fresh
  // search is in flight with nothing yet" (show a clean blank, not stale rows).
  const hasData = data != null;

  return (
    <div className={cn("flex h-[calc(100vh-3.5rem)] flex-col px-5 pt-4 pb-5", shouldFade)}>
      <EditorHeader title="Lookup" subtitle="Find a person" />
      <div className="flex min-h-0 flex-1 gap-4">
        <SearchForm fields={fields} onChange={setField} />
        <ResultsPanel
          hits={hits}
          total={total}
          offset={offset}
          hasQuery={hasQuery}
          hasData={hasData}
          fetching={isFetching}
          selectedId={selectedId}
          onSelect={(id) => setSelectedId(id)}
          onPage={(next) => setOffset(next)}
        />
        <DetailPanel externalId={selectedId} />
      </div>
    </div>
  );
}

// ----- Search form ---------------------------------------------------------

function SearchForm({
  fields,
  onChange,
}: {
  fields: PersonSearchFields;
  onChange: (key: keyof PersonSearchFields, value: string) => void;
}) {
  return (
    // `overflow-y-auto` also clips horizontally, shaving the focus ring off the
    // edges; `px-1` gives it room and `-mx-1` cancels the inset so the inputs
    // still line up with the header.
    <div className="-mx-1 flex w-64 shrink-0 flex-col gap-4 overflow-y-auto px-1">
      <Section title="Name">
        <Input
          aria-label="First name"
          placeholder="First name"
          value={fields.firstName}
          onChange={(e) => onChange("firstName", e.target.value)}
          autoFocus
        />
        <Input
          aria-label="Last name"
          placeholder="Last name"
          value={fields.lastName}
          onChange={(e) => onChange("lastName", e.target.value)}
        />
      </Section>

      <Section title="Address">
        <Input
          aria-label="Street address"
          placeholder="Street address"
          value={fields.address}
          onChange={(e) => onChange("address", e.target.value)}
        />
        <div className="flex gap-2">
          <Input
            aria-label="City"
            placeholder="City"
            className="flex-1"
            value={fields.city}
            onChange={(e) => onChange("city", e.target.value)}
          />
          <Input
            aria-label="ZIP"
            placeholder="ZIP"
            className="w-20"
            value={fields.zip}
            onChange={(e) => onChange("zip", e.target.value)}
          />
        </div>
      </Section>

      <Section title="ID">
        <Input
          aria-label="External ID"
          placeholder="External ID"
          value={fields.externalId}
          onChange={(e) => onChange("externalId", e.target.value)}
        />
      </Section>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-2">
      <span className="text-sm font-medium text-muted-foreground">{title}</span>
      {children}
    </div>
  );
}

// ----- Results list --------------------------------------------------------

function ResultsPanel({
  hits,
  total,
  offset,
  hasQuery,
  hasData,
  fetching,
  selectedId,
  onSelect,
  onPage,
}: {
  hits: PersonHit[];
  total: number;
  offset: number;
  hasQuery: boolean;
  hasData: boolean;
  fetching: boolean;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onPage: (offset: number) => void;
}) {
  const from = total === 0 ? 0 : offset + 1;
  const to = Math.min(offset + hits.length, total);

  return (
    <div className="flex min-w-0 flex-1 flex-col overflow-hidden rounded-lg border border-border bg-card">
      <div className="min-h-0 flex-1 overflow-y-auto px-4">
        {!hasQuery ? (
          <Centered>Enter a name, address, or ID to search</Centered>
        ) : !hasData ? (
          // A fresh search is loading with nothing to show yet — stay blank
          // rather than flashing the previous lookup's rows or "No matches".
          <div className="h-full" />
        ) : hits.length === 0 ? (
          <Centered>No matches.</Centered>
        ) : (
          // Row hovers bleed past the text into the card padding (`-mx-2`), so
          // the highlight reads as its own rounded pill rather than a full-bleed band.
          // Fade the (stale) rows while refining/paging, matching the footer count.
          <div className={cn("-mx-2", fetching && "opacity-60")}>
            <div
              className={cn(
                RESULT_COLS,
                "sticky top-0 z-10 bg-card px-2 pt-3 pb-1.5 text-muted-foreground",
              )}
            >
              <span>Name</span>
              <span>Address</span>
              <span>City</span>
              <span>State</span>
              <span>Zip</span>
            </div>
            <div className="flex flex-col gap-0.5 pb-2">
              {hits.map((hit) => (
                <div
                  key={hit.external_id}
                  onClick={() => onSelect(hit.external_id)}
                  className={cn(
                    RESULT_COLS,
                    "cursor-pointer items-center rounded-md px-2 py-1.5 text-sm",
                    hit.external_id === selectedId ? "bg-muted" : "hover:bg-muted/50",
                  )}
                >
                  <span className="truncate">
                    {toTitleCase([hit.first_name, hit.last_name].filter(Boolean).join(" ")) || "—"}
                  </span>
                  <span className="truncate">
                    {[toTitleCase(hit.address_line_1), hit.address_line_2]
                      .filter(Boolean)
                      .join(", ") || "—"}
                  </span>
                  <span className="truncate">{toTitleCase(hit.city) || "—"}</span>
                  <span className="truncate">{hit.state ?? "—"}</span>
                  <span className="truncate">{hit.zip5 ?? "—"}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
      {hasQuery && hasData ? (
        <div className="flex h-11 shrink-0 items-center justify-between border-t border-border px-4 text-sm text-muted-foreground">
          <span className={cn(fetching && "opacity-60")}>
            {total.toLocaleString()} result{total === 1 ? "" : "s"}
          </span>
          {total > PAGE_SIZE ? (
            <div className="flex items-center gap-2">
              <span>
                {from.toLocaleString()}–{to.toLocaleString()}
              </span>
              <Button
                variant="ghost"
                size="icon-sm"
                disabled={offset === 0}
                onClick={() => onPage(Math.max(0, offset - PAGE_SIZE))}
              >
                <ChevronLeft />
              </Button>
              <Button
                variant="ghost"
                size="icon-sm"
                disabled={offset + PAGE_SIZE >= total}
                onClick={() => onPage(offset + PAGE_SIZE)}
              >
                <ChevronRight />
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-full items-center justify-center text-center text-muted-foreground">
      {children}
    </div>
  );
}

// ----- Detail pane ---------------------------------------------------------

type DetailRow = { label: string; value: string };
type DetailBlock = { heading?: string; rows: DetailRow[] };

function DetailPanel({ externalId }: { externalId: string | null }) {
  const { data, isFetching } = useQuery(personDetailQuery(externalId));
  const { data: manifestData } = useQuery(manifestQuery());
  const person = data?.person ?? null;

  // column → manifest field def, for label + formatting guidance.
  const defByColumn = useMemo(() => {
    const map = new Map<string, ManifestFieldDef>();
    for (const section of manifestData?.manifest.fields ?? []) {
      for (const fd of section) if (fd.column) map.set(fd.column, fd);
    }
    return map;
  }, [manifestData]);

  // Detail blocks, in order: identity (DOB + id), a location block (city +
  // county, which the raw manifest splits confusingly), then the manifest's own
  // field sections, then voting history. All share one divider so they read
  // uniformly.
  const blocks = useMemo<DetailBlock[]>(() => {
    if (!person) return [];
    const out: DetailBlock[] = [];

    // Identity — date of birth + id up top.
    const identity: DetailRow[] = [
      { label: "Date of birth", value: formatDob(person.date_of_birth) },
      { label: "ID", value: toText(person.external_id) },
    ].filter((r) => r.value !== "" && r.value !== "—");
    if (identity.length > 0) out.push({ rows: identity });

    // Location — pull city + county together under plain labels (the county
    // field decodes to a place name, so it reads oddly alone up in the header).
    const countyDef = defByColumn.get("county_code");
    const location: DetailRow[] = [
      { label: "City", value: toTitleCase(toText(person.city)) },
      {
        label: countyDef?.label ?? "County",
        value: enumLabel(countyDef, person.county_code) ?? "",
      },
      { label: "ZIP", value: toText(person.zip5) },
    ].filter((r) => r.value);
    if (location.length > 0) out.push({ rows: location });

    // Manifest field sections (city/county handled above; header fields shown
    // up top; composite/voting-history filters aren't plain values).
    for (const section of manifestData?.manifest.fields ?? []) {
      const rows = section
        .filter(
          (fd) =>
            fd.column &&
            fd.column !== "county_code" &&
            !HEADER_COLUMNS.has(fd.column) &&
            fd.filterKind !== "address" &&
            fd.filterKind !== "voting-history-count" &&
            fd.filterKind !== "voting-history-detail",
        )
        .map((fd) => ({ label: fd.label, value: formatValue(fd, person[fd.column as string]) }))
        .filter((row) => row.value !== "—");
      if (rows.length > 0) out.push({ rows });
    }

    // Voting history — most-recent first, falling back to year for ordering
    // when undated. The label carries the year; the right value is the exact
    // date when we have one, else "—" (many entries are year-only).
    const voting = [...(person.votingHistory ?? [])].sort((a, b) => {
      const aKey = a.date ?? `${a.year}-12-31`;
      const bKey = b.date ?? `${b.year}-12-31`;
      return bKey.localeCompare(aKey);
    });
    if (voting.length > 0) {
      out.push({
        heading: "Voting history",
        rows: voting.map((e) => ({
          label: `${ELECTION_TYPE_LABELS[e.type] ?? toTitleCase(e.type)} ${e.year}`,
          value: e.date ? formatDate(e.date, TZ) : "—",
        })),
      });
    }

    return out;
  }, [person, manifestData, defByColumn]);

  return (
    <div className="w-80 shrink-0 overflow-y-auto rounded-lg border border-border bg-card">
      {externalId == null ? (
        <Centered>Select a person to see details</Centered>
      ) : !person ? (
        <Centered>{isFetching ? "" : "Person not found."}</Centered>
      ) : (
        <div className="flex flex-col gap-5 px-5 py-4">
          <DetailHeader person={person} defByColumn={defByColumn} />
          {blocks.length > 0 ? (
            <div className="flex flex-col">
              {blocks.map((block, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: static block order
                <div key={i} className="flex flex-col">
                  {i > 0 ? <div className="mt-2 mb-2 h-px bg-border" /> : null}
                  {block.heading ? (
                    <span className="mt-2 mb-1 text-sm">{block.heading}</span>
                  ) : null}
                  {block.rows.map((row) => (
                    <div key={row.label} className="flex justify-between gap-6 py-1.5 text-sm">
                      <span className="shrink-0 text-muted-foreground">{row.label}</span>
                      <span className="text-right">{row.value}</span>
                    </div>
                  ))}
                </div>
              ))}
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}

function DetailHeader({
  person,
  defByColumn,
}: {
  person: PersonDetail;
  defByColumn: Map<string, ManifestFieldDef>;
}) {
  const name =
    toTitleCase(
      [person.first_name, person.middle_name, person.last_name, person.name_suffix]
        .filter(Boolean)
        .join(" "),
    ) || "Unknown";
  // Street only — city / county / ZIP live in the location block below. Only
  // line 1 gets title-cased; line 2 (apartment, e.g. "4R") is left verbatim.
  const addressLine = [toTitleCase(toText(person.address_line_1)), toText(person.address_line_2)]
    .filter(Boolean)
    .join(", ");

  const age = ageFromDob(person.date_of_birth);
  const gender = enumLabel(defByColumn.get("gender"), person.gender);
  const party = enumLabel(defByColumn.get("enrollment"), person.enrollment);
  const pills = [age != null ? `${age}` : null, gender, party].filter(Boolean) as string[];

  return (
    <div className="flex flex-col gap-2">
      <h2 className="text-lg font-bold tracking-normal">{name}</h2>
      {addressLine ? <div className="text-sm text-muted-foreground">{addressLine}</div> : null}
      {pills.length > 0 && (
        <div className="mt-1 flex flex-wrap gap-1.5">
          {pills.map((p) => (
            <Pill key={p} className="w-auto">
              {p}
            </Pill>
          ))}
        </div>
      )}
    </div>
  );
}

// ----- Formatting ----------------------------------------------------------

function formatValue(fd: ManifestFieldDef, raw: unknown): string {
  const text = toText(raw);
  if (text === "") return "—";
  switch (fd.filterKind) {
    case "enum":
      return enumLabel(fd, raw) ?? "—";
    case "date-range":
      return formatDate(text, TZ);
    case "age-range": {
      const age = ageFromDob(raw);
      return age != null ? String(age) : "—";
    }
    case "text":
      return toTitleCase(text);
    default:
      return text;
  }
}

// Enum value → its authored label, falling back to a title-cased raw value.
function enumLabel(fd: ManifestFieldDef | undefined, raw: unknown): string | null {
  const value = toText(raw);
  if (value === "") return null;
  const opt = fd?.values?.find((v) => v.value === value);
  return opt?.label ?? toTitleCase(value);
}

// Birth date as MM/DD/YYYY straight off the ISO string. A full year is clearer
// than formatDate's 2-digit one, and skipping the timezone conversion keeps a
// date-only value from shifting a day.
function formatDob(raw: unknown): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(toText(raw));
  return m ? `${m[2]}/${m[3]}/${m[1]}` : "";
}

// The lake serializes person columns to JSON scalars; render primitives,
// ignore anything structural (never expected here).
function toText(raw: unknown): string {
  if (typeof raw === "string") return raw;
  if (typeof raw === "number" || typeof raw === "boolean") return String(raw);
  return "";
}

function ageFromDob(raw: unknown): number | null {
  const text = toText(raw);
  if (text === "") return null;
  const d = new Date(text);
  if (Number.isNaN(d.getTime())) return null;
  const now = new Date();
  let age = now.getFullYear() - d.getFullYear();
  const m = now.getMonth() - d.getMonth();
  if (m < 0 || (m === 0 && now.getDate() < d.getDate())) age--;
  return age >= 0 && age < 130 ? age : null;
}
