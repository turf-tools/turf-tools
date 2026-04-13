import { useAtomValue } from "jotai";
import { Text, View } from "react-native";
import { TopNav } from "@/components/top-nav";
import { themeAtom } from "@/lib/atoms/theme";

export default function DistributeScreen() {
  const theme = useAtomValue(themeAtom);
  const isDark = theme === "dark";

  return (
    <View className="flex-1 bg-background dark:bg-background-dark">
      <TopNav title="Distribute" showBack={true} isDark={isDark} />
      <View className="flex-1 items-center justify-center p-6">
        <Text
          className="text-center text-xl text-muted-foreground dark:text-muted-foreground-dark"
          style={{ fontFamily: "Geist_400Regular" }}
        >
          Coming soon
        </Text>
      </View>
    </View>
  );
}
