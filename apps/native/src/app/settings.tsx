import { router } from "expo-router";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { useState } from "react";
import { Alert, Text, View } from "react-native";
import { Button } from "@/components/button";
import { currentTurfIdAtom } from "@/lib/atoms/current-turf";
import { themeAtom } from "@/lib/atoms/theme";
import { clearLocalResults, localResultsAtom, useSync } from "@/lib/local-results";

export default function SettingsScreen() {
  const [theme, setTheme] = useAtom(themeAtom);
  const currentTurfId = useAtomValue(currentTurfIdAtom);
  const { sync, isSyncing } = useSync(currentTurfId);
  const setResults = useSetAtom(localResultsAtom(currentTurfId ?? ""));
  const [clearing, setClearing] = useState(false);

  const handleSync = async () => {
    try {
      await sync();
      Alert.alert("Done", "All dirty results synced to server.");
    } catch (err) {
      Alert.alert("Sync failed", String(err));
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

  return (
    <View className="flex-1 items-center justify-center bg-background dark:bg-background-dark p-6">
      <View className="gap-3 w-full max-w-xs">
        <Button
          title={theme === "dark" ? "Switch to light" : "Switch to dark"}
          onPress={() => setTheme(theme === "dark" ? "light" : "dark")}
          variant="outline"
        />
        <Button title="Download new turf" variant="outline" onPress={handleDownloadNewTurf} />
        <Button
          title="Distribute turf"
          variant="outline"
          onPress={() => {
            router.back();
            router.push("/distribute");
          }}
        />

        <View className="h-4" />
        <Text className="font-sans text-xl text-muted-foreground dark:text-muted-foreground-dark text-center">
          Dev tools
        </Text>
        <Button
          title={isSyncing ? "Syncing..." : "Sync data"}
          variant="outline"
          onPress={currentTurfId ? handleSync : undefined}
        />
        <Button
          title={clearing ? "Clearing..." : "Clear local data"}
          variant="outline"
          onPress={currentTurfId ? handleClearData : undefined}
        />
        {!currentTurfId && (
          <Text className="font-sans text-sm text-muted-foreground dark:text-muted-foreground-dark text-center">
            Open a turf to enable sync and clear
          </Text>
        )}
      </View>
    </View>
  );
}
