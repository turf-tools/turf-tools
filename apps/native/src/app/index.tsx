import { useQuery } from "@tanstack/react-query";
import { Link } from "expo-router";
import { Pressable, Text, View } from "react-native";
import { client } from "@/rpc/client";

export default function HomeScreen() {
  const { data, isLoading } = useQuery({
    queryKey: ["healthcheck"],
    queryFn: () => client.healthcheck(),
  });

  return (
    <View className="flex-1 items-center justify-center bg-slate-50 p-6">
      <Text className="mb-2 text-3xl font-bold text-slate-800">Turf</Text>
      <Text className="mb-8 text-center text-lg text-slate-500">
        RPC status: {isLoading ? "loading..." : data?.status}
      </Text>

      <Link href="/map" asChild>
        <Pressable className="rounded-xl bg-blue-600 px-8 py-4">
          <Text className="text-lg font-semibold text-white">Open Map</Text>
        </Pressable>
      </Link>
    </View>
  );
}
