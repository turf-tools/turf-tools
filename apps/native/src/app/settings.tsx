import { Link } from "expo-router";
import { useAtom } from "jotai";
import { Text, View } from "react-native";
import { Button } from "@/components/button";
import { themeAtom } from "@/lib/atoms/theme";

// Placeholder for the Settings screen (Slice F will replace this with the
// proper layout from the mocks: name/org/campaign/role + dark mode + log out
// + Distribute link).
export default function SettingsScreen() {
  const [theme, setTheme] = useAtom(themeAtom);

  return (
    <View className="flex-1 items-center justify-center bg-background dark:bg-background-dark p-6">
      <Text
        className="mb-12 text-2xl text-foreground dark:text-foreground-dark"
        style={{ fontFamily: "Geist_700Bold" }}
      >
        Settings
      </Text>

      <View className="gap-3 w-full max-w-xs">
        <Button
          title={theme === "dark" ? "Switch to light" : "Switch to dark"}
          onPress={() => setTheme(theme === "dark" ? "light" : "dark")}
          variant="outline"
        />
        <Link href="/distribute" asChild>
          <Button title="Distribute" variant="outline" />
        </Link>
      </View>
    </View>
  );
}
