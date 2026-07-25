import type { Ref } from "react";
import { TextInput, type TextInputProps } from "react-native";

// The app's single-line text field (centered text, Geist, surface chrome).
// Uses the NATIVE placeholder deliberately: an owned <Text> overlay renders
// the hint pixel-perfectly but strands the caret at the field's center
// (empty centered inputs put the caret mid-field; only UIKit's placeholder
// path pins it to the hint's leading edge). The native path costs a ~1px
// baseline shift on the hint with custom fonts — the caret wins.
type Props = TextInputProps & { ref?: Ref<TextInput> };

export function Input({ style, ...props }: Props) {
  return (
    <TextInput
      placeholderTextColor="#999"
      // fontSize inline, not `text-xl`: the class adds lineHeight, which iOS
      // applies to typed text but not the placeholder — a 1px baseline
      // shift. 17.5 = text-xl under NativeWind's 14px rem.
      style={[{ fontSize: 17.5, paddingTop: 11, paddingBottom: 13 }, style]}
      className="font-sans text-foreground dark:text-foreground-dark bg-surface dark:bg-surface-dark border border-border dark:border-border-dark rounded-lg px-4 text-center h-14"
      {...props}
    />
  );
}
