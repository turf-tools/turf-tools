import { useQuery } from "@tanstack/react-query";
import { router, Stack, useLocalSearchParams } from "expo-router";
import { useAtomValue, useSetAtom } from "jotai";
import { Ban, Check, Pencil, Scroll, Speech } from "lucide-react-native";
import { useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  Text,
  TextInput,
  View,
} from "react-native";
import type { TurfDataPerson } from "@field-tools/db/schema";
import { Pill } from "@/components/pill";
import { useBottomNav } from "@/lib/bottom-nav-context";
import { WideButton } from "@/components/wide-button";
import { isLocallyRecorded, localResultsAtom, useSetLocalResult } from "@/lib/local-results";
import { openSheetAtom } from "@/lib/atoms/sheet";
import { toTitleCase } from "@/lib/format";
import { buildTurfIndexes, useTurfData } from "@/lib/turf-data";
import { client } from "@/rpc/client";

type Mode = "script" | "unavailable" | "note";

const UNAVAILABLE_OPTIONS: Array<{
  value: string;
  label: string;
}> = [
  { value: "not_home", label: "Not home" },
  { value: "deceased", label: "Deceased" },
  { value: "hostile", label: "Hostile" },
  { value: "moved", label: "Moved" },
];

export default function PersonScreen() {
  const { turfId, personId } = useLocalSearchParams<{
    turfId: string;
    personId: string;
  }>();

  const turfMetaQuery = useQuery({
    queryKey: ["turf", turfId] as const,
    queryFn: () => client.turfs.getById({ turfId }),
    enabled: !!turfId,
  });
  const turfDataQuery = useTurfData(turfMetaQuery.data?.dataUrl ?? null);

  const scriptId = turfMetaQuery.data?.scriptId;
  const scriptQuery = useQuery({
    queryKey: ["script", scriptId] as const,
    queryFn: () => client.script.get({ scriptId: scriptId! }),
    enabled: !!scriptId,
  });

  const indexes = useMemo(
    () => (turfDataQuery.data ? buildTurfIndexes(turfDataQuery.data) : null),
    [turfDataQuery.data],
  );
  const person = indexes?.personsById.get(personId);
  const door = indexes?.doorByPersonId.get(personId);
  const building = indexes?.buildingByPersonId.get(personId);

  // Local results store — the single source of truth for persistence.
  const allResults = useAtomValue(localResultsAtom(turfId));
  const localResult = allResults[personId];
  const setResult = useSetLocalResult(turfId);
  const setOpenSheet = useSetAtom(openSheetAtom);
  const firstQuestion = scriptQuery.data?.questions?.[0];

  // Optimistic local state for instant visual feedback. The jotai atom
  // (setResult) persists to storage and notifies other screens, but its
  // re-render cycle is slower. This useState renders the check mark on
  // the very next frame.
  const [optimistic, setOptimistic] = useState(localResult);
  useEffect(() => {
    if (localResult) setOptimistic(localResult);
  }, [localResult]);

  const [mode, setMode] = useState<Mode>("script");

  // Sync mode to match existing result.
  useEffect(() => {
    if (optimistic?.unavailableOutcome) setMode("unavailable");
  }, [optimistic?.unavailableOutcome]);

  // Navigation
  const handleListPress = () => {
    setOpenSheet(true);
    router.dismissTo(`/turfs/${turfId}`);
  };
  const handleNextPress = () => {
    if (!building || !indexes) return;
    // Next unmarked person in THIS building, starting after the current one.
    const personsInBuilding = building.doors.flatMap((d) => d.persons);
    const currentIdx = personsInBuilding.findIndex((p) => p.personId === personId);
    const after = personsInBuilding.slice(currentIdx + 1);
    const before = personsInBuilding.slice(0, currentIdx);
    const nextInBuilding = [...after, ...before].find(
      (p) => !isLocallyRecorded(allResults, p.personId),
    );
    if (nextInBuilding) {
      router.replace(`/turfs/${turfId}/persons/${nextInBuilding.personId}`);
      return;
    }
    // If the current person isn't marked yet, there's nobody else — stay put.
    if (!isLocallyRecorded(allResults, personId)) return;
    // Building complete — offer to return to list or go to next building.
    const nextBuilding = indexes.buildingsInOrder.find((b) => {
      if (b.buildingId === building.buildingId) return false;
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

  // Loading / error states
  if (turfMetaQuery.isLoading || turfDataQuery.isLoading) {
    return (
      <View className="flex-1 items-center justify-center bg-background dark:bg-background-dark">
        <ActivityIndicator />
      </View>
    );
  }

  if (!person || !door || !building) {
    return (
      <View className="flex-1 items-center justify-center bg-background dark:bg-background-dark p-5">
        <Stack.Screen options={{ title: "Person" }} />
        <Text className="font-sans-bold text-red-dark mb-1">Person not found</Text>
        <Text className="font-sans text-sm text-muted-foreground dark:text-muted-foreground-dark">
          personId: {personId}
        </Text>
      </View>
    );
  }

  // Derive indicators from optimistic state (instant) for the Person screen.
  // Building/List screens read from the atom (slightly delayed but correct).
  const recorded =
    !!(
      optimistic?.surveyResponseOptionId ||
      optimistic?.unavailableOutcome ||
      (optimistic?.notes?.length ?? 0) > 0
    ) && !optimistic?.empty;
  const noteExists = (optimistic?.notes?.length ?? 0) > 0;
  const surveyExists =
    !!optimistic?.surveyResponseOptionId && !optimistic?.unavailableOutcome && !optimistic?.empty;
  const fullName =
    [person.firstName, person.lastName].filter(Boolean).join(" ").trim() || "Unknown";
  const buildingAddress = toTitleCase(
    [building.address.houseNumber, building.address.street].filter(Boolean).join(" "),
  );

  return (
    <View className="flex-1 bg-background dark:bg-background-dark">
      <Stack.Screen options={{ title: buildingAddress || "Person" }} />
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : "height"}
        className="flex-1"
      >
        <ScrollView>
          {/* Person header */}
          <View className="px-5 pt-5 pb-3">
            <Text className="font-sans-bold text-2xl text-foreground dark:text-foreground-dark mb-2">
              {toTitleCase(fullName)}
            </Text>
            <View className="flex-row items-center gap-2">
              <Pill>{formatAgeGender(person)}</Pill>
              <Pill>{formatParty(person)}</Pill>
              <View className="flex-1" />
              {noteExists && <Pill icon={<Scroll size={18} color="#1b1b1b" />} />}
              {surveyExists && <Pill icon={<Speech size={18} color="#1b1b1b" />} />}
              {recorded && (
                <Pill
                  variant="primary"
                  icon={<Check size={18} color="#3D7385" strokeWidth={2.5} />}
                />
              )}
            </View>
          </View>

          {/* Mode switch buttons */}
          <View className="px-5 py-3 gap-2">
            <WideButton
              label="Contact not available"
              icon={<Ban size={18} color={mode === "unavailable" ? "#1b1b1b" : "#888"} />}
              selected={mode === "unavailable"}
              onPress={() => {
                if (mode === "unavailable") {
                  const update = { unavailableOutcome: undefined, empty: undefined };
                  setOptimistic((prev) => ({ ...prev, ...update }));
                  setTimeout(() => setResult(personId, update), 0);
                  setMode("script");
                } else {
                  setMode("unavailable");
                }
              }}
            />
            <WideButton
              label="Add a note"
              icon={<Pencil size={18} color={mode === "note" ? "#1b1b1b" : "#888"} />}
              selected={mode === "note"}
              onPress={() => setMode(mode === "note" ? "script" : "note")}
            />
          </View>

          {/* Mode-specific content */}
          <View className="px-5 pt-7">
            {mode === "script" && (
              <ScriptContent
                scriptQuery={scriptQuery}
                selectedOptionId={optimistic?.surveyResponseOptionId}
                onSelectOption={(optionId) => {
                  const update = {
                    surveyResponseOptionId: optionId,
                    surveyQuestionId: firstQuestion?.surveyQuestionId,
                    unavailableOutcome: undefined,
                    empty: undefined,
                  };
                  setOptimistic((prev) => ({ ...prev, ...update }));
                  setTimeout(() => setResult(personId, update), 0);
                }}
                onClear={() => {
                  const update = {
                    surveyResponseOptionId: undefined,
                    surveyQuestionId: undefined,
                    unavailableOutcome: undefined,
                    empty: true,
                  };
                  setOptimistic((prev) => ({ ...prev, ...update }));
                  setTimeout(() => setResult(personId, update), 0);
                }}
              />
            )}
            {mode === "unavailable" && (
              <View className="gap-2">
                {UNAVAILABLE_OPTIONS.map((opt) => (
                  <WideButton
                    key={opt.value}
                    label={opt.label}
                    selected={optimistic?.unavailableOutcome === opt.value}
                    onPress={() => {
                      const update = {
                        unavailableOutcome: opt.value,
                        surveyResponseOptionId: undefined,
                        surveyQuestionId: undefined,
                        empty: undefined,
                      };
                      setOptimistic((prev) => ({ ...prev, ...update }));
                      setTimeout(() => setResult(personId, update), 0);
                    }}
                  />
                ))}
                <View className="flex-row gap-4 mt-4">
                  <View className="flex-1">
                    <WideButton
                      label="Cancel"
                      variant="action"
                      onPress={() => {
                        const update = { unavailableOutcome: undefined, empty: undefined };
                        setOptimistic((prev) => ({ ...prev, ...update }));
                        setTimeout(() => setResult(personId, update), 0);
                        setMode("script");
                      }}
                    />
                  </View>
                  <View className="flex-1">
                    <WideButton
                      label="Submit"
                      variant="action"
                      onPress={() => {
                        if (!optimistic?.unavailableOutcome) {
                          Alert.alert("Required", "Please select a reason before submitting.");
                          return;
                        }
                        router.back();
                      }}
                    />
                  </View>
                </View>
              </View>
            )}
            {mode === "note" && (
              <NoteContent
                notes={optimistic?.notes ?? []}
                onSubmitNote={(text) => {
                  const newNotes = [
                    ...(optimistic?.notes ?? []),
                    { text, canvassedAt: new Date().toISOString() },
                  ];
                  setOptimistic((prev) => ({ ...prev, notes: newNotes }));
                  setTimeout(() => setResult(personId, { notes: newNotes }), 0);
                }}
                onCancel={() => setMode("script")}
              />
            )}
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </View>
  );
}

// Script mode
function ScriptContent({
  scriptQuery,
  selectedOptionId,
  onSelectOption,
  onClear,
}: {
  scriptQuery: ReturnType<typeof useQuery<Awaited<ReturnType<typeof client.script.get>>>>;
  selectedOptionId: string | undefined;
  onSelectOption: (optionId: string) => void;
  onClear: () => void;
}) {
  if (scriptQuery.isLoading) return <ActivityIndicator />;
  if (!scriptQuery.data) {
    return (
      <Text className="font-sans text-muted-foreground dark:text-muted-foreground-dark">
        No script loaded
      </Text>
    );
  }

  const script = scriptQuery.data;
  const question = script.questions[0];
  if (!question) return null;

  return (
    <View className="gap-4">
      <Text className="font-sans text-lg text-muted-foreground dark:text-muted-foreground-dark leading-6">
        {script.name}
      </Text>
      <Text className="font-sans-bold text-lg text-foreground dark:text-foreground-dark">
        {question.text}
      </Text>
      <View className="gap-2">
        {question.options.map((opt) => (
          <WideButton
            key={opt.surveyResponseOptionId}
            label={opt.text}
            selected={selectedOptionId === opt.surveyResponseOptionId}
            onPress={() => onSelectOption(opt.surveyResponseOptionId)}
          />
        ))}
        <View className="flex-row gap-4 mt-4">
          <View className="flex-1">
            <WideButton label="Clear" variant="action" onPress={onClear} />
          </View>
          <View className="flex-1">
            <WideButton
              label="Submit"
              variant="action"
              onPress={() => {
                if (!selectedOptionId) {
                  Alert.alert("Required", "Please select a response before submitting.");
                  return;
                }
                router.back();
              }}
            />
          </View>
        </View>
      </View>
    </View>
  );
}

// Note mode
function NoteContent({
  notes,
  onSubmitNote,
  onCancel,
}: {
  notes: Array<{ text: string; canvassedAt: string }>;
  onSubmitNote: (text: string) => void;
  onCancel: () => void;
}) {
  const [focused, setFocused] = useState(false);
  const [pendingText, setPendingText] = useState("");

  const handleSubmit = () => {
    const trimmed = pendingText.trim();
    if (!trimmed) return;
    onSubmitNote(trimmed);
    setPendingText("");
  };

  return (
    <View className="gap-4">
      <TextInput
        value={pendingText}
        onChangeText={setPendingText}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        placeholder="Type a note..."
        placeholderTextColor="#999"
        multiline
        className={`font-sans text-lg text-foreground dark:text-foreground-dark bg-white dark:bg-background-dark border rounded-lg p-4 min-h-[120px] ${
          focused
            ? "border-foreground dark:border-foreground-dark"
            : "border-border dark:border-border-dark"
        }`}
        style={{
          textAlignVertical: "top",
          shadowColor: "#000",
          shadowOffset: { width: 0, height: 0 },
          shadowOpacity: 0.08,
          shadowRadius: 3,
        }}
      />
      <View className="flex-row gap-4">
        <View className="flex-1">
          <WideButton label="Cancel" variant="action" onPress={onCancel} />
        </View>
        <View className="flex-1">
          <WideButton label="Submit" variant="action" onPress={handleSubmit} />
        </View>
      </View>
      {notes.length > 0 && (
        <View>
          {notes.map((note, idx) => (
            <View key={idx}>
              {idx > 0 && <View className="h-px bg-border dark:bg-border-dark" />}
              <View className="flex-row py-3 gap-4">
                <Text className="font-sans text-lg text-muted-foreground dark:text-muted-foreground-dark w-20">
                  {formatNoteDate(note.canvassedAt)}
                </Text>
                <Text className="font-sans text-lg text-foreground dark:text-foreground-dark flex-1">
                  {note.text}
                </Text>
              </View>
            </View>
          ))}
        </View>
      )}
    </View>
  );
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

function formatNoteDate(dateStr: string): string {
  try {
    const d = new Date(dateStr);
    return `${d.getMonth() + 1}/${d.getDate()}/${String(d.getFullYear()).slice(2)}`;
  } catch {
    return dateStr;
  }
}
