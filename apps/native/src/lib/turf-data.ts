import type {
  TurfData,
  TurfDataBuilding,
  TurfDataDoor,
  TurfDataPerson,
} from "@field-tools/db/schema";
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { client } from "@/rpc/client";

// Fetch the turf data blob via the dedicated RPC. Replaces the old
// HTTP-based fetch through `dataUrl` — the data service is no
// longer in the canvasser runtime path; native talks to Postgres
// (via the web RPC layer) for everything. Self-contained snapshot:
// once loaded, served from the persisted React Query cache for the
// rest of the session. Pull-to-refresh re-fetches.
export function useTurfData(turfId: string | null | undefined) {
  return useQuery({
    queryKey: ["turfData", turfId] as const,
    queryFn: async (): Promise<TurfData> => {
      if (!turfId) throw new Error("No turfId provided");
      const data = await client.turfs.getData({ turfId });
      if (!data) throw new Error("Turf data not found");
      return data;
    },
    enabled: !!turfId,
    staleTime: Infinity,
  });
}

// Indexes derived from a turf data blob for O(1) lookups across screens.
// Computed once on read; cheap relative to the rest of the work.
export type TurfIndexes = {
  buildingsById: Map<string, TurfDataBuilding>;
  doorsById: Map<string, TurfDataDoor>;
  personsById: Map<string, TurfDataPerson>;
  doorByPersonId: Map<string, TurfDataDoor>;
  buildingByDoorId: Map<string, TurfDataBuilding>;
  buildingByPersonId: Map<string, TurfDataBuilding>;
  // Walk-order lists used by the "Next" button.
  buildingsInOrder: TurfDataBuilding[];
  personsInOrder: TurfDataPerson[];
};

export function buildTurfIndexes(turf: TurfData): TurfIndexes {
  const buildingsById = new Map<string, TurfDataBuilding>();
  const doorsById = new Map<string, TurfDataDoor>();
  const personsById = new Map<string, TurfDataPerson>();
  const doorByPersonId = new Map<string, TurfDataDoor>();
  const buildingByDoorId = new Map<string, TurfDataBuilding>();
  const buildingByPersonId = new Map<string, TurfDataBuilding>();
  const personsInOrder: TurfDataPerson[] = [];

  for (const building of turf.buildings) {
    buildingsById.set(building.buildingId, building);
    for (const door of building.doors) {
      doorsById.set(door.doorId, door);
      buildingByDoorId.set(door.doorId, building);
      for (const person of door.persons) {
        personsById.set(person.personId, person);
        doorByPersonId.set(person.personId, door);
        buildingByPersonId.set(person.personId, building);
        personsInOrder.push(person);
      }
    }
  }

  return {
    buildingsById,
    doorsById,
    personsById,
    doorByPersonId,
    buildingByDoorId,
    buildingByPersonId,
    buildingsInOrder: turf.buildings,
    personsInOrder,
  };
}

// Compute integer age from a date_of_birth string. Voter-file
// fields land in the blob as raw `otherProperties` (state-specific
// formats), so consumers do the parse on read. NYS BOE in
// particular ships dates as compact `YYYYMMDD` with no separators,
// which `Date.parse` returns NaN for — we expand those to ISO
// before parsing. Other parseable forms (ISO, US "MM/DD/YYYY")
// pass through.
export function ageFromDob(dob: string | null | undefined): number | null {
  if (!dob) return null;
  let s = dob.trim();
  if (/^\d{8}$/.test(s)) {
    s = `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
  }
  const ts = Date.parse(s);
  if (Number.isNaN(ts)) return null;
  const ms = Date.now() - ts;
  if (ms < 0) return null;
  return Math.floor(ms / (365.25 * 24 * 60 * 60 * 1000));
}

// Each formatter renders a single property as a short label fit
// for a pill — one property per badge so missing fields are
// visually attributable. Returns "?" for null/missing.

export function formatAge(p: TurfDataPerson): string {
  const age = ageFromDob(p.otherProperties.date_of_birth);
  return age != null ? String(age) : "?";
}

export function formatGender(p: TurfDataPerson): string {
  const g = (p.otherProperties.gender ?? "").trim();
  if (!g) return "?";
  return g.charAt(0).toUpperCase();
}

export function formatParty(p: TurfDataPerson): string {
  const party = (p.otherProperties.party ?? "").trim();
  if (!party) return "?";
  return party.charAt(0).toUpperCase();
}

// Combined hook: fetches turf metadata + data blob + builds indexes.
// Returns everything screens need in one call.
export function useTurf(turfId: string) {
  const metaQuery = useQuery({
    queryKey: ["turf", turfId] as const,
    queryFn: () => client.turfs.getById({ turfId }),
    enabled: !!turfId,
    staleTime: Infinity,
  });
  const dataQuery = useTurfData(turfId);
  const indexes = useMemo(
    () => (dataQuery.data ? buildTurfIndexes(dataQuery.data) : null),
    [dataQuery.data],
  );
  return {
    meta: metaQuery.data,
    data: dataQuery.data,
    indexes,
    isLoading: metaQuery.isLoading || (metaQuery.data && dataQuery.isLoading),
    error: metaQuery.error || dataQuery.error,
  };
}
