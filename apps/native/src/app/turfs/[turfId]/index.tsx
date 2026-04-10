import BottomSheet, { BottomSheetFlatList } from "@gorhom/bottom-sheet";
import { useQuery } from "@tanstack/react-query";
import { router, Stack, useLocalSearchParams } from "expo-router";
import { useAtomValue, useSetAtom } from "jotai";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Alert, Pressable, Text, useWindowDimensions, View } from "react-native";
import type { TurfDataBuilding } from "@field-tools/db/schema";
import { DoorClosed, UserRound } from "lucide-react-native";
import { TurfMap } from "@/components/map/turf-map";
import { toTitleCase } from "@/lib/format";
import { Pill } from "@/components/pill";
import { useBottomNav } from "@/lib/bottom-nav-context";
import { isLocallyRecorded, localResultsAtom, useSeedFromServer } from "@/lib/local-results";
import { openSheetAtom } from "@/lib/atoms/sheet";
import { themeAtom } from "@/lib/atoms/theme";
import { client } from "@/rpc/client";
import { buildTurfIndexes, useTurfData } from "@/lib/turf-data";

// Turf List screen — the canvasser's home base for a turf. Renders a map at
// the top and a draggable building list in a bottom sheet. Tapping a pin or
// a list row opens the Building screen.
export default function TurfListScreen() {
  const { turfId } = useLocalSearchParams<{ turfId: string }>();
  const { height: windowHeight } = useWindowDimensions();
  const theme = useAtomValue(themeAtom);
  const isDark = theme === "dark";

  const turfMetaQuery = useQuery({
    queryKey: ["turf", turfId] as const,
    queryFn: () => client.turfs.getById({ turfId }),
    enabled: !!turfId,
  });
  const turfDataQuery = useTurfData(turfMetaQuery.data?.dataUrl ?? null);

  // Seed local results from server on first load.
  useSeedFromServer(turfId);
  const allResults = useAtomValue(localResultsAtom(turfId));

  const indexes = useMemo(
    () => (turfDataQuery.data ? buildTurfIndexes(turfDataQuery.data) : null),
    [turfDataQuery.data],
  );

  const recordedBuildingIds = useMemo(() => {
    const set = new Set<string>();
    if (!turfDataQuery.data) return set;

    for (const building of turfDataQuery.data.buildings) {
      const allPersonsRecorded =
        building.doors.length > 0 &&
        building.doors.every((door) => {
          if (door.persons.length === 0) return false;
          return door.persons.every((person) => isLocallyRecorded(allResults, person.personId));
        });
      if (allPersonsRecorded) {
        set.add(building.buildingId);
      }
    }
    return set;
  }, [allResults, turfDataQuery.data]);

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
  const onSheetChange = useCallback((index: number) => {
    setSheetOpen(index >= 1);
  }, []);

  const bottomInset = useMemo(() => {
    if (!sheetOpen) return 20;
    return Math.round(windowHeight * 0.92);
  }, [sheetOpen, windowHeight]);

  const handleNextPress = useCallback(() => {
    if (!indexes) return;
    const nextPerson = indexes.personsInOrder.find((p) => {
      return !isLocallyRecorded(allResults, p.personId);
    });
    if (!nextPerson) {
      Alert.alert("All recorded", "Every person in this turf has a result.");
      return;
    }
    router.push(`/turfs/${turfId}/persons/${nextPerson.personId}`);
  }, [indexes, allResults, turfId]);

  const handleStubPress = useCallback((action: string) => {
    Alert.alert("Coming soon", `${action} is not implemented yet.`);
  }, []);

  useBottomNav(["search", "list", "next", "mic"], (action) => {
    if (action === "list") {
      sheetRef.current?.snapToIndex(sheetOpen ? 0 : 1);
    } else if (action === "next") {
      handleNextPress();
    } else {
      handleStubPress(action);
    }
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
          backgroundColor: isDark ? "#262626" : "#ffffff",
          borderTopLeftRadius: 16,
          borderTopRightRadius: 16,
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

  if (turfMetaQuery.isLoading || (turfMetaQuery.data && turfDataQuery.isLoading)) {
    return (
      <View className="flex-1 items-center justify-center bg-background dark:bg-background-dark">
        <ActivityIndicator />
      </View>
    );
  }

  if (turfMetaQuery.error) {
    return (
      <View className="flex-1 items-center justify-center bg-background dark:bg-background-dark p-5">
        <Text className="font-sans-bold text-red-dark pb-2 text-center">turfs.getById error</Text>
        <Text className="font-sans text-sm text-muted-foreground dark:text-muted-foreground-dark text-center">
          {String(turfMetaQuery.error)}
        </Text>
      </View>
    );
  }
  if (!turfMetaQuery.data) {
    return (
      <View className="flex-1 items-center justify-center bg-background dark:bg-background-dark p-5">
        <Text className="font-sans-bold text-red-dark pb-2 text-center">No turf found</Text>
        <Text className="font-sans text-sm text-muted-foreground dark:text-muted-foreground-dark pb-2 text-center">
          turfId: {turfId}
        </Text>
        <Text className="font-sans text-sm text-muted-foreground dark:text-muted-foreground-dark text-center">
          Either the seeded turf doesn't exist, or it isn't assigned to the current user. Try pnpm
          clear && pnpm dev.
        </Text>
      </View>
    );
  }
  if (!turfMetaQuery.data.dataUrl) {
    return (
      <View className="flex-1 items-center justify-center bg-background dark:bg-background-dark p-5">
        <Text className="font-sans-bold text-red-dark pb-2 text-center">Turf has no dataUrl</Text>
        <Text className="font-sans text-sm text-muted-foreground dark:text-muted-foreground-dark text-center">
          Run pnpm data:mock to populate the blob.
        </Text>
      </View>
    );
  }
  if (turfDataQuery.error) {
    return (
      <View className="flex-1 items-center justify-center bg-background dark:bg-background-dark p-5">
        <Text className="font-sans-bold text-red-dark pb-2 text-center">
          Failed to fetch turf data blob
        </Text>
        <Text className="font-sans text-sm text-muted-foreground dark:text-muted-foreground-dark pb-2 text-center">
          {String(turfDataQuery.error)}
        </Text>
        <Text className="font-sans text-sm text-muted-foreground dark:text-muted-foreground-dark text-center">
          The data service may not be running, or the blob may not have been written yet. Try pnpm
          data:mock.
        </Text>
      </View>
    );
  }
  if (!turfDataQuery.data) {
    return (
      <View className="flex-1 items-center justify-center bg-background dark:bg-background-dark">
        <Text className="font-sans-bold text-red-dark text-center">Empty turf data</Text>
      </View>
    );
  }

  const listTitle = turfMetaQuery.data?.listCode ? `List ${turfMetaQuery.data.listCode}` : "Turf";

  return (
    <View className="flex-1 bg-background dark:bg-background-dark">
      <Stack.Screen
        options={{
          title: listTitle,
          headerBackVisible: false,
          gestureEnabled: false,
        }}
      />
      <View className="flex-1">
        <TurfMap
          turf={turfDataQuery.data}
          recordedBuildingIds={recordedBuildingIds}
          onBuildingPress={openBuilding}
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
        backgroundStyle={{ backgroundColor: isDark ? "#262626" : "#ffffff" }}
        handleComponent={renderHandle}
      >
        <BottomSheetFlatList
          data={turfDataQuery.data.buildings}
          keyExtractor={(b) => b.buildingId}
          contentContainerStyle={{ paddingBottom: 20 }}
          renderItem={({ item }) => (
            <BuildingRow
              building={item}
              recorded={recordedBuildingIds.has(item.buildingId)}
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
  recorded,
  onPress,
}: {
  building: TurfDataBuilding;
  recorded: boolean;
  onPress: () => void;
}) {
  const personCount = building.doors.reduce((sum, d) => sum + d.persons.length, 0);
  const address = formatBuildingAddress(building);

  return (
    <Pressable
      onPress={onPress}
      className="flex-row items-center px-5 pt-4 pb-5"
      android_ripple={{ color: "#eee" }}
    >
      <View className="flex-1">
        <Text className="font-sans-bold text-xl text-foreground dark:text-foreground-dark mb-1">
          {toTitleCase(address)}
        </Text>
        <View className="flex-row items-center gap-1.5 mt-1 mb-1">
          <Pill icon={<DoorClosed size={16} color="#1b1b1b" strokeWidth={2.5} />}>
            {building.doors.length}
          </Pill>
          <Pill icon={<UserRound size={16} color="#1b1b1b" strokeWidth={2.5} />}>
            {personCount}
          </Pill>
        </View>
      </View>
      {recorded && (
        <View className="w-[18px] h-[18px] rounded-full bg-blue-light border border-foreground dark:border-foreground-dark" />
      )}
    </Pressable>
  );
}

function formatBuildingAddress(b: TurfDataBuilding): string {
  const parts = [b.address.houseNumber, b.address.street].filter(Boolean);
  return parts.join(" ").trim() || "Unknown address";
}
