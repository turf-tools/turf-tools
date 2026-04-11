import { useAtomValue } from "jotai";
import { Check } from "lucide-react-native";
import { type ReactNode } from "react";
import { Pressable, Text, View } from "react-native";
import { themeAtom } from "@/lib/atoms/theme";

type Props = {
  label: string;
  icon?: ReactNode;
  selected?: boolean;
  onPress: () => void;
  // "action" variant is for Cancel — no icon slot, no selection state
  // "submit" variant is like action but with dark background
  variant?: "default" | "action" | "submit";
  className?: string;
};

// Full-width button used for survey responses, unavailable outcomes, and
// action buttons (Cancel, Submit) on the Person screen. White background
// with a subtle shadow ring, border, and a check icon on the selected item.
export function WideButton({
  label,
  icon,
  selected = false,
  onPress,
  variant = "default",
  className = "",
}: Props) {
  const isAction = variant === "action" || variant === "submit";
  const isDark = useAtomValue(themeAtom) === "dark";

  return (
    <Pressable
      onPress={onPress}
      className={`flex-row items-center justify-between px-4 py-3.5 rounded-lg border ${
        variant === "submit"
          ? "bg-foreground dark:bg-foreground-dark border-foreground dark:border-foreground-dark"
          : selected
            ? "bg-surface dark:bg-surface-dark border-foreground dark:border-foreground-dark"
            : "bg-surface dark:bg-surface-dark border-border dark:border-border-dark"
      } ${className}`}
      style={{
        shadowColor: "#000",
        shadowOffset: { width: 0, height: 0 },
        shadowOpacity: 0.08,
        shadowRadius: 3,
      }}
    >
      <Text
        className={`font-sans text-lg ${
          variant === "submit"
            ? "text-background dark:text-background-dark"
            : "text-foreground dark:text-foreground-dark"
        }`}
      >
        {label}
      </Text>
      {!isAction && (
        <View className="w-6 items-center">
          {icon ? (
            <View>{icon}</View>
          ) : selected ? (
            <Check size={18} color={isDark ? "#ededed" : "#1b1b1b"} strokeWidth={2.5} />
          ) : null}
        </View>
      )}
    </Pressable>
  );
}
