import BottomSheet, { BottomSheetFlatList } from "@gorhom/bottom-sheet";
import { router, useLocalSearchParams } from "expo-router";
import { useAtomValue, useSetAtom } from "jotai";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Alert, Pressable, Text, useWindowDimensions, View } from "react-native";
import type { TurfDataBuilding } from "@field-tools/db/schema";
import { Check, DoorClosed, UserRound } from "lucide-react-native";
import { TurfMap } from "@/components/map/turf-map";
import { toTitleCase } from "@/lib/format";
import { Pill } from "@/components/pill";
import { useScreenNav } from "@/lib/nav-context";
import {
  type PersonSummary,
  derivePersonSummaries,
  isRecorded,
  useCanvassEvents,
} from "@/lib/canvass-events";
import { openSheetAtom } from "@/lib/atoms/sheet";
import { themeAtom } from "@/lib/atoms/theme";
import { useTurf } from "@/lib/turf-data";

// Turf List screen — the canvasser's home base for a turf. Renders a map at
// the top and a draggable building list in a bottom sheet. Tapping a pin or
// a list row opens the Building screen.
export default function TurfListScreen() {
  const { turfId } = useLocalSearchParams<{ turfId: string }>();
  const { height: windowHeight } = useWindowDimensions();
  const theme = useAtomValue(themeAtom);
  const isDark = theme === "dark";

  const { meta, data: turfData, indexes, isLoading, error } = useTurf(turfId);

  const events = useCanvassEvents(turfId);
  const allResults = useMemo(() => derivePersonSummaries(events), [events]);

  const recordedBuildingIds = useMemo(() => {
    const set = new Set<string>();
    if (!turfData) return set;

    for (const building of turfData.buildings) {
      const allPersonsRecorded =
        building.doors.length > 0 &&
        building.doors.every((door) => {
          if (door.persons.length === 0) return false;
          return door.persons.every((person) => isRecorded(allResults, person.personId));
        });
      if (allPersonsRecorded) {
        set.add(building.buildingId);
      }
    }
    return set;
  }, [allResults, turfData]);

  const sheetRef = useRef<BottomSheet>(null);
  // Two positions: peeking (handle visible above nav) and fully extended.
  const snapPoints = useMemo(() => [40, "92%"], []);

  // Open the sheet when signaled from Building/Person screens.
  const shouldOpenSheet = useAtomValue(openSheetAtom);
  const setOpenSheet = useSetAtom(openSheetAtom);
  useEffect(() => {
    if (shouldOpenSheet) {
      sheetRef.current?.snapToIndex(1);
      setOpenSheet(false);
    }
  }, [shouldOpenSheet, setOpenSheet]);
  const [sheetOpen, setSheetOpen] = useState(false);
  const sheetOpenRef = useRef(false);
  const onSheetChange = useCallback((index: number) => {
    const open = index >= 1;
    sheetOpenRef.current = open;
    setSheetOpen(open);
  }, []);

  const bottomInset = useMemo(() => {
    if (!sheetOpen) return 20;
    return Math.round(windowHeight * 0.92);
  }, [sheetOpen, windowHeight]);

  const handleNextPress = useCallback(() => {
    if (!indexes) return;
    const nextPerson = indexes.personsInOrder.find((p) => {
      return !isRecorded(allResults, p.personId);
    });
    if (!nextPerson) {
      Alert.alert("All recorded", "Every person in this turf has a result.");
      return;
    }
    router.push(`/turfs/${turfId}/persons/${nextPerson.personId}`);
  }, [indexes, allResults, turfId]);

  const handleStubPress = useCallback((action: string) => {
    Alert.alert("Coming soon", `The ${action} function is not implemented yet.`);
  }, []);

  const turfTitle = meta?.turfCode ? `Turf ${meta.turfCode}` : "Turf";

  useScreenNav({
    title: turfTitle,
    showBack: false,
    bottomButtons: ["search", "list", "next", "mic"],
    onBottomPress: (action) => {
      if (action === "list") {
        sheetRef.current?.snapToIndex(sheetOpenRef.current ? 0 : 1);
      } else if (action === "next") {
        handleNextPress();
      } else {
        handleStubPress(action);
      }
    },
  });

  // The handle needs inline styles because @gorhom/bottom-sheet's
  // handleComponent doesn't support className.
  const renderHandle = useCallback(
    () => (
      <Pressable
        onPress={() => sheetRef.current?.snapToIndex(1)}
        style={{
          paddingTop: 14,
          paddingBottom: 22,
          alignItems: "center",
          backgroundColor: isDark ? "#141414" : "#fcfcfc",
          borderTopLeftRadius: 16,
          borderTopRightRadius: 16,
          shadowColor: "#000",
          shadowOffset: { width: 0, height: -2 },
          shadowOpacity: 0.1,
          shadowRadius: 4,
        }}
      >
        <View
          style={{
            width: 40,
            height: 4,
            borderRadius: 2,
            backgroundColor: isDark ? "#444" : "#ccc",
          }}
        />
      </Pressable>
    ),
    [isDark],
  );

  const openBuilding = useCallback(
    (buildingId: string) => {
      router.push(`/turfs/${turfId}/buildings/${buildingId}`);
    },
    [turfId],
  );

  if (isLoading) {
    return (
      <View className="flex-1 items-center justify-center bg-background dark:bg-background-dark">
        <ActivityIndicator />
      </View>
    );
  }

  if (error) {
    return (
      <View className="flex-1 items-center justify-center bg-background dark:bg-background-dark p-5">
        <Text className="font-sans-bold text-red-dark pb-2 text-center">Failed to load turf</Text>
        <Text className="font-sans text-sm text-muted-foreground dark:text-muted-foreground-dark text-center">
          {String(error)}
        </Text>
      </View>
    );
  }
  if (!turfData) {
    return (
      <View className="flex-1 items-center justify-center bg-background dark:bg-background-dark">
        <Text className="font-sans-bold text-red-dark text-center">Empty turf data</Text>
      </View>
    );
  }

  return (
    <View className="flex-1 bg-background dark:bg-background-dark">
      <View className="flex-1">
        <TurfMap
          turf={turfData}
          recordedBuildingIds={recordedBuildingIds}
          onBuildingPress={openBuilding}
          isDark={isDark}
          bottomInset={bottomInset}
        />
      </View>

      <BottomSheet
        ref={sheetRef}
        snapPoints={snapPoints}
        index={0}
        enableDynamicSizing={false}
        enablePanDownToClose={false}
        onChange={onSheetChange}
        backgroundStyle={{ backgroundColor: isDark ? "#141414" : "#fcfcfc" }}
        handleComponent={renderHandle}
      >
        <BottomSheetFlatList
          data={turfData.buildings}
          keyExtractor={(b) => b.buildingId}
          contentContainerStyle={{ paddingBottom: 20 }}
          renderItem={({ item }) => (
            <BuildingRow
              building={item}
              allResults={allResults}
              onPress={() => openBuilding(item.buildingId)}
            />
          )}
          ListHeaderComponent={<View className="h-px bg-border dark:bg-border-dark" />}
          ItemSeparatorComponent={() => <View className="h-px bg-border dark:bg-border-dark" />}
        />
      </BottomSheet>
    </View>
  );
}

