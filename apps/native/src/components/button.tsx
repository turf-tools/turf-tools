import type { ReactNode } from "react";
import { Pressable, Text, View } from "react-native";

type ButtonProps = {
  title: string;
  variant?: "primary" | "outline";
  icon?: ReactNode;
  onPress?: () => void;
  disabled?: boolean;
};

export function Button({ title, variant = "primary", icon, onPress, disabled }: ButtonProps) {
  const isPrimary = variant === "primary";

  return (
    <Pressable
      onPress={disabled ? undefined : onPress}
      disabled={disabled}
      className={`h-14 rounded-lg px-6 ${disabled ? "opacity-50" : ""} ${
        isPrimary
          ? "bg-primary dark:bg-primary-dark active:bg-foreground dark:active:bg-foreground-dark"
          : "border border-border bg-surface dark:border-border-dark dark:bg-surface-dark active:bg-faded dark:active:bg-faded-dark"
      }`}
    >
      <View className="flex-1 flex-row items-center justify-center gap-3">
        {icon}
        <Text
          numberOfLines={1}
          ellipsizeMode="tail"
          className={`shrink text-center text-lg ${
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
