import type {
  TurfData,
  TurfDataBuilding,
  TurfDataDoor,
  TurfDataPerson,
} from "@turf-tools/db/schema";
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

// Walk order within a building: highest floor first (canvassers ride up
// and knock down; PH counts as the top), letters ascending within a
// floor (5A, 5B, 5C), unit-less doors last. The publish pipeline emits
// doors in hash-group order, so all ordering happens client-side here.
const UNIT_DESIGNATORS = /^(?:APT|APARTMENT|UNIT|STE|SUITE|FL|FLOOR|BLDG|BUILDING|#)\s*/i;

function sortDoors(doors: TurfDataDoor[]): TurfDataDoor[] {
  const keyed = doors.map((door) => {
    const stripped = (door.unit ?? "").trim().replace(UNIT_DESIGNATORS, "").trim();
    const match = stripped.match(/^(\d+)\s*(.*)$/);
    const floor = /^PH/i.test(stripped) ? Infinity : match ? parseInt(match[1]!, 10) : -1;
    return { door, hasUnit: stripped.length > 0, floor, rest: match ? match[2]! : stripped };
  });
  keyed.sort((a, b) => {
    if (a.hasUnit !== b.hasUnit) return a.hasUnit ? -1 : 1;
    if (a.floor !== b.floor) return b.floor - a.floor;
    return a.rest.localeCompare(b.rest, undefined, { numeric: true });
  });
  return keyed.map((k) => k.door);
}

// Order across buildings: street name alphabetically, then house number
// ascending within a street. Numeric-aware compares keep hyphenated
// house numbers sane ("84-3" before "84-12"). Addresses with no leading
// number sort by the full line.
function sortBuildings(buildings: TurfDataBuilding[]): TurfDataBuilding[] {
  const keyed = buildings.map((building) => {
    const line = (building.address.street ?? "").trim();
    const match = line.match(/^(\d[\d-]*)\s+(.+)$/);
    return {
      building,
      street: match ? match[2]! : line,
      number: match ? match[1]! : "",
    };
  });
  keyed.sort(
    (a, b) =>
      a.street.localeCompare(b.street, undefined, { numeric: true }) ||
      a.number.localeCompare(b.number, undefined, { numeric: true }),
  );
  return keyed.map((k) => k.building);
}

// Next building in walk order after the current one, wrapping around —
// stays sequential instead of jumping back to the first incomplete
// building in the list.
export function findNextBuilding(
  buildingsInOrder: TurfDataBuilding[],
  currentBuildingId: string,
  hasWork: (building: TurfDataBuilding) => boolean,
): TurfDataBuilding | undefined {
  const currentIdx = buildingsInOrder.findIndex((b) => b.buildingId === currentBuildingId);
  const after = buildingsInOrder.slice(currentIdx + 1);
  const before = buildingsInOrder.slice(0, Math.max(currentIdx, 0));
  return [...after, ...before].find(hasWork);
}

export function buildTurfIndexes(turf: TurfData): TurfIndexes {
  const buildingsById = new Map<string, TurfDataBuilding>();
  const doorsById = new Map<string, TurfDataDoor>();
  const personsById = new Map<string, TurfDataPerson>();
  const doorByPersonId = new Map<string, TurfDataDoor>();
  const buildingByDoorId = new Map<string, TurfDataBuilding>();
  const buildingByPersonId = new Map<string, TurfDataBuilding>();
  const personsInOrder: TurfDataPerson[] = [];

  // Sorted shallow copies — the react-query cached blob stays untouched.
  const buildings = sortBuildings(turf.buildings).map((b) => ({
    ...b,
    doors: sortDoors(b.doors),
  }));

  for (const building of buildings) {
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
    buildingsInOrder: buildings,
    personsInOrder,
  };
}

// Combined hook: fetches turf metadata + data blob + builds indexes.
// Returns everything screens need in one call. Also warms the script
// cache as soon as meta resolves.
export function useTurf(turfId: string) {
  const metaQuery = useQuery({
    queryKey: ["turf", turfId] as const,
    queryFn: () => client.turfs.getById({ turfId }),
    enabled: !!turfId,
    staleTime: Infinity,
  });
  const dataQuery = useTurfData(turfId);
  const scriptId = metaQuery.data?.scriptId;
  useQuery({
    queryKey: ["script", scriptId] as const,
    queryFn: () => client.scripts.get({ scriptId: scriptId! }),
    enabled: !!scriptId,
    staleTime: Infinity,
  });
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