function BuildingRow({
  building,
  allResults,
  onPress,
}: {
  building: TurfDataBuilding;
  allResults: Map<string, PersonSummary>;
  onPress: () => void;
}) {
  const isDark = useAtomValue(themeAtom) === "dark";
  const iconColor = isDark ? "#ededed" : "#1b1b1b";
  const persons = building.doors.flatMap((d) => d.persons);
  const personCount = persons.length;
  const recordedCount = persons.filter((p) => isRecorded(allResults, p.personId)).length;
  const allRecorded = recordedCount > 0 && recordedCount === personCount;
  const address = formatBuildingAddress(building);

  return (
    <Pressable
      onPress={onPress}
      className="flex-row items-center px-5 pt-4 pb-5 active:bg-faded dark:active:bg-faded-dark"
      android_ripple={{ color: "#eee" }}
    >
      <View className="flex-1">
        <Text className="font-sans-bold text-xl text-foreground dark:text-foreground-dark mb-1">
          {toTitleCase(address)}
        </Text>
        <View className="flex-row items-center gap-1.5 mt-1 mb-1">
          <Pill icon={<DoorClosed size={16} color={iconColor} strokeWidth={2.5} />}>
            {building.doors.length}
          </Pill>
          <Pill icon={<UserRound size={16} color={iconColor} strokeWidth={2.5} />}>
            {personCount}
          </Pill>
          <View className="flex-1" />
          {recordedCount > 0 && (
            <Pill
              variant={allRecorded ? "primary" : "default"}
              icon={
                <Check
                  size={16}
                  color={allRecorded ? (isDark ? "#7ECDE0" : "#3D7385") : iconColor}
                  strokeWidth={2.5}
                />
              }
            >
              {recordedCount}
            </Pill>
          )}
        </View>
      </View>
    </Pressable>
  );
}

function formatBuildingAddress(b: TurfDataBuilding): string {
  // The data pipeline produces `street` as the canonical full
  // address line ("123 MAIN ST"); house number isn't tracked
  // separately on the blob.
  return (b.address.street ?? "").trim() || "Unknown address";
}
