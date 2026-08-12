import { useQuery } from "@tanstack/react-query";
import { router, useLocalSearchParams } from "expo-router";
import { useAtomValue, useSetAtom } from "jotai";
import { Ban, Check, Pencil, Scroll, X } from "lucide-react-native";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  AppState,
  Keyboard,
  Platform,
  Pressable,
  Text,
  TextInput,
  View,
} from "react-native";
import { KeyboardAwareScrollView } from "react-native-keyboard-controller";
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
import {
  formatAge,
  formatEnrollment,
  formatGender,
  formatPersonName,
  formatUnitShort,
} from "@/lib/format";
import { useTurf } from "@/lib/turf-data";
import { client } from "@/rpc/client";
import type { CanvassEventPayload, ResponseValue, TurfDataPerson } from "@turf-tools/db/schema";

type Mode = "script" | "unavailable" | "note" | "details";

// Stable reference so the derivedResponses useEffect doesn't fire
// every render when the person has no events yet.
const EMPTY_RESPONSES = new Map<string, ResponseValue>();

// Trailing debounce for tap emits (answers and unavailable outcomes): a
// tap burst at a doorstep collapses into one snapshot event instead of
// one per tap — each isolated send costs a full cellular radio wake+tail,
// so cadence, not payload, is what drains canvasser batteries. Flushed
// early only where context dies — Submit / person change / unmount /
// app background — so the crash-loss window is only ever these few
// seconds of the newest edits. Text blur just schedules too: blur is an
// edit boundary like a tap, and keeps emits off focused inputs.
const EMIT_DEBOUNCE_MS = 5000;

// One forward pass over the ordered steps: a step with `showIfOptionId` is
// visible only while that option is selected AND its question's step is itself
// visible — so changing an upstream answer collapses the whole chain. Archived
// options never arrive on the wire, so a condition on one simply never matches.
type ScriptStepLike = {
  stepType: string;
  showIfOptionId: string | null;
  questionId?: string;
  options?: Array<{ responseOptionId: string }>;
};

