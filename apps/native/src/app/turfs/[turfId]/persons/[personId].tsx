import { useQuery } from "@tanstack/react-query";
import { router, useLocalSearchParams } from "expo-router";
import { useAtomValue, useSetAtom } from "jotai";
import { Ban, Check, Pencil, Scroll } from "lucide-react-native";
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
import { Pill } from "@/components/pill";
import { useColors } from "@/lib/colors";
import { useScreenNav } from "@/lib/nav-context";
import { WideButton } from "@/components/wide-button";
import {
  derivePersonSummaries,
  isRecorded,
  useRecordEvent,
  useCanvassEvents,
} from "@/lib/canvass-events";
import { openSheetAtom } from "@/lib/atoms/sheet";
import { themeAtom } from "@/lib/atoms/theme";
import { toTitleCase } from "@/lib/format";
import { formatAge, formatEnrollment, formatGender } from "@/lib/format";
import { useTurf } from "@/lib/turf-data";
import { client } from "@/rpc/client";

type Mode = "script" | "unavailable" | "note" | "view-notes";

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

  const { meta, indexes, isLoading } = useTurf(turfId);

  const scriptId = meta?.scriptId;
  const scriptQuery = useQuery({
    queryKey: ["script", scriptId] as const,
    queryFn: () => client.script.get({ scriptId: scriptId! }),
    enabled: !!scriptId,
  });
  const person = indexes?.personsById.get(personId);
  const door = indexes?.doorByPersonId.get(personId);
  const building = indexes?.buildingByPersonId.get(personId);

  const events = useCanvassEvents(turfId);
  const summaries = useMemo(() => derivePersonSummaries(events), [events]);
  const recordEvent = useRecordEvent(turfId);
  const setOpenSheet = useSetAtom(openSheetAtom);
  const firstQuestion = scriptQuery.data?.questions?.[0];
  const theme = useAtomValue(themeAtom);
  const isDark = theme === "dark";
  const iconColor = isDark ? "#ededed" : "#1b1b1b";
  const mutedIconColor = isDark ? "#666" : "#888";
  const colors = useColors();

  // Derive current state from the person summary.
  const summary = summaries.get(personId);
  const latestResult = summary?.latestResult;
  const formattedNotes = (summary?.notes ?? []).map((e) => ({
    text: (e.payload as { text: string }).text,
    canvassedAt: (e.payload as { canvassedAt: string }).canvassedAt ?? e.createdAt,
  }));

  // Local display state for instant visual feedback. Initialized from the
  // live query summary, updated immediately on tap. The collection write
  // is deferred with setTimeout so the state update renders first.
  const [displayResult, setDisplayResult] = useState<{
    type: string;
    payload: Record<string, unknown>;
  } | null>(latestResult ? { type: latestResult.type, payload: latestResult.payload } : null);
  useEffect(() => {
    if (latestResult) {
      setDisplayResult({ type: latestResult.type, payload: latestResult.payload });
    }
  }, [latestResult]);

  // Wipe the recorded result for this person. Used by all the "back out"
  // affordances (mode-switch tap-to-deselect, response-button tap-to-clear,
  // Cancel button on unavailable). Idempotent — a no-op if nothing was
  // recorded, so callers don't have to gate. Optimistic local state flips
  // first; the collection write is deferred with setTimeout so React
  // renders the change before the event reaches the live query.
  const clearResult = () => {
    if (!displayResult || displayResult.type === "empty") return;
    setDisplayResult({ type: "empty", payload: { kind: "empty" } });
    setTimeout(() => recordEvent({ personId, type: "empty", payload: { kind: "empty" } }), 0);
  };

  const selectedOptionId =
    displayResult?.type === "survey"
      ? (displayResult.payload as { surveyResponseOptionId: string }).surveyResponseOptionId
      : undefined;
  const unavailableOutcome =
    displayResult?.type === "outcome"
      ? (displayResult.payload as { outcome: string }).outcome
      : undefined;

  const [mode, setMode] = useState<Mode>("script");

  // Sync mode to match existing result.
  useEffect(() => {
    if (unavailableOutcome) setMode("unavailable");
  }, [unavailableOutcome]);

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
    const nextInBuilding = [...after, ...before].find((p) => !isRecorded(summaries, p.personId));
    if (nextInBuilding) {
      router.replace(`/turfs/${turfId}/persons/${nextInBuilding.personId}`);
      return;
    }
    // If the current person isn't marked yet, there's nobody else — stay put.
    if (!isRecorded(summaries, personId)) return;
    // Building complete — offer to return to list or go to next building.
    const nextBuilding = indexes.buildingsInOrder.find((b) => {
      if (b.buildingId === building.buildingId) return false;
      return b.doors.some((d) => d.persons.some((p) => !isRecorded(summaries, p.personId)));
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

  const buildingAddress = building ? toTitleCase((building.address.street ?? "").trim()) : "";

  useScreenNav({
    title: buildingAddress || "Person",
    bottomButtons: ["search", "list", "next", "mic"],
    onBottomPress: (action) => {
      if (action === "list") handleListPress();
      else if (action === "next") handleNextPress();
      else handleStubPress(action);
    },
  });

  // Loading / error states
  if (isLoading) {
    return (
      <View className="flex-1 items-center justify-center bg-background dark:bg-background-dark">
        <ActivityIndicator />
      </View>
    );
  }

  if (!person || !door || !building) {
    return (
      <View className="flex-1 items-center justify-center bg-background dark:bg-background-dark p-5">
        <Text className="font-sans-bold text-destructive dark:text-destructive-dark mb-1">
          Person not found
        </Text>
        <Text className="font-sans text-sm text-muted-foreground dark:text-muted-foreground-dark">
          personId: {personId}
        </Text>
      </View>
    );
  }

  const recorded =
    !!displayResult && displayResult.type !== "empty" && displayResult.type !== "note";
  const noteExists = formattedNotes.length > 0;
  const surveyExists = displayResult?.type === "survey";
  const fullName =
    [person.firstName, person.lastName].filter(Boolean).join(" ").trim() || "Unknown";

  return (
    <View className="flex-1 bg-background dark:bg-background-dark">
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : "height"}
        className="flex-1"
      >
        <ScrollView keyboardShouldPersistTaps="handled">
          {/* Person header */}
          <View className="px-5 pt-5 pb-3">
            <Text className="font-sans-bold text-2xl text-foreground dark:text-foreground-dark mb-2">
              {toTitleCase(fullName)}
            </Text>
            <View className="flex-row items-center gap-2">
              <Pill>{formatAge(person)}</Pill>
              <Pill>{formatGender(person)}</Pill>
              <Pill>{formatEnrollment(person)}</Pill>
              <View className="flex-1" />
              {(() => {
                const role = surveyExists ? "contacted" : "unavailable";
                return (
                  <>
                    {noteExists && (
                      <Pill
                        style={recorded ? { backgroundColor: colors[role].background } : undefined}
                        icon={
                          <Scroll
                            size={18}
                            color={recorded ? colors[role].foreground : iconColor}
                          />
                        }
                      />
                    )}
                    {recorded && (
                      <Pill
                        style={{ backgroundColor: colors[role].background }}
                        icon={<Check size={18} color={colors[role].foreground} strokeWidth={2.5} />}
                      />
                    )}
                  </>
                );
              })()}
            </View>
          </View>

          {/* Mode switch buttons */}
          <View className="px-5 py-3 gap-2">
            <WideButton
              label="Contact not available"
              icon={<Ban size={18} color={mode === "unavailable" ? iconColor : mutedIconColor} />}
              selected={mode === "unavailable"}
              onPress={() => {
                if (mode === "unavailable") {
                  clearResult();
                  setMode("script");
                } else {
                  setMode("unavailable");
                }
              }}
            />
            {noteExists ? (
              <View className="flex-row gap-2">
                <View className="flex-1">
                  <WideButton
                    label="Add a note"
                    icon={<Pencil size={18} color={mode === "note" ? iconColor : mutedIconColor} />}
                    selected={mode === "note"}
                    onPress={() => setMode(mode === "note" ? "script" : "note")}
                  />
                </View>
                <View className="flex-1">
                  <WideButton
                    label="View notes"
                    icon={
                      <Scroll
                        size={18}
                        color={mode === "view-notes" ? iconColor : mutedIconColor}
                      />
                    }
                    selected={mode === "view-notes"}
                    onPress={() => setMode(mode === "view-notes" ? "script" : "view-notes")}
                  />
                </View>
              </View>
            ) : (
              <WideButton
                label="Add a note"
                icon={<Pencil size={18} color={mode === "note" ? iconColor : mutedIconColor} />}
                selected={mode === "note"}
                onPress={() => setMode(mode === "note" ? "script" : "note")}
              />
            )}
          </View>

          {/* Mode-specific content */}
          <View className="px-5 pt-7">
            {mode === "script" && (
              <ScriptContent
                scriptQuery={scriptQuery}
                selectedOptionId={selectedOptionId}
                onSelectOption={(optionId) => {
                  const payload = {
                    kind: "survey" as const,
                    surveyQuestionId: firstQuestion!.surveyQuestionId,
                    surveyResponseOptionId: optionId,
                  };
                  setDisplayResult({ type: "survey", payload });
                  setTimeout(() => recordEvent({ personId, type: "survey", payload }), 0);
                }}
                onClear={() => {
                  clearResult();
                }}
              />
            )}
            {mode === "unavailable" && (
              <UnavailableContent
                selectedOutcome={unavailableOutcome}
                onSelectOption={(value) => {
                  const payload = { kind: "outcome" as const, outcome: value };
                  setDisplayResult({ type: "outcome", payload });
                  setTimeout(() => recordEvent({ personId, type: "outcome", payload }), 0);
                }}
                onClear={() => {
                  clearResult();
                }}
                onCancel={() => {
                  clearResult();
                  setMode("script");
                }}
              />
            )}
            {mode === "note" && (
              <NoteContent
                notes={formattedNotes}
                onSubmitNote={(text) => {
                  recordEvent({
                    personId,
                    type: "note",
                    payload: { kind: "note", text, canvassedAt: new Date().toISOString() },
                  });
                  setMode("script");
                }}
                onCancel={() => setMode("script")}
              />
            )}
            {mode === "view-notes" && <NotesList notes={formattedNotes} className="-mt-[1px]" />}
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </View>
  );
}

