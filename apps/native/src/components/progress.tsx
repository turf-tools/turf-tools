import { router } from "expo-router";
import { useAtomValue } from "jotai";
import { useMemo } from "react";
import { Pressable, Text } from "react-native";
import Svg, { Circle } from "react-native-svg";
import { themeAtom } from "@/lib/atoms/theme";
import { derivePersonSummaries, useCanvassEvents } from "@/lib/canvass-events";
import { useColors } from "@/lib/colors";
import { deriveTurfProgress } from "@/lib/progress";
import { useTurf } from "@/lib/turf-data";

const SIZE = 48;
const STROKE = 3;
// Inset the ring a hair so it doesn't clip at the button edge.
const RADIUS = (SIZE - STROKE) / 2 - 1;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

const SHADOW = {
  shadowColor: "#000",
  shadowOffset: { width: 0, height: 2 },
  shadowOpacity: 0.15,
  shadowRadius: 6,
  elevation: 4,
};

// Turf progress chrome button: percent-marked number inside a two-segment
// ring (contacted + unavailable, matching the map dot colors), in the
// top-nav slot where back would be. Tapping opens the Progress modal.
export function ProgressButton({ turfId }: { turfId: string }) {
  const isDark = useAtomValue(themeAtom) === "dark";
  const colors = useColors();

  const events = useCanvassEvents(turfId);
  const summaries = useMemo(() => derivePersonSummaries(events), [events]);
  const { indexes } = useTurf(turfId);
  const progress = useMemo(
    () => (indexes ? deriveTurfProgress(indexes, summaries) : null),
    [indexes, summaries],
  );
  if (!progress) return null;

  const percent = progress.percent;
  const total = progress.people.total;
  const contactedFrac = total > 0 ? progress.people.contacted / total : 0;
  const unavailableFrac =
    total > 0 ? (progress.people.done - progress.people.contacted) / total : 0;

  return (
    <Pressable
      onPress={() => router.push("/progress")}
      hitSlop={4}
      className="items-center justify-center w-12 h-12 rounded-full bg-surface dark:bg-surface-dark active:opacity-60"
      style={SHADOW}
    >
      <Svg width={SIZE} height={SIZE} style={{ position: "absolute" }}>
        <Circle
          cx={SIZE / 2}
          cy={SIZE / 2}
          r={RADIUS}
          stroke={isDark ? "#333333" : "#e5e5e5"}
          strokeWidth={STROKE}
          fill="none"
        />
        {contactedFrac > 0 && (
          <Circle
            cx={SIZE / 2}
            cy={SIZE / 2}
            r={RADIUS}
            stroke={colors.contacted.solid}
            strokeWidth={STROKE}
            fill="none"
            strokeDasharray={`${CIRCUMFERENCE * contactedFrac} ${CIRCUMFERENCE}`}
            transform={`rotate(-90 ${SIZE / 2} ${SIZE / 2})`}
          />
        )}
        {unavailableFrac > 0 && (
          <Circle
            cx={SIZE / 2}
            cy={SIZE / 2}
            r={RADIUS}
            stroke={colors.unavailable.solid}
            strokeWidth={STROKE}
            fill="none"
            strokeDasharray={`${CIRCUMFERENCE * unavailableFrac} ${CIRCUMFERENCE}`}
            transform={`rotate(${-90 + 360 * contactedFrac} ${SIZE / 2} ${SIZE / 2})`}
          />
        )}
      </Svg>
      <Text
        className="text-foreground dark:text-foreground-dark"
        style={{
          fontFamily: "Geist_700Bold",
          // Three digits + % need a smaller face to clear the ring.
          fontSize: percent === 100 ? 11 : 13,
          fontVariant: ["tabular-nums"],
          // The trailing % reads lighter than the digits, dragging the
          // optical center left — nudge right to compensate.
          transform: [{ translateX: 1 }],
        }}
      >
        {percent}%
      </Text>
    </Pressable>
  );
}
