import type { ReactNode } from "react";
import { Pressable, Text, View } from "react-native";

type ButtonProps = {
  title: string;
  variant?: "primary" | "outline";
  icon?: ReactNode;
  onPress?: () => void;
};

export function Button({ title, variant = "primary", icon, onPress }: ButtonProps) {
  const isPrimary = variant === "primary";

  return (
    <Pressable
      onPress={onPress}
      className={`rounded-lg px-6 py-3 ${
        isPrimary
          ? "bg-primary dark:bg-primary-dark"
          : "border border-border bg-surface dark:border-border-dark dark:bg-surface-dark"
      }`}
      style={({ pressed }) => ({ opacity: pressed ? 0.7 : 1 })}
    >
      <View className="flex-row items-center justify-center gap-3">
        {icon}
        <Text
          className={`text-center text-lg ${
            isPrimary
              ? "text-primary-foreground dark:text-primary-foreground-dark"
              : "text-foreground dark:text-foreground-dark"
          }`}
          style={{ fontFamily: "Geist_700Bold" }}
        >
          {title}
        </Text>
      </View>
    </Pressable>
  );
}
