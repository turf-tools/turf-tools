import AsyncStorage from "@react-native-async-storage/async-storage";
import {
  ActionSheetIOS,
  Alert,
  Linking,
  Modal,
  Platform,
  Pressable,
  Text,
  View,
} from "react-native";
import { router } from "expo-router";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import Constants from "expo-constants";
import * as Updates from "expo-updates";
import {
  BrushCleaning,
  X,
  MoonStar,
  QrCode,
  Sun,
  Download,
  RefreshCw,
  Timer,
  UserRound,
} from "lucide-react-native";
import { useMemo, useState } from "react";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useQuery } from "@tanstack/react-query";
import { bottomClearance } from "@/components/bottom-nav";
import { Button } from "@/components/button";
import { WideButton } from "@/components/wide-button";
import { activeTurfAtom } from "@/lib/atoms/active-turf";
import { canvasserAtom } from "@/lib/atoms/canvasser";
import { SYNC_OPTIONS, syncIntervalAtom, userSyncingAtom } from "@/lib/atoms/sync";
import { themeAtom } from "@/lib/atoms/theme";
import {
  clearPullCache,
  derivePersonSummaries,
  isRecorded,
  pullCanvassEvents,
  useCanvassEvents,
  useSyncStatus,
} from "@/lib/canvass-events";
import { queryClient } from "@/lib/query-client";
import { clearHost, client } from "@/rpc/client";

// Dev-only escape hatch — hidden from the shipped menu but kept wired
// for quick re-enable.
const SHOW_RESET_APP_STATE = false as boolean;

const appVersion = Constants.expoConfig?.version ?? "?";

