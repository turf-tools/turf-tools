import AsyncStorage from "@react-native-async-storage/async-storage";
import { ActionSheetIOS, Alert, Linking, Pressable, Text, View } from "react-native";
import { router } from "expo-router";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import {
  BrushCleaning,
  X,
  MoonStar,
  Sun,
  Download,
  RefreshCw,
  Timer,
  UserRound,
} from "lucide-react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Button } from "@/components/button";
import { activeTurfAtom } from "@/lib/atoms/active-turf";
import { canvasserAtom } from "@/lib/atoms/canvasser";
import { SYNC_OPTIONS, syncIntervalAtom, userSyncingAtom } from "@/lib/atoms/sync";
import { themeAtom } from "@/lib/atoms/theme";
import { clearPullCache, pullCanvassEvents, useSyncStatus } from "@/lib/canvass-events";
import { queryClient } from "@/lib/query-client";
import { clearHost, client } from "@/rpc/client";

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

  const handleSyncFrequency = () => {
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

  return (
    <View className="flex-1 bg-background dark:bg-background-dark">
      {/* X close button */}
      <Pressable
        onPress={() => router.back()}
        hitSlop={4}
        className="absolute z-10 items-center justify-center w-12 h-12 rounded-full bg-surface dark:bg-surface-dark active:opacity-60"
        style={{
          top: insets.top - 35,
          right: 20,
          shadowColor: "#000",
          shadowOffset: { width: 0, height: 2 },
          shadowOpacity: 0.15,
          shadowRadius: 6,
          elevation: 4,
        }}
      >
        <X size={20} color={isDark ? "#ededed" : "#1b1b1b"} strokeWidth={2} />
      </Pressable>

      <View className="flex-1 items-center justify-center p-6">
        <Text
          className="mb-8 text-4xl transform -skew-x-12 text-foreground dark:text-foreground-dark"
          style={{ fontFamily: "Geist_700Bold" }}
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
          <Button
            title="Reset app state"
            variant="outline"
            onPress={handleResetAppState}
            icon={<BrushCleaning size={20} color={theme == "light" ? "#1b1b1b" : "#ededed"} />}
          />
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
          <SyncStatusLine status={syncStatus} />
        </View>
      </View>

      {/* Absolute so the centered button stack keeps its position. */}
      <View
        className="absolute inset-x-0 flex-row justify-center gap-10"
        style={{ bottom: insets.bottom + 12 }}
      >
        <FooterLink title="Privacy" url="https://turf.tools/privacy" />
        <FooterLink title="Support" url="https://turf.tools/support" />
      </View>
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

function SyncStatusLine({ status }: { status: ReturnType<typeof useSyncStatus> }) {
  const { lastPullAt, lastErrorAt, pendingCount } = status;
  const erroredLast = lastErrorAt && (!lastPullAt || lastErrorAt > lastPullAt);
  const headline = erroredLast
    ? `Sync failure ${relativeTime(lastErrorAt)}`
    : lastPullAt
      ? `Last sync ${relativeTime(lastPullAt)}`
      : null;
  // Always reserve space for both lines so the layout doesn't shift as
  // status text appears, disappears, or wraps to a second line.
  return (
    <View className="items-center gap-0.5" style={{ minHeight: 56 }}>
      <Text
        className="text-xl text-muted-foreground dark:text-muted-foreground-dark"
        style={{ fontFamily: "Geist_400Regular" }}
      >
        {headline ?? " "}
      </Text>
      <Text
        className="text-xl text-muted-foreground dark:text-muted-foreground-dark"
        style={{ fontFamily: "Geist_400Regular" }}
      >
        {pendingCount > 0
          ? `${pendingCount} ${pendingCount === 1 ? "result" : "results"} pending`
          : " "}
      </Text>
    </View>
  );
}
