import { Text } from "react-native";

// Stand-in for blank script copy, worded like the web script preview. Nests
// inside a parent Text to inherit its size.
export function Placeholder({ children }: { children: string }) {
  return (
    <Text
      className="text-muted-foreground dark:text-muted-foreground-dark"
      style={{ fontFamily: "Geist_400Regular_Italic" }}
    >
      {children}
    </Text>
  );
}
