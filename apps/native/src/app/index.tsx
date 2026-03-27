import { Link } from "expo-router";
import { Pressable, Text, View } from "react-native";

export default function HomeScreen() {
  return (
    <View className="flex-1 items-center justify-center bg-slate-50 p-6">
      <Text className="mb-2 text-3xl font-bold text-slate-800">Turf</Text>
      <Text className="mb-8 text-center text-lg text-slate-500">Canvassing made simple</Text>

      <Link href="/map" asChild>
        <Pressable className="rounded-xl bg-blue-600 px-8 py-4">
          <Text className="text-lg font-semibold text-white">Open Map</Text>
        </Pressable>
      </Link>
    </View>
  );
}
