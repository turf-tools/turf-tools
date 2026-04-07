import { useQuery } from "@tanstack/react-query";
import { Link } from "expo-router";
import { MoonStar, Sun } from "lucide-react-native";
import { useColorScheme } from "nativewind";
import { Text, View } from "react-native";
import { Button } from "@/components/button";
import { client } from "@/rpc/client";

export default function HomeScreen() {
  const colorSchemeUtils = useColorScheme();
  const colorScheme = colorSchemeUtils.colorScheme;
  const { data, isLoading } = useQuery({
    queryKey: ["healthcheck"],
    queryFn: () => client.healthcheck(),
  });

  return (
    <View className="flex-1 items-center justify-center bg-background dark:bg-background-dark p-6">
      <Text
        className="mb-2 text-3xl text-foreground dark:text-foreground-dark"
        style={{ fontFamily: "Geist_700Bold", transform: [{ skewX: "-12deg" }] }}
      >
        Field Tools
      </Text>
      <Text
        className="mb-8 text-center text-lg text-muted-foreground dark:text-muted-foreground-dark"
        style={{ fontFamily: "Geist_400Regular" }}
      >
        RPC status: {isLoading ? "loading..." : data?.status}
      </Text>

      <View className="gap-3">
        <Link href="/map" asChild>
          <Button title="Open Map" />
        </Link>
        <Button title="Outline Button" variant="outline" />
        <Button
          title={colorScheme === "dark" ? "Light" : "Dark"}
          icon={
            colorScheme === "dark" ? (
              <Sun size={16} color="#ededed" />
            ) : (
              <MoonStar size={16} color="#1b1b1b" />
            )
          }
          variant="outline"
          onPress={() => colorSchemeUtils.toggleColorScheme()}
        />
      </View>
    </View>
  );
}
