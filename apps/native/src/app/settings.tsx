import { router } from "expo-router";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import {
  X,
  MoonStar,
  Sun,
  Download,
  ListCheck,
  RefreshCw,
  BrushCleaning,
} from "lucide-react-native";
import { useState } from "react";
import { Alert, Pressable, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Button } from "@/components/button";
import { currentTurfIdAtom } from "@/lib/atoms/current-turf";
import { themeAtom } from "@/lib/atoms/theme";
import { clearLocalResults, localResultsAtom, useSync } from "@/lib/local-results";
import { useTurf } from "@/lib/turf-data";

export default function SettingsScreen() {
  const [theme, setTheme] = useAtom(themeAtom);
  const currentTurfId = useAtomValue(currentTurfIdAtom);
  const { indexes } = useTurf(currentTurfId ?? "");
  const { sync, isSyncing } = useSync(currentTurfId, indexes);
  const setResults = useSetAtom(localResultsAtom(currentTurfId ?? ""));
  const [clearing, setClearing] = useState(false);

  const handleSync = async () => {
    try {
      const count = await sync();
      if (count === 0) {
        Alert.alert("Not needed", "No current canvass results need syncing.");
      } else {
        Alert.alert("Done", `Synced ${count} result${count === 1 ? "" : "s"} to server.`);
      }
    } catch {
      Alert.alert(
        "Sync failed",
        "Your results are saved locally and will not be lost. Try again when you have a network connection.",
      );
    }
  };

  const handleClearData = () => {
    if (!currentTurfId) return;
    Alert.alert(
      "Clear local data",
      "This will remove all locally stored canvass results. Unsynced data will be lost.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Clear",
          style: "destructive",
          onPress: async () => {
            setClearing(true);
            try {
              await clearLocalResults(currentTurfId, setResults);
              Alert.alert("Done", "Local results cleared.");
            } catch (err) {
              Alert.alert("Error", String(err));
            } finally {
              setClearing(false);
            }
          },
        },
      ],
    );
  };

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
          {!currentTurfId && (
            <Text className="font-sans text-xl mt-[-8] text-muted-foreground dark:text-muted-foreground-dark text-center">
              Turf must be loaded
            </Text>
          )}
          <Button
            title={isSyncing ? "Syncing..." : "Sync data"}
            variant="outline"
            onPress={currentTurfId ? handleSync : undefined}
            icon={<RefreshCw size={20} color={theme == "light" ? "#1b1b1b" : "#ededed"} />}
          />
          <Button
            title={clearing ? "Clearing..." : "Clear local data"}
            variant="outline"
            onPress={currentTurfId ? handleClearData : undefined}
            icon={<BrushCleaning size={20} color={theme == "light" ? "#1b1b1b" : "#ededed"} />}
          />
        </View>
      </View>
    </View>
  );
}
