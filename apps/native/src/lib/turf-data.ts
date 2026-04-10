import type {
  TurfData,
  TurfDataBuilding,
  TurfDataDoor,
  TurfDataPerson,
} from "@field-tools/db/schema";
import { useQuery } from "@tanstack/react-query";

// The data service base URL. In dev this points at localhost or a LAN IP;
// in production it'll be the deployed data service. The dataUrl stored on
// the turf row is a full URL, but we extract just the path and prepend
// this base so the app works regardless of where the turf was seeded.
const DATA_BASE_URL = process.env.EXPO_PUBLIC_DATA_URL ?? "http://localhost:8000";

function resolveDataUrl(dataUrl: string): string {
  // If dataUrl is already a full URL, extract the path and re-base it.
  // This handles the case where the turf was seeded with localhost but
  // the app is running on a device that needs a LAN IP.
  try {
    const parsed = new URL(dataUrl);
    return `${DATA_BASE_URL}${parsed.pathname}`;
  } catch {
    // Not a full URL — treat as a relative path
    return `${DATA_BASE_URL}${dataUrl}`;
  }
}

// Fetch the turf data blob from its dataUrl. The blob is a self-contained
// snapshot of everything the canvasser needs to walk the turf: geometry +
// buildings -> doors -> persons. We download it once when the user enters a
// turf and serve it from the persisted React Query cache for the rest of the
// session. Pull-to-refresh re-fetches.
export function useTurfData(dataUrl: string | null | undefined) {
  const resolvedUrl = dataUrl ? resolveDataUrl(dataUrl) : null;
  return useQuery({
    queryKey: ["turfData", resolvedUrl] as const,
    queryFn: async (): Promise<TurfData> => {
      if (!resolvedUrl) throw new Error("No dataUrl provided");
      const resp = await fetch(resolvedUrl);
      if (!resp.ok) {
        throw new Error(`Failed to fetch turf data: ${resp.status}`);
      }
      return (await resp.json()) as TurfData;
    },
    enabled: !!resolvedUrl,
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
