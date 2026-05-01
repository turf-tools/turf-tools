import { queryOptions } from "@tanstack/react-query";
import type { Criteria } from "~/lib/filters";
import { client } from "~/rpc/client";

export type SegmentCriteria = NonNullable<
  Awaited<ReturnType<typeof client.segments.getById>>
>["criteria"];

// TODO: thread real org slug from session once auth lands. Single-org
// today, mock-seeded as "default" in packages/db/src/mock.ts.
const ORG_SLUG = "default";

// Wire response shape from `POST /persons/count` on the data app.
// Keep in sync with the endpoint handler in apps/data/main.py.
export type PersonsCount = {
  personCount: number;
  doorCount: number;
  buildingCount: number;
  samplePeople: Array<{
    external_id: string;
    first_name: string | null;
    last_name: string | null;
    address_line_1: string | null;
    address_line_2: string | null;
    city: string | null;
    state: string | null;
    zip5: string | null;
    latitude: number;
    longitude: number;
  }>;
};

// Wire response shape from `POST /persons/count-by-key`.
export type PersonsCountByKey = {
  counts: Record<string, { doors: number; people: number }>;
};

// Wire response shape from `POST /buildings/list`.
export type BuildingsList = {
  buildings: Array<{
    buildingId: string;
    longitude: number;
    latitude: number;
    doorCount: number;
    personCount: number;
  }>;
};

// Segment criteria is stored as opaque JSON in Postgres and isn't
// narrowed at the TS level — these helpers accept `unknown` and the
// data-side Pydantic models validate the shape on receipt.

export async function fetchPersonsCountByKey(input: {
  criteria: unknown;
  keyGroup: string;
  keyFilter?: { keyGroup: string; keys: string[] } | null;
}): Promise<PersonsCountByKey> {
  const res = await fetch(`${import.meta.env.VITE_DATA_URL}/persons/count-by-key`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      criteria: input.criteria,
      keyGroup: input.keyGroup,
      keyFilter: input.keyFilter ?? null,
      orgSlug: ORG_SLUG,
    }),
  });
  if (!res.ok) throw new Error(`persons/count-by-key failed: ${res.status} ${await res.text()}`);
  return (await res.json()) as PersonsCountByKey;
}

export const segmentsListQuery = () =>
  queryOptions({
    queryKey: ["segments"] as const,
    queryFn: () => client.segments.list(),
  });

export const segmentDetailQuery = (segmentId: string) =>
  queryOptions({
    queryKey: ["segment", segmentId] as const,
    queryFn: () => client.segments.getById({ segmentId }),
  });

// Counts + points for the segments-editor preview pane. Key-determined:
// same `effectiveKey` always yields the same result.
export const segmentPreviewQuery = (criteria: Criteria) =>
  queryOptions({
    queryKey: ["segment-preview", JSON.stringify(criteria)] as const,
    queryFn: async () => {
      const [counts, pointsBuffer] = await Promise.all([
        (async () => {
          const res = await fetch(`${import.meta.env.VITE_DATA_URL}/persons/count`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ criteria, orgSlug: ORG_SLUG }),
          });
          if (!res.ok) throw new Error(`persons/count failed: ${res.status} ${await res.text()}`);
          return (await res.json()) as PersonsCount;
        })(),
        fetchBuildingsPoints({ criteria }),
      ]);
      return { counts, pointsBuffer };
    },
    staleTime: Number.POSITIVE_INFINITY,
  });

export async function fetchBuildingsList(input: {
  criteria: unknown;
  keyFilter?: { keyGroup: string; keys: string[] } | null;
}): Promise<BuildingsList> {
  const res = await fetch(`${import.meta.env.VITE_DATA_URL}/buildings/list`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      criteria: input.criteria,
      keyFilter: input.keyFilter ?? null,
      orgSlug: ORG_SLUG,
    }),
  });
  if (!res.ok) throw new Error(`buildings/list failed: ${res.status} ${await res.text()}`);
  return (await res.json()) as BuildingsList;
}

// Binary lng/lat pairs — uploaded directly into a GPU buffer, so the
// response stays as raw bytes the whole way through (no JSON envelope,
// no per-byte JS decode).
export async function fetchBuildingsPoints(input: {
  criteria: unknown;
  keyFilter?: { keyGroup: string; keys: string[] } | null;
}): Promise<Float32Array> {
  const res = await fetch(`${import.meta.env.VITE_DATA_URL}/buildings/points`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      criteria: input.criteria,
      keyFilter: input.keyFilter ?? null,
      orgSlug: ORG_SLUG,
    }),
  });
  if (!res.ok) throw new Error(`buildings/points failed: ${res.status} ${await res.text()}`);
  return new Float32Array(await res.arrayBuffer());
}

// Buildings inside a single zone, narrowed by segment criteria. Used
// by the turf cutter. `segmentCriteria` is `unknown`-typed at the type
// level, so passing `undefined` is structurally allowed for
// disabled-state calls.
export const cutterBuildingsQuery = (
  zoneId: string,
  segmentCriteria: SegmentCriteria,
  keyFilter: { keyGroup: string; keys: string[] } | undefined,
) =>
  queryOptions({
    queryKey: [
      "cutter-buildings",
      zoneId,
      segmentCriteria ? JSON.stringify(segmentCriteria) : null,
    ] as const,
    queryFn: () => fetchBuildingsList({ criteria: segmentCriteria, keyFilter }),
    staleTime: Number.POSITIVE_INFINITY,
  });
