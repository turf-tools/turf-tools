import { router } from "expo-router";
import { useAtomValue } from "jotai";
import { X } from "lucide-react-native";
import { Fragment, useMemo } from "react";
import { Platform, Pressable, ScrollView, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useQuery } from "@tanstack/react-query";
import { activeTurfAtom } from "@/lib/atoms/active-turf";
import { themeAtom } from "@/lib/atoms/theme";
import { derivePersonSummaries, useCanvassEvents } from "@/lib/canvass-events";
import { useColors } from "@/lib/colors";
import { deriveResponseTallies, deriveTurfProgress } from "@/lib/progress";
import { useTurf } from "@/lib/turf-data";
import { client } from "@/rpc/client";
import { Pill } from "@/components/pill";

// Progress modal — the active turf's completion breakdown: people and
// doors counts, results by outcome, and per-question response tallies.
export default function ProgressScreen() {
  const insets = useSafeAreaInsets();
  const isDark = useAtomValue(themeAtom) === "dark";
  const activeTurf = useAtomValue(activeTurfAtom);

  // The title row and the X share this offset so they stay vertically
  // aligned regardless of device inset. iOS's deep top inset lets the
  // control tuck up beside the notch; Android's slim status bar needs it
  // pushed below instead.
  const closeTop = Platform.OS === "android" ? insets.top + 12 : Math.max(insets.top - 41, 12);

  return (
    <View className="flex-1 bg-background dark:bg-background-dark">
      {/* X close button (matches Settings) */}
      <Pressable
        onPress={() => router.back()}
        hitSlop={4}
        className="absolute z-10 items-center justify-center w-12 h-12 rounded-full bg-surface dark:bg-surface-dark active:opacity-60"
        style={{
          top: closeTop,
          right: 22,
          shadowColor: "#000",
          shadowOffset: { width: 0, height: 2 },
          shadowOpacity: 0.15,
          shadowRadius: 6,
          elevation: 4,
        }}
      >
        <X size={20} color={isDark ? "#ededed" : "#1b1b1b"} strokeWidth={2} />
      </Pressable>

      <View className="flex-1" style={{ paddingTop: closeTop }}>
        {/* Same height as the X so the title centers on it. */}
        <View className="h-12 justify-center">
          <Text
            className="self-center text-3xl transform -skew-x-12 text-foreground dark:text-foreground-dark"
            style={{
              fontFamily: Platform.OS === "android" ? "Geist_700Bold_Italic" : "Geist_700Bold",
            }}
          >
            Progress
          </Text>
        </View>

        {activeTurf ? (
          <ProgressContent turfId={activeTurf.turfId} bottomInset={insets.bottom} />
        ) : (
          <Text
            className="mt-6 text-center text-xl text-muted-foreground dark:text-muted-foreground-dark"
            style={{ fontFamily: "Geist_400Regular" }}
          >
            No active turf
          </Text>
        )}
      </View>
    </View>
  );
}

// Separate component so the event-log hooks only mount when a turf is
// active.
function ProgressContent({ turfId, bottomInset }: { turfId: string; bottomInset: number }) {
  const events = useCanvassEvents(turfId);
  const summaries = useMemo(() => derivePersonSummaries(events), [events]);
  const { meta, indexes } = useTurf(turfId);
  const scriptId = meta?.scriptId;
  const scriptQuery = useQuery({
    queryKey: ["script", scriptId] as const,
    queryFn: () => client.scripts.get({ scriptId: scriptId! }),
    enabled: !!scriptId,
    staleTime: Infinity,
  });

  const progress = useMemo(
    () => (indexes ? deriveTurfProgress(indexes, summaries) : null),
    [indexes, summaries],
  );
  const tallies = useMemo(
    () => (scriptQuery.data ? deriveResponseTallies(scriptQuery.data.steps, summaries) : []),
    [scriptQuery.data, summaries],
  );

  if (!progress) return null;

  return (
    <ScrollView
      contentContainerStyle={{
        paddingTop: 24,
        paddingHorizontal: 24,
        paddingBottom: bottomInset + 20,
      }}
    >
      <SectionHeader first>Overall</SectionHeader>
      <StatRow label="People" done={progress.people.done} total={progress.people.total} />
      <StatRow label="Doors" done={progress.doors.done} total={progress.doors.total} />

      <SectionHeader>Results</SectionHeader>
      {progress.outcomes.length === 0 ? (
        <Text className="py-2 font-sans text-xl text-muted-foreground dark:text-muted-foreground-dark">
          No results yet
        </Text>
      ) : (
        progress.outcomes.map((outcome) => (
          <TallyRow
            key={outcome.value}
            label={outcome.label}
            count={outcome.count}
            percent={outcome.percent}
            role={outcome.value === "canvassed" ? "contacted" : "unavailable"}
          />
        ))
      )}

      {tallies.length > 0 && (
        <>
          <SectionHeader>Responses</SectionHeader>
          {tallies.map((question, idx) => (
            <Fragment key={question.questionId}>
              {idx > 0 && <View className="h-px bg-border dark:bg-border-dark my-2" />}
              <View className="mb-1">
                <Text className="py-1 font-sans text-xl text-foreground dark:text-foreground-dark">
                  {question.text}
                </Text>
                {question.options.map((option) => (
                  <TallyRow
                    key={option.responseOptionId}
                    label={option.text}
                    count={option.count}
                    percent={option.percent}
                  />
                ))}
              </View>
            </Fragment>
          ))}
        </>
      )}
    </ScrollView>
  );
}

function SectionHeader({ children, first }: { children: string; first?: boolean }) {
  return (
    <Text
      className={`mb-2 text-xl text-foreground dark:text-foreground-dark ${first ? "" : "mt-6"}`}
      style={{ fontFamily: "Geist_700Bold" }}
    >
      {children}
    </Text>
  );
}

function StatRow({ label, done, total }: { label: string; done: number; total: number }) {
  const percent = total > 0 ? Math.min(100, Math.round((100 * done) / total)) : 0;
  return (
    <View className="flex-row items-center py-2">
      <Text className="flex-1 font-sans text-xl text-foreground dark:text-foreground-dark">
        {label}
      </Text>
      <Text
        className="mr-3 font-sans text-xl text-muted-foreground dark:text-muted-foreground-dark"
        style={{ fontVariant: ["tabular-nums"] }}
      >
        {done}/{total}
      </Text>
      <PercentPill percent={percent} />
    </View>
  );
}

function TallyRow({
  label,
  count,
  percent,
  role,
}: {
  label: string;
  count: number;
  percent: number;
  role?: "contacted" | "unavailable";
}) {
  return (
    <View className="flex-row items-center py-1.5">
      <Text
        className="flex-1 font-sans text-xl text-foreground dark:text-foreground-dark"
        numberOfLines={1}
      >
        {label}
      </Text>
      <Text
        className="mr-3 font-sans text-xl text-muted-foreground dark:text-muted-foreground-dark"
        style={{ fontVariant: ["tabular-nums"] }}
      >
        {count}
      </Text>
      <PercentPill percent={percent} role={role} />
    </View>
  );
}

// Fixed-width wrapper keeps the pills right-aligned down the list; wide
// enough for a three-digit "100%".
function PercentPill({ percent, role }: { percent: number; role?: "contacted" | "unavailable" }) {
  const colors = useColors();
  const variant = role ? colors[role] : null;
  return (
    <View style={{ width: 72, alignItems: "flex-end" }}>
      <Pill style={variant ? { backgroundColor: variant.background } : undefined}>
        <Text style={variant ? { color: variant.foreground } : null}>{percent}%</Text>
      </Pill>
    </View>
  );
}
