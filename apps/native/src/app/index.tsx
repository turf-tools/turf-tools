import { Link, router } from "expo-router";
import { useState } from "react";
import { Alert, Text, TextInput, View } from "react-native";
import { Button } from "@/components/button";
import { client } from "@/rpc/client";

const SEEDED_TURF_ID = "00000000-0000-4000-8000-000000000006";

export default function LandingScreen() {
  const [code, setCode] = useState("");
  const [loading, setLoading] = useState(false);

  const handleOpenCode = async () => {
    const trimmed = code.trim();
    if (!trimmed) {
      Alert.alert("Enter a code", "Please enter a list code to open a turf.");
      return;
    }
    setLoading(true);
    try {
      const turf = await client.turfs.getByCode({ code: trimmed });
      if (turf) {
        router.push(`/turfs/${turf.turfId}`);
      } else {
        Alert.alert("Not found", `No turf found for code "${trimmed}".`);
      }
    } catch (err) {
      Alert.alert("Error", String(err));
    } finally {
      setLoading(false);
    }
  };

  return (
    <View className="flex-1 bg-background dark:bg-background-dark">
      <View className="flex-1 items-center justify-center p-6">
        <Text
          className="mb-2 text-4xl transform -skew-x-12 text-foreground dark:text-foreground-dark"
          style={{ fontFamily: "Geist_700Bold" }}
        >
          Field Tools
        </Text>
        <Text
          className="mt-12  mb-3 text-center text-xl text-muted-foreground dark:text-muted-foreground-dark"
          style={{ fontFamily: "Geist_400Regular" }}
        >
          Enter a list code to get started
        </Text>

        <View className="gap-3 w-full max-w-xs">
          <TextInput
            value={code}
            onChangeText={setCode}
            placeholder="List code"
            placeholderTextColor="#999"
            keyboardType="number-pad"
            className="font-sans text-lg text-foreground dark:text-foreground-dark bg-surface dark:bg-surface-dark border border-border dark:border-border-dark rounded-lg px-4 py-3 text-center"
          />
          <Button title={loading ? "Loading..." : "Open"} onPress={handleOpenCode} />
          <View className="h-12" />
          <Button
            title="Open test turf"
            variant="outline"
            onPress={() => router.push(`/turfs/${SEEDED_TURF_ID}`)}
          />
          <Link href="/distribute" asChild>
            <Button title="Distribute turf" variant="outline" />
          </Link>
        </View>
      </View>
    </View>
  );
}