function visibleScriptSteps<S extends ScriptStepLike>(
  steps: readonly S[],
  responses: ReadonlyMap<string, ResponseValue>,
): S[] {
  const questionByOption = new Map<string, string>();
  for (const s of steps) {
    if (s.stepType === "question" && s.questionId) {
      for (const o of s.options ?? []) questionByOption.set(o.responseOptionId, s.questionId);
    }
  }
  const hiddenQuestions = new Set<string>();
  const visible: S[] = [];
  for (const s of steps) {
    let show = true;
    if (s.showIfOptionId != null) {
      const controller = questionByOption.get(s.showIfOptionId);
      const value = controller ? responses.get(controller) : undefined;
      const selected = value && "optionIds" in value ? value.optionIds : [];
      show =
        controller != null &&
        !hiddenQuestions.has(controller) &&
        selected.includes(s.showIfOptionId);
    }
    if (show) visible.push(s);
    else if (s.stepType === "question" && s.questionId) hiddenQuestions.add(s.questionId);
  }
  return visible;
}

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
  // once the event lands in the live query. Skipped while anything is
  // uncommitted (text draft or debounced taps) — a landed event carries
  // state as of the last emit, and re-syncing would revert edits made
  // since.
  const textDirtyRef = useRef(false);
  const pendingEmitRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const derivedResponses = summary?.responsesByQuestion ?? EMPTY_RESPONSES;
  const [responsesByQuestion, setResponsesByQuestion] =
    useState<Map<string, ResponseValue>>(derivedResponses);
  useEffect(() => {
    if (textDirtyRef.current || pendingEmitRef.current != null) return;
    setResponsesByQuestion(derivedResponses);
  }, [derivedResponses]);
  // Fresh-state mirrors for timer callbacks and unmount cleanups.
  const responsesRef = useRef(responsesByQuestion);
  responsesRef.current = responsesByQuestion;
  const scriptRef = useRef(scriptQuery.data);
  scriptRef.current = scriptQuery.data;

  const derivedOutcome = summary?.currentOutcome ?? null;
  const [unavailableOutcome, setUnavailableOutcome] = useState<string | null>(derivedOutcome);
  useEffect(() => {
    if (textDirtyRef.current || pendingEmitRef.current != null) return;
    setUnavailableOutcome(derivedOutcome);
  }, [derivedOutcome]);
  const outcomeRef = useRef(unavailableOutcome);
  outcomeRef.current = unavailableOutcome;
  // Writes go through this so the ref is fresh for timer callbacks even
  // before React re-renders — a debounced emit reads the (responses,
  // outcome) pair from refs, and mutual exclusion must hold there too.
  const setOutcome = (value: string | null) => {
    setUnavailableOutcome(value);
    outcomeRef.current = value;
  };

  const [mode, setMode] = useState<Mode>("script");

  useEffect(() => {
    if (unavailableOutcome) setMode("unavailable");
  }, [unavailableOutcome]);

  // Emit a full result snapshot for the current disposition. An "unavailable"
  // outcome and responses are mutually exclusive: an outcome clears
  // responses, and present responses imply "canvassed". Blank text and
  // empty option sets are dropped — only meaningful answers ship.
  const emitResult = (next: Map<string, ResponseValue>, outcome: string | null) => {
    // Every emit is a full snapshot, so any emit settles a pending text
    // draft AND supersedes any debounced tap emit still on the timer.
    textDirtyRef.current = false;
    if (pendingEmitRef.current != null) {
      clearTimeout(pendingEmitRef.current);
      pendingEmitRef.current = null;
    }
    const responses: Record<string, ResponseValue> = {};
    let resolvedOutcome = outcome;
    if (!outcome) {
      // Never ship an answer to a step the current answers hide — stale
      // hidden answers can hydrate in from events that predate a condition.
      // Questions outside the script still ship.
      const steps = scriptRef.current?.steps;
      const hiddenQuestions = new Set<string>();
      if (steps) {
        const visible = new Set(
          visibleScriptSteps(steps, next)
            .filter((s) => s.stepType === "question")
            .map((s) => s.questionId),
        );
        for (const s of steps) {
          if (s.stepType === "question" && s.questionId && !visible.has(s.questionId)) {
            hiddenQuestions.add(s.questionId);
          }
        }
      }
      for (const [questionId, value] of next) {
        if (hiddenQuestions.has(questionId)) continue;
        if ("optionIds" in value) {
          if (value.optionIds.length > 0) responses[questionId] = value;
        } else if (value.text.trim().length > 0) {
          responses[questionId] = { text: value.text.trim() };
        }
      }
      if (Object.keys(responses).length > 0) resolvedOutcome = "canvassed";
    }
    const payload = { kind: "result", outcome: resolvedOutcome, responses } as CanvassEventPayload;
    setTimeout(() => recordEvent({ personId, kind: "result", payload }), 0);
  };

  const clearResult = () => {
    Keyboard.dismiss();
    if (unavailableOutcome === null && responsesByQuestion.size === 0) return;
    setOutcome(null);
    setResponsesByQuestion(new Map());
    responsesRef.current = new Map();
    scheduleEmit();
  };

  // Backing out of unavailable mode without having chosen an outcome is a
  // pure mode switch — in-progress script responses survive. With an
  // outcome chosen, leaving un-chooses it (responses were already cleared
  // when the option was tapped, so clearResult only affects the outcome).
  const exitUnavailable = () => {
    Keyboard.dismiss();
    if (outcomeRef.current != null) clearResult();
    setMode("script");
  };

  // Trailing debounce: reads state fresh (from refs) at fire time so
  // anything tapped or typed meanwhile rides along in the one snapshot.
  const scheduleEmit = () => {
    if (pendingEmitRef.current != null) clearTimeout(pendingEmitRef.current);
    pendingEmitRef.current = setTimeout(() => {
      pendingEmitRef.current = null;
      emitResult(responsesRef.current, outcomeRef.current);
    }, EMIT_DEBOUNCE_MS);
  };

  // All taps (answers, outcomes, clear) update state instantly but emit
  // on the debounce; text accumulates until a commit boundary
  // (per-keystroke or per-tap events would flood the append-only log and
  // wake the radio per interaction).
  const toggleOption = (questionId: string, optionId: string, multi: boolean) => {
    // Answering another question while typing should also put the
    // keyboard away — option buttons handle their own taps, so the
    // blank-space dismisser never sees them.
    Keyboard.dismiss();
    const next = new Map(responsesByQuestion);
    const current = next.get(questionId);
    const ids = current && "optionIds" in current ? current.optionIds : [];
    const on = ids.includes(optionId);
    const nextIds = multi
      ? on
        ? ids.filter((i) => i !== optionId)
        : [...ids, optionId]
      : on
        ? []
        : [optionId];
    if (nextIds.length === 0) next.delete(questionId);
    else next.set(questionId, { optionIds: nextIds });
    // Drop answers of steps this change hid, so re-shown steps start blank
    // and the next snapshot omits them. Questions outside the script are
    // left alone.
    const steps = scriptQuery.data?.steps;
    if (steps) {
      const visibleQuestions = new Set(
        visibleScriptSteps(steps, next)
          .filter((s) => s.stepType === "question")
          .map((s) => s.questionId),
      );
      for (const s of steps) {
        if (s.stepType === "question" && s.questionId && !visibleQuestions.has(s.questionId)) {
          next.delete(s.questionId);
        }
      }
    }
    setResponsesByQuestion(next);
    responsesRef.current = next;
    // Picking a response also un-marks unavailable.
    if (nextIds.length > 0) setOutcome(null);
    scheduleEmit();
  };

  const changeText = (questionId: string, text: string) => {
    const next = new Map(responsesByQuestion);
    if (text.length === 0) next.delete(questionId);
    else next.set(questionId, { text });
    setResponsesByQuestion(next);
    responsesRef.current = next;
    textDirtyRef.current = true;
    if (text.trim().length > 0) setOutcome(null);
  };

  // Text's edit boundary: blur (and Android keyboard-hide) put the draft
  // on the same debounce as taps — no emit while the input is focused,
  // no immediate emit either.
  const scheduleTextEmit = () => {
    if (textDirtyRef.current) scheduleEmit();
  };

  // Hard boundary: emit anything uncommitted (text draft or debounced
  // taps) right now. No-ops when nothing is pending.
  const flushPending = () => {
    if (!textDirtyRef.current && pendingEmitRef.current == null) return;
    emitResult(responsesRef.current, outcomeRef.current);
  };

  // Ref indirection so once-registered listeners/cleanups see fresh state.
  const flushPendingRef = useRef(flushPending);
  flushPendingRef.current = flushPending;
  const scheduleTextEmitRef = useRef(scheduleTextEmit);
  scheduleTextEmitRef.current = scheduleTextEmit;

  // Android's back gesture hides the keyboard without blurring the input,
  // which would strand a draft — commit directly. No forced blur: didHide
  // fires when the hide animation completes, so a quick re-tap into the
  // input would get blurred by the previous dismissal's late event. iOS
  // never hides the keyboard while an input is focused, so its blur path
  // always commits first.
  useEffect(() => {
    if (Platform.OS !== "android") return;
    const sub = Keyboard.addListener("keyboardDidHide", () => scheduleTextEmitRef.current());
    return () => sub.remove();
  }, []);

  // JS timers pause while backgrounded — a pending window would survive an
  // app switch but not a kill. Flush on the way out.
  useEffect(() => {
    const sub = AppState.addEventListener("change", (state) => {
      if (state !== "active") flushPendingRef.current();
    });
    return () => sub.remove();
  }, []);

  // Last-resort commit: leaving the screen (back gesture, list nav) with
  // anything uncommitted must not drop answers.
  useEffect(() => () => flushPendingRef.current(), []);

  const handleListPress = () => {
    setOpenSheet(true);
    router.dismissTo(`/turfs/${turfId}`);
  };
  const handleNextPress = () => {
    // Flush before a person-to-person route replace: expo-router may reuse
    // this component with new params, so the unmount flush can't be relied
    // on to fire under the old person's identity.
    flushPending();
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
    // Judged from the optimistic refs, not derived summaries: the flush
    // above can't land in this render's summaries, and waiting for it
    // dead-taps Next on the last person in a building.
    if (responsesRef.current.size === 0 && outcomeRef.current == null) return;
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
  const titleUnit = formatUnitShort(door?.unit);

  useScreenNav({
    title: buildingAddress || "Person",
    titleSuffix: titleUnit,
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
  const responsesExist = responsesByQuestion.size > 0;
  const recorded = responsesExist || unavailableOutcome != null;
  const fullName = formatPersonName(person);

  return (
    <View className="flex-1 bg-background dark:bg-background-dark">
      {/* Keyboard avoidance + caret reveal are native
          (react-native-keyboard-controller), one path for both platforms. */}
      <KeyboardAwareScrollView
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="interactive"
        bottomOffset={16}
        // flexGrow floors content at viewport height: a stale keyboard inset
        // on short content (e.g. unavailable mode) can otherwise scroll
        // everything off-screen irrecoverably.
        contentContainerStyle={{ flexGrow: 1, paddingBottom: 8 }}
      >
        {/* Taps on blank space dismiss the keyboard (and blur-commit any
              open-ended draft) — RN doesn't do this for non-interactive
              views on its own. Child touchables still win the responder. */}
        <Pressable onPress={Keyboard.dismiss} accessible={false}>
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
              label="Could not reach person"
              icon={<Ban size={18} color={mode === "unavailable" ? iconColor : mutedIconColor} />}
              selected={mode === "unavailable"}
              onPress={() => {
                if (mode === "unavailable") {
                  exitUnavailable();
                } else {
                  Keyboard.dismiss();
                  setMode("unavailable");
                }
              }}
            />
            <View className="flex-row gap-2">
              <View className="flex-1">
                <WideButton
                  label={mode === "note" ? "Close note" : "Add a note"}
                  icon={
                    mode === "note" ? (
                      <X size={18} color={iconColor} />
                    ) : (
                      <Pencil size={18} color={mutedIconColor} />
                    )
                  }
                  selected={mode === "note"}
                  onPress={() => {
                    Keyboard.dismiss();
                    setMode(mode === "note" ? "script" : "note");
                  }}
                />
              </View>
              <View className="flex-1">
                <WideButton
                  label={mode === "details" ? "Close details" : "View details"}
                  icon={
                    mode === "details" ? (
                      <X size={18} color={iconColor} />
                    ) : (
                      <Scroll size={18} color={mutedIconColor} />
                    )
                  }
                  selected={mode === "details"}
                  onPress={() => {
                    Keyboard.dismiss();
                    setMode(mode === "details" ? "script" : "details");
                  }}
                />
              </View>
            </View>
          </View>

          {/* Mode-specific content */}
          <View className="px-5 pt-7">
            {mode === "script" && (
              <ScriptContent
                scriptQuery={scriptQuery}
                responses={responsesByQuestion}
                onToggleOption={toggleOption}
                onChangeText={changeText}
                onTextBlur={scheduleTextEmit}
                onSubmit={flushPending}
                onClear={clearResult}
              />
            )}
            {mode === "unavailable" && (
              <UnavailableContent
                selectedOutcome={unavailableOutcome ?? undefined}
                onSelectOption={(value) => {
                  setOutcome(value);
                  setResponsesByQuestion(new Map());
                  responsesRef.current = new Map();
                  scheduleEmit();
                }}
                onClear={clearResult}
                onCancel={exitUnavailable}
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
        </Pressable>
      </KeyboardAwareScrollView>
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
  responses,
  onToggleOption,
  onChangeText,
  onTextBlur,
  onSubmit,
  onClear,
}: {
  scriptQuery: ReturnType<typeof useQuery<Awaited<ReturnType<typeof client.scripts.get>>>>;
  responses: Map<string, ResponseValue>;
  onToggleOption: (questionId: string, optionId: string, multi: boolean) => void;
  onChangeText: (questionId: string, text: string) => void;
  onTextBlur: () => void;
  onSubmit: () => void;
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
    <View className="gap-6 mb-6">
      <Text className="font-sans-bold text-lg text-foreground dark:text-foreground-dark leading-6">
        {script.name}
      </Text>
      {visibleScriptSteps(script.steps, responses).map((step) => {
        if (step.stepType === "text") {
          // Real italic face, not the skew transform — skewX staircases
          // multi-line text (each line shifts further than the last).
          return (
            <Text
              key={step.scriptStepId}
              className="font-sans text-lg leading-6"
              style={{ fontFamily: "Geist_400Regular_Italic" }}
            >
              {step.text}
            </Text>
          );
        }
        const value = responses.get(step.questionId);
        if (step.responseType === "open_ended") {
          return (
            <View key={step.scriptStepId} className="gap-2">
              <Text className="font-sans text-lg leading-6 mb-0.5 text-foreground dark:text-foreground-dark">
                {step.text}
              </Text>
              <OpenEndedInput
                text={value && "text" in value ? value.text : ""}
                onChangeText={(t) => onChangeText(step.questionId, t)}
                onBlur={onTextBlur}
              />
            </View>
          );
        }
        const selectedIds = value && "optionIds" in value ? value.optionIds : [];
        const multi = step.responseType === "multi_select";
        return (
          <View key={step.scriptStepId} className="gap-2">
            <Text className="font-sans text-lg leading-6 mb-0.5 text-foreground dark:text-foreground-dark">
              {step.text}
            </Text>
            {step.options.map((opt) => (
              <WideButton
                key={opt.responseOptionId}
                label={opt.text}
                selected={selectedIds.includes(opt.responseOptionId)}
                selectedForegroundColor={colors.contacted.foreground}
                selectedBackgroundColor={colors.contacted.background}
                onPress={() => onToggleOption(step.questionId, opt.responseOptionId, multi)}
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
          <WideButton
            label="Submit"
            variant="submit"
            onPress={() => {
              // Commit any un-blurred text answer before leaving.
              onSubmit();
              router.back();
            }}
          />
        </View>
      </View>
    </View>
  );
}

// Free-text answer input for open-ended questions. Styled after the note
// input; the parent owns the value and the blur-time emit.
function OpenEndedInput({
  text,
  onChangeText,
  onBlur,
}: {
  text: string;
  onChangeText: (text: string) => void;
  onBlur: () => void;
}) {
  const isDark = useAtomValue(themeAtom) === "dark";
  const [focused, setFocused] = useState(false);
  return (
    <TextInput
      value={text}
      onChangeText={onChangeText}
      onFocus={() => setFocused(true)}
      onBlur={() => {
        setFocused(false);
        onBlur();
      }}
      placeholder="Type an answer..."
      placeholderTextColor={isDark ? "#666" : "#999"}
      multiline
      // Done key dismisses (blur commits the draft; nothing submits).
      // Costs newline entry — fine for doorstep answers.
      returnKeyType="done"
      submitBehavior="blurAndSubmit"
      className={`font-sans text-lg text-foreground dark:text-foreground-dark bg-surface dark:bg-surface-dark border rounded-lg p-4 min-h-[80px] ${
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
        // Done dismisses here too — costs newlines, but a stuck keyboard
        // over the Submit button (large-font devices) is the worse trade.
        returnKeyType="done"
        submitBehavior="blurAndSubmit"
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
      <View className="mt-5">
        <DetailSection title="Previous notes" items={noteItems(notes)} />
      </View>
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
          <View className="flex-row py-3 gap-8">
            {/* fontVariant via style, not the tabular-nums class — NativeWind
                drops font-variant-numeric (only -caps is mapped). */}
            <Text
              className="font-sans text-lg text-muted-foreground dark:text-muted-foreground-dark w-20"
              style={{ fontVariant: ["tabular-nums"] }}
            >
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
