import { router, useLocalSearchParams } from "expo-router";
import { useAtomValue, useSetAtom } from "jotai";
import { Check, Scroll } from "lucide-react-native";
import { Fragment, useCallback, useMemo, useState } from "react";
import { ActivityIndicator, Alert, Pressable, ScrollView, Text, View } from "react-native";
import type { TurfDataBuilding, TurfDataDoor, TurfDataPerson } from "@field-tools/db/schema";
import { SwipeAction } from "@/components/swipe-action";
import { Pill } from "@/components/pill";
import { useColors } from "@/lib/colors";
import { useScreenNav } from "@/lib/nav-context";
import { toTitleCase } from "@/lib/format";
import {
  type PersonSummary,
  derivePersonSummaries,
  hasNotes,
  hasResponses,
  isRecorded,
  useRecordEvent,
  useCanvassEvents,
} from "@/lib/canvass-events";
import { openSheetAtom } from "@/lib/atoms/sheet";
import { themeAtom } from "@/lib/atoms/theme";
import { formatAge, formatEnrollment, formatGender } from "@/lib/format";
import { useTurf } from "@/lib/turf-data";

export default function BuildingScreen() {
  const { turfId, buildingId } = useLocalSearchParams<{
    turfId: string;
    buildingId: string;
  }>();

  const { indexes, isLoading } = useTurf(turfId);
  const events = useCanvassEvents(turfId);
  const allResults = useMemo(() => derivePersonSummaries(events), [events]);
  const building = indexes?.buildingsById.get(buildingId);
  const setOpenSheet = useSetAtom(openSheetAtom);

  // Defer rendering large buildings so the screen shows a spinner first.
  const personCount = building?.doors.reduce((sum, d) => sum + d.persons.length, 0) ?? 0;
  const [ready, setReady] = useState(personCount < 50);
  if (!ready) {
    setTimeout(() => setReady(true), 0);
  }

  if (isLoading) {
    return (
      <View className="flex-1 items-center justify-center bg-background dark:bg-background-dark">
        <ActivityIndicator />
      </View>
    );
  }

  if (!building) {
    return (
      <View className="flex-1 items-center justify-center bg-background dark:bg-background-dark p-5">
        <Text className="font-sans-bold text-base text-destructive dark:text-destructive-dark mb-1">
          Building not found
        </Text>
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
    const personsInBuilding = building.doors.flatMap((d) => d.persons);
    const nextInBuilding = personsInBuilding.find((p) => !isRecorded(allResults, p.personId));
    if (nextInBuilding) {
      router.push(`/turfs/${turfId}/persons/${nextInBuilding.personId}`);
      return;
    }
    const nextBuilding = indexes?.buildingsInOrder?.find((b) => {
      if (b.buildingId === buildingId) return false;
      return b.doors.some((d) => d.persons.some((p) => !isRecorded(allResults, p.personId)));
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
    Alert.alert("Coming soon", `The ${action} function is not implemented yet.`);
  };

  useScreenNav({
    title,
    bottomButtons: ["search", "list", "next", "mic"],
    onBottomPress: (action) => {
      if (action === "list") handleListPress();
      else if (action === "next") handleNextPress();
      else handleStubPress(action);
    },
  });

  if (!ready) {
    return (
      <View className="flex-1 items-center justify-center bg-background dark:bg-background-dark">
        <ActivityIndicator />
      </View>
    );
  }

  return (
    <View className="flex-1 bg-background dark:bg-background-dark">
      <ScrollView contentContainerStyle={{ marginTop: -1 }}>
        <View className="h-px bg-border dark:bg-border-dark" />
        {building.doors.map((door, idx) => (
          <Fragment key={door.doorId}>
            {idx > 0 && <View className="h-2" />}
            <DoorSection door={door} turfId={turfId} allResults={allResults} isFirst={idx === 0} />
          </Fragment>
        ))}
        <View className="h-2" />
        <View className="h-px bg-border dark:bg-border-dark" style={{ marginBottom: -3 }} />
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
  allResults: Map<string, PersonSummary>;
  isFirst?: boolean;
}) {
  const rawUnit = (door.unit ?? "").trim();
  const stripped = rawUnit.replace(/^(APT|UNIT|#)\s*/i, "").trim();
  const unitLabel = stripped ? `Apt ${stripped}` : "Unit";
  return (
    <View style={{ marginBottom: -7 }}>
      <Text
        className={`font-sans-bold text-xl text-foreground dark:text-foreground-dark px-5 py-3.5 bg-background dark:bg-background-dark border-b border-border dark:border-border-dark ${isFirst ? "" : "border-t"}`}
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
  allResults: Map<string, PersonSummary>;
}) {
  const recorded = isRecorded(allResults, person.personId);
  const note = hasNotes(allResults, person.personId);
  const responded = hasResponses(allResults, person.personId);
  const isDark = useAtomValue(themeAtom) === "dark";
  const iconColor = isDark ? "#ededed" : "#1b1b1b";
  const colors = useColors();
  const role = responded ? "contacted" : "unavailable";
  const recordEvent = useRecordEvent(turfId);

  const fullName =
    [person.firstName, person.middleName, person.lastName, person.nameSuffix]
      .filter(Boolean)
      .join(" ")
      .trim() || "Unknown";

  const onPress = () => {
    router.push(`/turfs/${turfId}/persons/${person.personId}`);
  };

  const markNotHome = useCallback(() => {
    // Idempotent — a repeat swipe is a UX shortcut, not a re-declaration.
    if (allResults.get(person.personId)?.currentOutcome === "not_home") return;
    recordEvent({
      personId: person.personId,
      kind: "result",
      payload: { kind: "result", outcome: "not_home", responses: {} },
    });
  }, [person.personId, recordEvent, allResults]);

  return (
    <SwipeAction
      onTap={markNotHome}
      onFullSwipe={markNotHome}
      actionContent={
        <Text
          style={{ color: colors.unavailable.foreground }}
          className="font-sans text-xl text-center"
        >
          Not{"\n"}home
        </Text>
      }
      actionStyle={{ backgroundColor: colors.unavailable.background }}
      actionWidth={80}
    >
      <Pressable
        onPress={onPress}
        className="flex-row items-center px-5 py-3.5 bg-muted dark:bg-muted-dark active:bg-faded dark:active:bg-faded-dark"
      >
        <View className="flex-1">
          <Text
            className="font-sans text-xl text-foreground dark:text-foreground-dark mb-1"
            numberOfLines={1}
          >
            {toTitleCase(fullName)}
          </Text>
          <View className="flex-row items-center gap-1.5 mt-1">
            {person.dateOfBirth !== undefined && <Pill>{formatAge(person)}</Pill>}
            {person.gender !== undefined && <Pill>{formatGender(person)}</Pill>}
            {person.enrollment !== undefined && <Pill>{formatEnrollment(person)}</Pill>}
            <View className="flex-1" />
            {note && (
              <Pill
                style={recorded ? { backgroundColor: colors[role].background } : undefined}
                icon={<Scroll size={18} color={recorded ? colors[role].foreground : iconColor} />}
              />
            )}
            {recorded && (
              <Pill
                style={{ backgroundColor: colors[role].background }}
                icon={<Check size={18} color={colors[role].foreground} strokeWidth={2.5} />}
              />
            )}
          </View>
        </View>
      </Pressable>
    </SwipeAction>
  );
}

function formatBuildingTitle(b: TurfDataBuilding): string {
  return toTitleCase((b.address.street ?? "").trim()) || "Building";
}
