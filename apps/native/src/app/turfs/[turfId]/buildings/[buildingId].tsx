import { useQuery } from "@tanstack/react-query";
import { router, Stack, useLocalSearchParams } from "expo-router";
import { useAtomValue, useSetAtom } from "jotai";
import { Check, Scroll, Speech } from "lucide-react-native";
import { Fragment, useMemo } from "react";
import { ActivityIndicator, Alert, Pressable, ScrollView, Text, View } from "react-native";
import type { TurfDataBuilding, TurfDataDoor, TurfDataPerson } from "@field-tools/db/schema";
import { Pill } from "@/components/pill";
import { useBottomNav } from "@/lib/bottom-nav-context";
import { toTitleCase } from "@/lib/format";
import {
  hasLocalNote,
  hasLocalSurvey,
  isLocallyRecorded,
  localResultsAtom,
  type LocalResultsMap,
} from "@/lib/local-results";
import { openSheetAtom } from "@/lib/atoms/sheet";
import { client } from "@/rpc/client";
import { buildTurfIndexes, useTurfData } from "@/lib/turf-data";

export default function BuildingScreen() {
  const { turfId, buildingId } = useLocalSearchParams<{
    turfId: string;
    buildingId: string;
  }>();

  const turfMetaQuery = useQuery({
    queryKey: ["turf", turfId] as const,
    queryFn: () => client.turfs.getById({ turfId }),
    enabled: !!turfId,
  });
  const turfDataQuery = useTurfData(turfMetaQuery.data?.dataUrl ?? null);
  const allResults = useAtomValue(localResultsAtom(turfId));

  const indexes = useMemo(
    () => (turfDataQuery.data ? buildTurfIndexes(turfDataQuery.data) : null),
    [turfDataQuery.data],
  );
  const building = indexes?.buildingsById.get(buildingId);
  const setOpenSheet = useSetAtom(openSheetAtom);

  if (turfMetaQuery.isLoading || turfDataQuery.isLoading) {
    return (
      <View className="flex-1 items-center justify-center bg-background dark:bg-background-dark">
        <ActivityIndicator />
      </View>
    );
  }

  if (!building) {
    return (
      <View className="flex-1 items-center justify-center bg-background dark:bg-background-dark p-5">
        <Stack.Screen options={{ title: "Building" }} />
        <Text className="font-sans-bold text-base text-red-dark mb-1">Building not found</Text>
        <Text className="font-sans text-sm text-muted-foreground dark:text-muted-foreground-dark">
          buildingId: {buildingId}
        </Text>
      </View>
    );
  }

  const title = formatBuildingTitle(building);

  const handleListPress = () => {
    setOpenSheet(true);
    router.dismissTo(`/turfs/${turfId}`);
  };

  const handleNextPress = () => {
    if (!building) return;
    // Find the next unmarked person in THIS building.
    const personsInBuilding = building.doors.flatMap((d) => d.persons);
    const nextInBuilding = personsInBuilding.find(
      (p) => !isLocallyRecorded(allResults, p.personId),
    );
    if (nextInBuilding) {
      router.push(`/turfs/${turfId}/persons/${nextInBuilding.personId}`);
      return;
    }
    // Building complete — offer to return to list or go to next building.
    const nextBuilding = indexes?.buildingsInOrder?.find((b) => {
      if (b.buildingId === buildingId) return false;
      return b.doors.some((d) => d.persons.some((p) => !isLocallyRecorded(allResults, p.personId)));
    });
    Alert.alert("Building complete", "Every person in this building has been recorded.", [
      {
        text: "Return to list",
        onPress: () => {
          setOpenSheet(true);
          router.dismissTo(`/turfs/${turfId}`);
        },
      },
      ...(nextBuilding
        ? [
            {
              text: "Next building",
              onPress: () =>
                router.replace(`/turfs/${turfId}/buildings/${nextBuilding.buildingId}`),
            },
          ]
        : []),
    ]);
  };

  const handleStubPress = (action: string) => {
    Alert.alert("Coming soon", `${action} is not implemented yet.`);
  };

  useBottomNav(["search", "list", "next", "mic"], (action) => {
    if (action === "list") handleListPress();
    else if (action === "next") handleNextPress();
    else handleStubPress(action);
  });

  return (
    <View className="flex-1 bg-background dark:bg-background-dark">
      <Stack.Screen options={{ title }} />
      <ScrollView>
        {building.doors.map((door, idx) => (
          <Fragment key={door.doorId}>
            {idx > 0 && <View className="h-2" />}
            <DoorSection door={door} turfId={turfId} allResults={allResults} isFirst={idx === 0} />
          </Fragment>
        ))}
      </ScrollView>
    </View>
  );
}

