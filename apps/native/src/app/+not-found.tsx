import { Link, Stack } from "expo-router";
import { Text, View } from "react-native";

export default function NotFoundScreen() {
  return (
    <>
      <Stack.Screen options={{ title: "Oops!" }} />
      <View className="flex-1 items-center justify-center bg-slate-50 p-6">
        <Text className="mb-4 text-xl font-bold text-slate-800">This screen doesn't exist</Text>
        <Link href="/">
          <Text className="text-blue-600 underline">Go to home screen</Text>
        </Link>
      </View>
    </>
  );
}