export default function SettingsScreen() {
  const [theme, setTheme] = useAtom(themeAtom);
  const activeTurf = useAtomValue(activeTurfAtom);
  const setActiveTurf = useSetAtom(activeTurfAtom);
  const [canvasser, setCanvasser] = useAtom(canvasserAtom);
  const [syncInterval, setSyncInterval] = useAtom(syncIntervalAtom);
  // User-initiated only — module-level atom so closing and reopening
  // Settings mid-sync still shows the in-flight state. Background
  // 30s polls don't flip this; the button only reflects user intent.
  const [syncing, setSyncing] = useAtom(userSyncingAtom);
  const syncStatus = useSyncStatus(activeTurf?.turfId ?? null);

  // OTA self-update — the background check on cold boot only applies a
  // downloaded update on the NEXT cold start, so this is the one path
  // that gets a device onto the latest bundle right now, no app-switcher
  // gymnastics. check/fetch reject in dev builds, hence the guard.
  const [updating, setUpdating] = useState(false);
  const handleUpdate = async () => {
    if (updating) return;
    if (__DEV__ || !Updates.isEnabled) {
      Alert.alert("Updates unavailable", "In-app updates only work in installed builds.");
      return;
    }
    setUpdating(true);
    try {
      const check = await Updates.checkForUpdateAsync();
      if (!check.isAvailable) {
        Alert.alert("Up to date", "You're already running the latest version.");
        return;
      }
      await Updates.fetchUpdateAsync();
      Alert.alert("Update ready", "The app will restart to apply it.", [
        { text: "Cancel", style: "cancel" },
        { text: "Restart", onPress: () => void Updates.reloadAsync() },
      ]);
    } catch {
      Alert.alert("Couldn't update", "Check your network connection and try again.");
    } finally {
      setUpdating(false);
    }
  };

  const handleShare = () => {
    if (!activeTurf) {
      Alert.alert("Nothing to share", "Open a turf first, then share it from here.");
      return;
    }
    router.push("/share");
  };

  const handleSync = async () => {
    if (!activeTurf) {
      Alert.alert(
        "Nothing to sync",
        "Open a turf first, syncing starts once you start collecting data.",
      );
      return;
    }
    setSyncing(true);
    try {
      await pullCanvassEvents(activeTurf.turfId);
      Alert.alert("Done", "Synced with server.");
    } catch {
      Alert.alert(
        "Sync failed",
        "Your results are saved locally and will not be lost. Try again when you have a network connection.",
      );
    } finally {
      setSyncing(false);
    }
  };

  // ActionSheetIOS crashes on Android — a styled modal stands in there.
  const [syncPickerOpen, setSyncPickerOpen] = useState(false);

  const handleSyncFrequency = () => {
    if (Platform.OS !== "ios") {
      setSyncPickerOpen(true);
      return;
    }
    const options = [...SYNC_OPTIONS.map((o) => o.label), "Cancel"];
    ActionSheetIOS.showActionSheetWithOptions(
      {
        options,
        cancelButtonIndex: options.length - 1,
        title: "Sync frequency",
        destructiveButtonIndex: SYNC_OPTIONS.findIndex((o) => o.value === 0),
      },
      (index) => {
        if (index < SYNC_OPTIONS.length) {
          void setSyncInterval(SYNC_OPTIONS[index]!.value);
        }
      },
    );
  };

  const syncLabel = SYNC_OPTIONS.find((o) => o.value === syncInterval)?.label ?? "Unknown";

  const handleDownloadNewTurf = () => {
    // Best-effort close of this device's walk, so the lead's board flips
    // to available without waiting for the next open. Fire-and-forget
    // (before clearHost so the request still knows the server): offline
    // unbinds fall back to implicit close on next open, or lead clear.
    if (activeTurf && canvasser?.phone) {
      try {
        void client.walks
          .close({ turfId: activeTurf.turfId, canvasserPhone: canvasser.phone })
          .catch(() => {});
      } catch {
        // Uninitialized client throws synchronously — nothing to close.
      }
    }
    setActiveTurf(null);
    clearHost();
    router.dismissAll();
    router.replace("/");
  };

  // Dev helper — wipes AsyncStorage (persisted react-query cache + jotai
  // atoms) and the in-memory query cache, then returns to the landing screen.
  // Useful when a schema change leaves stale shapes on disk.
  const handleResetAppState = () => {
    Alert.alert(
      "Reset app state?",
      "Clears all cached data and local storage. You'll need to open a turf again.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Reset",
          style: "destructive",
          onPress: async () => {
            await AsyncStorage.clear();
            queryClient.clear();
            clearPullCache();
            setActiveTurf(null);
            // In-memory atoms must be nulled explicitly — AsyncStorage.clear()
            // only wipes the persisted copies, and a still-set atom would
            // re-satisfy the canvasser gate (and re-persist on next write).
            setCanvasser(null);
            clearHost();
            router.dismissAll();
            router.replace("/");
          },
        },
      ],
    );
  };

  const insets = useSafeAreaInsets();
  const isDark = theme === "dark";

  // The X and the content column share this anchor so the title sits a
  // fixed distance below the close button on every device. iOS's deep top
  // inset lets the control tuck beside the notch; Android's slim status
  // bar needs it pushed below.
  const closeTop = Platform.OS === "android" ? insets.top + 12 : Math.max(insets.top - 41, 12);

  return (
    <View className="flex-1 bg-background dark:bg-background-dark">
      {/* X close button */}
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

      <View
        className="flex-1 items-center px-6"
        style={{ paddingTop: closeTop + 48 }} // start below the 48px X row
      >
        <Text
          className="mt-20 mb-8 text-4xl transform -skew-x-12 text-foreground dark:text-foreground-dark"
          style={{
            fontFamily: Platform.OS === "android" ? "Geist_700Bold_Italic" : "Geist_700Bold",
          }}
        >
          Settings
        </Text>

        <View className="gap-3 w-full max-w-xs">
          <Button
            title="Download new turf"
            variant="outline"
            onPress={handleDownloadNewTurf}
            icon={<Download size={20} color={theme == "light" ? "#1b1b1b" : "#ededed"} />}
          />
          <Button
            title="Share this turf"
            variant="outline"
            onPress={handleShare}
            icon={<QrCode size={20} color={theme == "light" ? "#1b1b1b" : "#ededed"} />}
          />
          <Button
            title={canvasser?.name ?? "Add your name"}
            variant="outline"
            onPress={() => router.push("/canvasser")}
            icon={<UserRound size={20} color={theme == "light" ? "#1b1b1b" : "#ededed"} />}
          />
          <Button
            title={theme === "dark" ? "Light mode" : "Dark mode"}
            onPress={() => setTheme(theme === "dark" ? "light" : "dark")}
            variant="outline"
            icon={
              theme == "light" ? (
                <MoonStar size={20} color={"#1b1b1b"} />
              ) : (
                <Sun size={20} color={"#ededed"} />
              )
            }
          />
          {SHOW_RESET_APP_STATE && (
            <Button
              title="Reset app state"
              variant="outline"
              onPress={handleResetAppState}
              icon={<BrushCleaning size={20} color={theme == "light" ? "#1b1b1b" : "#ededed"} />}
            />
          )}
          <Button
            title={`Sync frequency: ${syncLabel}`}
            variant="outline"
            onPress={handleSyncFrequency}
            icon={<Timer size={20} color={theme == "light" ? "#1b1b1b" : "#ededed"} />}
          />
          <Button
            title={syncing ? "Syncing..." : "Sync now"}
            variant="outline"
            onPress={handleSync}
            disabled={syncing}
            icon={<RefreshCw size={20} color={theme == "light" ? "#1b1b1b" : "#ededed"} />}
          />
          {activeTurf ? (
            <SyncStatusWithProgress turfId={activeTurf.turfId} status={syncStatus} />
          ) : (
            <SyncStatusLine status={syncStatus} progress={null} />
          )}
        </View>
      </View>

      {/* Absolute so the centered button stack keeps its position. */}
      <View
        className="absolute inset-x-0 flex-row justify-center gap-10"
        style={{
          // Android matches the nav bar's clearance above its system bar;
          // iOS has no bar to clear and keeps its own tuning.
          bottom: Platform.OS === "android" ? bottomClearance(insets) : insets.bottom + 12,
        }}
      >
        <FooterLink title="Privacy" url="https://turf.tools/privacy" />
        <FooterLink title="Support" url="https://turf.tools/support" />
        {/* Quiet OTA trigger — tapping the version checks for and applies
            the latest update ("Check for updates" is reserved for a future
            App Store-pointing action). */}
        <Pressable onPress={() => void handleUpdate()} hitSlop={8} className="active:opacity-60">
          {/* Label stays fixed while checking — it just dims until the
              result alert lands. */}
          <Text
            className="text-xl text-muted-foreground dark:text-muted-foreground-dark"
            style={{ fontFamily: "Geist_400Regular", opacity: updating ? 0.5 : 1 }}
          >
            Ver {appVersion}
          </Text>
        </Pressable>
      </View>

      {Platform.OS !== "ios" && (
        <Modal
          transparent
          visible={syncPickerOpen}
          animationType="fade"
          onRequestClose={() => setSyncPickerOpen(false)}
        >
          <Pressable
            className="flex-1 justify-end bg-black/40"
            onPress={() => setSyncPickerOpen(false)}
          >
            <Pressable
              onPress={() => {}}
              className="gap-2 rounded-t-2xl bg-background dark:bg-background-dark p-5"
              style={{ paddingBottom: insets.bottom + 20 }}
            >
              <Text
                className="mb-1 text-lg text-foreground dark:text-foreground-dark"
                style={{ fontFamily: "Geist_700Bold" }}
              >
                Sync frequency
              </Text>
              {SYNC_OPTIONS.map((o) => (
                <WideButton
                  key={o.value}
                  label={o.label}
                  selected={o.value === syncInterval}
                  onPress={() => {
                    void setSyncInterval(o.value);
                    setSyncPickerOpen(false);
                  }}
                />
              ))}
              <WideButton
                label="Cancel"
                variant="action"
                onPress={() => setSyncPickerOpen(false)}
              />
            </Pressable>
          </Pressable>
        </Modal>
      )}
    </View>
  );
}

