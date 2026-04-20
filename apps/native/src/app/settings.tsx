import { ActionSheetIOS, Alert, Pressable, Text, View } from "react-native";
import { router } from "expo-router";
import { useAtom, useAtomValue } from "jotai";
import { X, MoonStar, Sun, Download, ListCheck, RefreshCw, Timer } from "lucide-react-native";
import { useState } from "react";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Button } from "@/components/button";
import { currentTurfIdAtom } from "@/lib/atoms/current-turf";
import { SYNC_OPTIONS, syncIntervalAtom } from "@/lib/atoms/sync";
import { themeAtom } from "@/lib/atoms/theme";
import { pullCanvassEvents } from "@/lib/canvass-events";

export default function SettingsScreen() {
  const [theme, setTheme] = useAtom(themeAtom);
  const currentTurfId = useAtomValue(currentTurfIdAtom);
  const [syncInterval, setSyncInterval] = useAtom(syncIntervalAtom);
  const [syncing, setSyncing] = useState(false);

  const handleSync = async () => {
    if (!currentTurfId) return;
    setSyncing(true);
    try {
      await pullCanvassEvents(currentTurfId);
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
    router.dismissAll();
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
            title="Download new turf"
            variant="outline"
            onPress={handleDownloadNewTurf}
            icon={<Download size={20} color={theme == "light" ? "#1b1b1b" : "#ededed"} />}
          />
          <Button
            title="Distribute turf"
            variant="outline"
            onPress={() => {
              router.back();
              router.push("/distribute");
            }}
            icon={<ListCheck size={20} color={theme == "light" ? "#1b1b1b" : "#ededed"} />}
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
            onPress={currentTurfId ? handleSync : undefined}
            icon={<RefreshCw size={20} color={theme == "light" ? "#1b1b1b" : "#ededed"} />}
          />
        </View>
      </View>
    </View>
  );
}
