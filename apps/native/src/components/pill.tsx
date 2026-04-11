import { type ReactNode } from "react";
import { Text, View } from "react-native";

type Variant = "default" | "primary";

type Props = {
  children?: ReactNode;
  variant?: Variant;
  icon?: ReactNode;
};

// Small label pill for compact metadata badges (age + gender, party, counts
// with icons, status indicators, etc.). Primary variant is the "recorded"
// check badge — light blue background, dark blue icon, no border.
export function Pill({ children, variant = "default", icon }: Props) {
  const bgClass =
    variant === "primary" ? "bg-blue-light dark:bg-blue-light-dark" : "bg-badge dark:bg-badge-dark";
  const textClass =
    variant === "primary"
      ? "font-sans text-lg text-blue-dark dark:text-blue-dark-dark"
      : "font-sans text-lg text-foreground dark:text-foreground-dark";

  return (
    <View
      className={`flex-row items-center px-2 py-0.5 rounded-md min-w-[32px] min-h-[28px] justify-center gap-1.5 ${bgClass}`}
    >
      {icon}
      {children != null && (
        <Text style={{ fontVariant: ["tabular-nums"] }} className={textClass}>
          {children}
        </Text>
      )}
    </View>
  );
}