function FooterLink({ title, url }: { title: string; url: string }) {
  return (
    <Pressable onPress={() => void Linking.openURL(url)} hitSlop={8} className="active:opacity-60">
      <Text
        className="text-xl text-muted-foreground dark:text-muted-foreground-dark"
        style={{ fontFamily: "Geist_400Regular" }}
      >
        {title}
      </Text>
    </Pressable>
  );
}

// Relative time. Under a minute uses 5-second buckets (matching the
// poll cadence) so the label ticks visibly without second-by-second
// flicker. Coarser units kick in thereafter.
function relativeTime(ms: number): string {
  const diff = Math.max(0, Date.now() - ms);
  const secs = Math.floor(diff / 1000);
  if (secs < 5) return "just now";
  if (secs < 60) return `${Math.floor(secs / 5) * 5}s ago`;
  const mins = Math.floor(diff / 60_000);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

// Attempted / total from the local event log, so it works offline. A person
// counts once their latest result is non-empty (same rule as the building
// rows); the denominator is the turf's server-side person count. Separate
// component so the event-log hooks only mount when a turf is active.
function SyncStatusWithProgress({
  turfId,
  status,
}: {
  turfId: string;
  status: ReturnType<typeof useSyncStatus>;
}) {
  const events = useCanvassEvents(turfId);
  const summaries = useMemo(() => derivePersonSummaries(events), [events]);
  const { data: meta } = useQuery({
    queryKey: ["turf", turfId] as const,
    queryFn: () => client.turfs.getById({ turfId }),
    staleTime: Infinity,
  });
  const total = meta?.personCount ?? 0;
  let progress: number | null = null;
  if (total > 0) {
    let attempted = 0;
    for (const personId of summaries.keys()) {
      if (isRecorded(summaries, personId)) attempted += 1;
    }
    progress = Math.min(100, Math.round((100 * attempted) / total));
  }
  return <SyncStatusLine status={status} progress={progress} />;
}

function SyncStatusLine({
  status,
  progress,
}: {
  status: ReturnType<typeof useSyncStatus>;
  progress: number | null;
}) {
  const { lastPullAt, lastErrorAt, pendingCount } = status;
  const erroredLast = lastErrorAt && (!lastPullAt || lastErrorAt > lastPullAt);
  const headline = erroredLast
    ? `Sync failure ${relativeTime(lastErrorAt)}`
    : lastPullAt
      ? `Last sync ${relativeTime(lastPullAt)}`
      : null;
  // Lines pack together (no blank placeholders between them); minHeight
  // still reserves the block so the stack doesn't shift as lines come
  // and go.
  const lines = [
    headline,
    pendingCount > 0
      ? `${pendingCount} ${pendingCount === 1 ? "result" : "results"} pending`
      : null,
    progress != null ? `Turf progress ${progress}%` : null,
  ].filter((line): line is string => line != null);
  return (
    <View className="items-center gap-0.5" style={{ minHeight: 84 }}>
      {lines.map((line) => (
        <Text
          key={line}
          className="text-xl text-muted-foreground dark:text-muted-foreground-dark"
          style={{ fontFamily: "Geist_400Regular" }}
        >
          {line}
        </Text>
      ))}
    </View>
  );
}
