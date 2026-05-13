import { router } from "expo-router";
import { useAtom } from "jotai";
import { useEffect, useRef, useState } from "react";
import { Alert, Keyboard, Pressable, Text, TextInput, View } from "react-native";
import { Button } from "@/components/button";
import { activeTurfAtom } from "@/lib/atoms/active-turf";
import { createdByNameAtom } from "@/lib/atoms/created-by-name";
import { openTurf } from "@/lib/canvass-events";
import { client, setHost } from "@/rpc/client";

export default function LandingScreen() {
  const [host, setHostInput] = useState("");
  const [code, setCode] = useState("");
  const [loading, setLoading] = useState(false);

  const codeRef = useRef<TextInput>(null);
  const [activeTurf, setActiveTurf] = useAtom(activeTurfAtom);
  const [createdByName, setCreatedByName] = useAtom(createdByNameAtom);

  // Clear inputs only when the binding transitions from bound → null (i.e.
  // user hit "Download new turf"). Settings round-trips don't change
  // activeTurf so partial input survives.
  const prevActiveTurf = useRef(activeTurf);
  useEffect(() => {
    if (prevActiveTurf.current !== null && activeTurf === null) {
      setHostInput("");
      setCode("");
    }
    prevActiveTurf.current = activeTurf;
  }, [activeTurf]);

  const goToTurf = (turfId: string) => {
    void openTurf(turfId).catch(() => {
      Alert.alert(
        "Could not retrieve previous results",
        "Data may be out of date, sync when you have a connection.",
      );
    });
    router.push(`/turfs/${turfId}`);
  };

  const promptForName = (turfId: string) => {
    Alert.prompt(
      "Your name",
      "Recorded on every canvass event so organizers know who collected the result.",
      [
        {
          text: "Cancel",
          style: "cancel",
          // Declining the name prompt drops the binding — we don't proceed
          // into the turf without an attribution.
          onPress: () => setActiveTurf(null),
        },
        {
          text: "Save",
          onPress: (text?: string) => {
            const trimmed = text?.trim() ?? "";
            if (!trimmed) {
              setActiveTurf(null);
              return;
            }
            setCreatedByName(trimmed);
            goToTurf(turfId);
          },
        },
      ],
      "plain-text",
    );
  };

  const handleSubmit = async () => {
    const trimmedHost = host.trim();
    const trimmedCode = code.trim();
    if (!trimmedHost) {
      Alert.alert("Enter a server", "Please enter the server.");
      return;
    }
    if (!trimmedCode) {
      Alert.alert("Enter a code", "Please enter a turf code.");
      return;
    }
    setLoading(true);
    try {
      setHost(trimmedHost);
      const turf = await client.turfs.getByCode({ code: trimmedCode });
      if (!turf) {
        Alert.alert("Not found", `No turf found for code "${trimmedCode}".`);
        setLoading(false);
        return;
      }
      setActiveTurf({ host: trimmedHost, turfId: turf.turfId });
      setLoading(false);
      if (!createdByName) {
        promptForName(turf.turfId);
        return;
      }
      goToTurf(turf.turfId);
    } catch (err) {
      Alert.alert("Error", String(err));
      setLoading(false);
    }
  };

  return (
    <Pressable className="flex-1 bg-background dark:bg-background-dark" onPress={Keyboard.dismiss}>
      <View className="flex-1 items-center justify-center p-6">
        <Text
          className="mb-2 text-5xl transform -skew-x-12 text-foreground dark:text-foreground-dark"
          style={{ fontFamily: "Geist_700Bold" }}
        >
          Field Tools
        </Text>
        <Text
          className="mt-6 mb-4 text-center text-xl text-muted-foreground dark:text-muted-foreground-dark"
          style={{ fontFamily: "Geist_400Regular" }}
        >
          Enter a server and code to start
        </Text>

        <View className="gap-3 w-full max-w-xs">
          <TextInput
            value={host}
            onChangeText={setHostInput}
            placeholder="Server domain"
            placeholderTextColor="#999"
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            returnKeyType="next"
            onSubmitEditing={() => codeRef.current?.focus()}
            style={{ lineHeight: 20 }}
            className="font-sans text-xl text-foreground dark:text-foreground-dark bg-surface dark:bg-surface-dark border border-border dark:border-border-dark rounded-lg px-4 text-center h-14"
          />
          <TextInput
            ref={codeRef}
            value={code}
            onChangeText={setCode}
            placeholder="Turf code"
            placeholderTextColor="#999"
            keyboardType="number-pad"
            style={{ lineHeight: 20 }}
            className="font-sans text-xl text-foreground dark:text-foreground-dark bg-surface dark:bg-surface-dark border border-border dark:border-border-dark rounded-lg px-4 text-center h-14"
          />
          <Button title={loading ? "Loading..." : "Open"} onPress={handleSubmit} />
        </View>
      </View>
    </Pressable>
  );
}
