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
import type { CanvassEventPayload, TurfDataPerson } from "@field-tools/db/schema";

type Mode = "script" | "unavailable" | "note" | "details";

// Stable reference so the derivedSelections useEffect doesn't fire
// every render when the person has no events yet.
const EMPTY_SELECTIONS = new Map<string, string>();

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
    queryFn: () => client.scripts.get({ scriptId: scriptId! }),
    enabled: !!scriptId,
  });
  const person = indexes?.personsById.get(personId);
  const door = indexes?.doorByPersonId.get(personId);
  const building = indexes?.buildingByPersonId.get(personId);

  const events = useCanvassEvents(turfId);
  const summaries = useMemo(() => derivePersonSummaries(events), [events]);
  const recordEvent = useRecordEvent(turfId);
  const setOpenSheet = useSetAtom(openSheetAtom);
  const theme = useAtomValue(themeAtom);
  const isDark = theme === "dark";
  const iconColor = isDark ? "#ededed" : "#1b1b1b";
  const mutedIconColor = isDark ? "#666" : "#888";
  const colors = useColors();

  const summary = summaries.get(personId);
  const formattedNotes = (summary?.notes ?? []).map((e) => ({
    text: (e.payload as { text: string }).text,
    createdAt: e.createdAt,
  }));

  // Optimistic mirrors: taps update local state immediately so the
  // check renders/clears this frame; useEffect re-syncs from derived
  // once the event lands in the live query.
  const derivedSelections = summary?.selectedByQuestion ?? EMPTY_SELECTIONS;
  const [selectedOptionByQuestion, setSelectedOptionByQuestion] =
    useState<Map<string, string>>(derivedSelections);
  useEffect(() => {
    setSelectedOptionByQuestion(derivedSelections);
  }, [derivedSelections]);

  const derivedOutcome = summary?.currentOutcome ?? null;
  const [unavailableOutcome, setUnavailableOutcome] = useState<string | null>(derivedOutcome);
  useEffect(() => {
    setUnavailableOutcome(derivedOutcome);
  }, [derivedOutcome]);

  const [mode, setMode] = useState<Mode>("script");

  useEffect(() => {
    if (unavailableOutcome) setMode("unavailable");
  }, [unavailableOutcome]);

  // Emit a full result snapshot for the current disposition. An "unavailable"
  // outcome and responses are mutually exclusive: an outcome clears
  // responses, and present responses imply "canvassed".
  const emitResult = (selections: Map<string, string>, outcome: string | null) => {
    const responses: Record<string, { optionIds: string[] }> = {};
    let resolvedOutcome = outcome;
    if (!outcome && selections.size > 0) {
      resolvedOutcome = "canvassed";
      for (const [questionId, optionId] of selections) {
        responses[questionId] = { optionIds: [optionId] };
      }
    }
    const payload = { kind: "result", outcome: resolvedOutcome, responses } as CanvassEventPayload;
    setTimeout(() => recordEvent({ personId, kind: "result", payload }), 0);
  };

  const clearResult = () => {
    if (unavailableOutcome === null && selectedOptionByQuestion.size === 0) return;
    setUnavailableOutcome(null);
    setSelectedOptionByQuestion(new Map());
    emitResult(new Map(), null);
  };

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

  const noteExists = formattedNotes.length > 0;
  const responsesExist = selectedOptionByQuestion.size > 0;
  const recorded = responsesExist || unavailableOutcome != null;
  const fullName =
    [person.firstName, person.middleName, person.lastName, person.nameSuffix]
      .filter(Boolean)
      .join(" ")
      .trim() || "Unknown";

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
              {person.dateOfBirth !== undefined && <Pill>{formatAge(person)}</Pill>}
              {person.gender !== undefined && <Pill>{formatGender(person)}</Pill>}
              {person.enrollment !== undefined && <Pill>{formatEnrollment(person)}</Pill>}
              <View className="flex-1" />
              {(() => {
                const role = responsesExist ? "contacted" : "unavailable";
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
                  label="View details"
                  icon={
                    <Scroll size={18} color={mode === "details" ? iconColor : mutedIconColor} />
                  }
                  selected={mode === "details"}
                  onPress={() => setMode(mode === "details" ? "script" : "details")}
                />
              </View>
            </View>
          </View>

          {/* Mode-specific content */}
          <View className="px-5 pt-7">
            {mode === "script" && (
              <ScriptContent
                scriptQuery={scriptQuery}
                selectedOptionByQuestion={selectedOptionByQuestion}
                onSelectOption={(questionId, responseOptionId) => {
                  const next = new Map(selectedOptionByQuestion);
                  if (responseOptionId === null) next.delete(questionId);
                  else next.set(questionId, responseOptionId);
                  setSelectedOptionByQuestion(next);
                  // Picking a response also un-marks unavailable.
                  if (responseOptionId !== null) setUnavailableOutcome(null);
                  emitResult(next, null);
                }}
                onClear={clearResult}
              />
            )}
            {mode === "unavailable" && (
              <UnavailableContent
                selectedOutcome={unavailableOutcome ?? undefined}
                onSelectOption={(value) => {
                  setUnavailableOutcome(value);
                  setSelectedOptionByQuestion(new Map());
                  emitResult(new Map(), value);
                }}
                onClear={clearResult}
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
                    kind: "note",
                    payload: { kind: "note", text },
                  });
                  setMode("script");
                }}
                onCancel={() => setMode("script")}
              />
            )}
            {mode === "details" && <DetailsContent person={person} notes={formattedNotes} />}
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </View>
  );
}

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