function DoorSection({
  door,
  turfId,
  allResults,
  isFirst = false,
}: {
  door: TurfDataDoor;
  turfId: string;
  allResults: LocalResultsMap;
  isFirst?: boolean;
}) {
  const rawUnit = (door.unit ?? "").trim();
  const stripped = rawUnit.replace(/^(APT|UNIT|#)\s*/i, "").trim();
  const unitLabel = stripped ? `Apt ${stripped}` : "Unit";
  return (
    <View>
      <Text
        className={`font-sans-bold text-xl text-foreground dark:text-foreground-dark px-5 py-3.5 bg-muted dark:bg-muted-dark border-b border-border dark:border-border-dark ${isFirst ? "" : "border-t"}`}
      >
        {unitLabel}
      </Text>
      <View>
        {door.persons.map((person, idx) => (
          <Fragment key={person.personId}>
            {idx > 0 && <View className="h-px bg-border dark:bg-border-dark" />}
            <PersonRow person={person} turfId={turfId} allResults={allResults} />
          </Fragment>
        ))}
      </View>
    </View>
  );
}

function PersonRow({
  person,
  turfId,
  allResults,
}: {
  person: TurfDataPerson;
  turfId: string;
  allResults: LocalResultsMap;
}) {
  const recorded = isLocallyRecorded(allResults, person.personId);
  const note = hasLocalNote(allResults, person.personId);
  const survey = hasLocalSurvey(allResults, person.personId);

  const fullName =
    [person.firstName, person.lastName].filter(Boolean).join(" ").trim() || "Unknown";

  const onPress = () => {
    router.push(`/turfs/${turfId}/persons/${person.personId}`);
  };

  return (
    <Pressable
      onPress={onPress}
      className="flex-row items-center px-5 py-3.5 gap-3"
      android_ripple={{ color: "#eee" }}
    >
      <View className="flex-1">
        <Text
          className="font-sans text-xl text-foreground dark:text-foreground-dark mb-1"
          numberOfLines={1}
        >
          {toTitleCase(fullName)}
        </Text>
        <View className="flex-row items-center gap-1.5 mt-1 mb-1">
          <Pill>{formatAgeGender(person)}</Pill>
          <Pill>{formatParty(person)}</Pill>
          <View className="flex-1" />
          {note && <Pill icon={<Scroll size={18} color="#1b1b1b" />} />}
          {survey && <Pill icon={<Speech size={18} color="#1b1b1b" />} />}
          {recorded && (
            <Pill variant="primary" icon={<Check size={18} color="#3D7385" strokeWidth={2.5} />} />
          )}
        </View>
      </View>
    </Pressable>
  );
}

function formatBuildingTitle(b: TurfDataBuilding): string {
  const parts = [b.address.houseNumber, b.address.street].filter(Boolean);
  return toTitleCase(parts.join(" ").trim()) || "Building";
}

function formatAgeGender(p: TurfDataPerson): string {
  const age = p.age != null ? String(p.age) : "?";
  const g = (p.gender ?? "").trim();
  const initial = g ? g.charAt(0).toUpperCase() : "";
  return `${age}${initial}`;
}

function formatParty(p: TurfDataPerson): string {
  const party = (p.party ?? "").trim();
  if (!party) return "?";
  return party.charAt(0).toUpperCase();
}