// Unavailable mode for "contact not available" outcomes.
function UnavailableContent({
  selectedOutcome,
  onSelectOption,
  onClear,
  onCancel,
}: {
  selectedOutcome: string | undefined;
  onSelectOption: (value: string) => void;
  onClear: () => void;
  onCancel: () => void;
}) {
  const colors = useColors();
  return (
    <View className="gap-2">
      {UNAVAILABLE_OPTIONS.map((opt) => (
        <WideButton
          key={opt.value}
          label={opt.label}
          selected={selectedOutcome === opt.value}
          selectedForegroundColor={colors.unavailable.foreground}
          selectedBackgroundColor={colors.unavailable.background}
          onPress={() => (selectedOutcome === opt.value ? onClear() : onSelectOption(opt.value))}
        />
      ))}
      <View className="flex-row gap-4 mt-4">
        <View className="flex-1">
          <WideButton label="Cancel" variant="action" onPress={onCancel} />
        </View>
        <View className="flex-1">
          <WideButton
            label="Submit"
            variant="submit"
            onPress={() => {
              if (!selectedOutcome) {
                Alert.alert("Required", "Please select a reason before submitting.");
                return;
              }
              router.back();
            }}
          />
        </View>
      </View>
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
  const colors = useColors();
  if (scriptQuery.isLoading) return <ActivityIndicator />;
  if (!scriptQuery.data) {
    return (
      <Text className="font-sans text-lg text-muted-foreground dark:text-muted-foreground-dark">
        Error loading script
      </Text>
    );
  }

  const script = scriptQuery.data;
  const question = script.questions[0];
  if (!question) return null;

  return (
    <View className="gap-4 mb-6">
      <Text className="font-sans-bold text-lg text-foreground dark:text-muted-foreground-dark leading-6">
        {script.name}
      </Text>
      <Text className="font-sans text-lg text-foreground dark:text-foreground-dark">
        {question.text}
      </Text>
      <View className="gap-2">
        {question.options.map((opt) => (
          <WideButton
            key={opt.surveyResponseOptionId}
            label={opt.text}
            selected={selectedOptionId === opt.surveyResponseOptionId}
            selectedForegroundColor={colors.contacted.foreground}
            selectedBackgroundColor={colors.contacted.background}
            onPress={() =>
              selectedOptionId === opt.surveyResponseOptionId
                ? onClear()
                : onSelectOption(opt.surveyResponseOptionId)
            }
          />
        ))}
        <View className="flex-row gap-4 mt-4">
          <View className="flex-1">
            <WideButton label="Clear" variant="action" onPress={onClear} />
          </View>
          <View className="flex-1">
            <WideButton
              label="Submit"
              variant="submit"
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
  const isDark = useAtomValue(themeAtom) === "dark";
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
        placeholderTextColor={isDark ? "#666" : "#999"}
        multiline
        className={`font-sans text-lg text-foreground dark:text-foreground-dark bg-surface dark:bg-surface-dark border rounded-lg p-4 min-h-[120px] ${
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
          <WideButton label="Submit" variant="submit" onPress={handleSubmit} />
        </View>
      </View>
      <NotesList notes={notes} />
    </View>
  );
}

function NotesList({
  notes,
  className,
}: {
  notes: Array<{ text: string; canvassedAt: string }>;
  className?: string;
}) {
  if (notes.length === 0) return null;
  return (
    <View className={className}>
      <Text className="font-sans-bold text-lg text-foreground dark:text-foreground-dark mb-[1px]">
        Notes
      </Text>
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
  );
}

function formatNoteDate(dateStr: string): string {
  try {
    const d = new Date(dateStr);
    return `${d.getMonth() + 1}/${d.getDate()}/${String(d.getFullYear()).slice(2)}`;
  } catch {
    return dateStr;
  }
}