function ScriptContent({
  scriptQuery,
  selectedOptionByQuestion,
  onSelectOption,
  onClear,
}: {
  scriptQuery: ReturnType<typeof useQuery<Awaited<ReturnType<typeof client.scripts.get>>>>;
  selectedOptionByQuestion: Map<string, string>;
  onSelectOption: (questionId: string, responseOptionId: string | null) => void;
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

  return (
    <View className="gap-4 mb-6">
      <Text className="font-sans-bold text-lg text-foreground dark:text-foreground-dark leading-6">
        {script.name}
      </Text>
      {script.steps.map((step) => {
        if (step.stepType === "text") {
          return (
            <Text
              key={step.scriptStepId}
              className="font-sans text-lg transform -skew-x-12 leading-6"
            >
              {step.text}
            </Text>
          );
        }
        const selected = selectedOptionByQuestion.get(step.questionId);
        return (
          <View key={step.scriptStepId} className="gap-2">
            <Text className="font-sans text-lg text-foreground dark:text-foreground-dark">
              {step.text}
            </Text>
            {step.options.map((opt) => (
              <WideButton
                key={opt.responseOptionId}
                label={opt.text}
                selected={selected === opt.responseOptionId}
                selectedForegroundColor={colors.contacted.foreground}
                selectedBackgroundColor={colors.contacted.background}
                onPress={() =>
                  selected === opt.responseOptionId
                    ? onSelectOption(step.questionId, null)
                    : onSelectOption(step.questionId, opt.responseOptionId)
                }
              />
            ))}
          </View>
        );
      })}
      <View className="flex-row gap-4 mt-4">
        <View className="flex-1">
          <WideButton label="Clear" variant="action" onPress={onClear} />
        </View>
        <View className="flex-1">
          <WideButton label="Submit" variant="submit" onPress={() => router.back()} />
        </View>
      </View>
    </View>
  );
}

function NoteContent({
  notes,
  onSubmitNote,
  onCancel,
}: {
  notes: Array<{ text: string; createdAt: string }>;
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
      <DetailSection title="Notes" items={noteItems(notes)} />
    </View>
  );
}

function DetailsContent({
  person,
  notes,
}: {
  person: TurfDataPerson;
  notes: Array<{ text: string; createdAt: string }>;
}) {
  const voting = votingHistoryItems(person.votingHistory);
  const notesList = noteItems(notes);
  if (voting.length === 0 && notesList.length === 0) {
    return (
      <Text className="font-sans text-lg text-muted-foreground dark:text-muted-foreground-dark -mt-[1px]">
        No details available
      </Text>
    );
  }
  return (
    <View className="gap-6 -mt-[2px]">
      <DetailSection title="Notes" items={notesList} />
      <DetailSection title="Voting history" items={voting} />
    </View>
  );
}

// Auto-hides when there are no items so empty sections don't render.
function DetailSection({
  title,
  items,
}: {
  title: string;
  items: Array<{ label: string; date: string }>;
}) {
  if (items.length === 0) return null;
  return (
    <View>
      <Text className="font-sans-bold text-lg text-foreground dark:text-foreground-dark mb-[2px]">
        {title}
      </Text>
      <DetailList items={items} />
    </View>
  );
}

function DetailList({ items }: { items: Array<{ label: string; date: string }> }) {
  return (
    <View>
      {items.map((item, idx) => (
        <View key={idx}>
          {idx > 0 && <View className="h-px bg-border dark:bg-border-dark" />}
          <View className="flex-row py-3 gap-4">
            <Text className="font-sans text-lg text-muted-foreground dark:text-muted-foreground-dark w-20">
              {item.date}
            </Text>
            <Text className="font-sans text-lg text-foreground dark:text-foreground-dark flex-1">
              {item.label}
            </Text>
          </View>
        </View>
      ))}
    </View>
  );
}

// ----- Item adapters -------------------------------------------------------

function noteItems(
  notes: Array<{ text: string; createdAt: string }>,
): Array<{ label: string; date: string }> {
  return notes.map((n) => ({ label: n.text, date: formatShortDate(n.createdAt) }));
}

const ELECTION_TYPE_LABELS: Record<string, string> = {
  general: "General",
  primary: "Primary",
  presidential_primary: "Pres. primary",
};

function votingHistoryItems(
  history: TurfDataPerson["votingHistory"],
): Array<{ label: string; date: string }> {
  // Sort most-recent first; fall back to year when `date` is missing. Absent
  // (dataset without voting history) → no items, so the section hides.
  const sorted = [...(history ?? [])].sort((a, b) => {
    const aKey = a.date ?? `${a.year}-12-31`;
    const bKey = b.date ?? `${b.year}-12-31`;
    return bKey.localeCompare(aKey);
  });
  return sorted.slice(0, 5).map((e) => ({
    label: `${ELECTION_TYPE_LABELS[e.type] ?? e.type} ${e.year}`,
    date: e.date ? formatShortDate(e.date) : String(e.year),
  }));
}

function formatShortDate(dateStr: string): string {
  try {
    const d = new Date(dateStr);
    return `${d.getMonth() + 1}/${d.getDate()}/${String(d.getFullYear()).slice(2)}`;
  } catch {
    return dateStr;
  }
}
