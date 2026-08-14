import { router } from "expo-router";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { X } from "lucide-react-native";
import { useState } from "react";
import { Alert, Keyboard, Platform, Pressable, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Button } from "@/components/button";
import { Input } from "@/components/input";
import { activeTurfAtom } from "@/lib/atoms/active-turf";
import { canvasserAtom } from "@/lib/atoms/canvasser";
import { pendingOpenAtom } from "@/lib/atoms/scan";
import { themeAtom } from "@/lib/atoms/theme";
import { showBindError } from "@/lib/bind-error";
import { openTurf } from "@/lib/canvass-events";
import { client } from "@/rpc/client";

// The canvasser identity sheet — a sign-in sheet, not an account. Raised
// by the landing screen before
// a first open binds (attribution is a precondition of binding: saving
// completes the parked open; dismissing is a no-op — nothing was bound) and
// from Settings to edit. The future Verify button lives here, next to the
// phone field.
export default function CanvasserScreen() {
  const insets = useSafeAreaInsets();
  const isDark = useAtomValue(themeAtom) === "dark";
  const [canvasser, setCanvasser] = useAtom(canvasserAtom);
  const [pendingOpen, setPendingOpen] = useAtom(pendingOpenAtom);
  const setActiveTurf = useSetAtom(activeTurfAtom);
  const [saving, setSaving] = useState(false);

  const [name, setName] = useState(canvasser?.name ?? "");
  const [phone, setPhone] = useState(canvasser?.phone ?? "");

  // Permissive input, strict save: stripping keystrokes flickers (iOS paints
  // the char before the controlled re-render removes it), so anything may be
  // typed — Save just stays disabled unless the value is a reachable number
  // (formatting punctuation welcome, no letters). Reachable means US-shaped —
  // 10 digits, or 11 with the leading 1 — unless it starts with "+", the
  // international escape hatch (8–15 digits per E.164, trusted). On save the
  // number is normalized to E.164 with +1 assumed for domestic entries
  // (libphonenumber's canonical form; deployments are US for now): the
  // stored phone is a join key for verification and reporting, so
  // `(555) 123-4567`, `1-555-123-4567`, and `+1 555 123 4567` must all land
  // as `+15551234567`. Per-country validation is deliberately out of scope
  // until verification brings libphonenumber along.
  const trimmedPhone = phone.trim();
  const digits = phone.replace(/\D/g, "");
  const phoneShaped =
    /^[0-9+\-() .]+$/.test(trimmedPhone) &&
    (trimmedPhone.startsWith("+")
      ? digits.length >= 8 && digits.length <= 15
      : digits.length === 10 || (digits.length === 11 && digits.startsWith("1")));
  const valid = name.trim().length > 0 && phoneShaped;
  const save = async () => {
    if (!valid || saving) return;
    const normalized = trimmedPhone.startsWith("+")
      ? `+${digits}`
      : digits.length === 11
        ? `+${digits}`
        : `+1${digits}`;
    const next = { name: name.trim(), phone: normalized };
    setCanvasser(next);
    // Settings edit — no bind in flight, just dismiss.
    if (!pendingOpen) {
      router.back();
      return;
    }
    // First-open path: complete the parked bind here and go straight to
    // the turf, so the landing never flashes back into view. The walk is
    // a hard precondition of binding — on failure nothing binds and the
    // sheet stays up for a retry.
    setSaving(true);
    try {
      await client.walks.open({
        turfId: pendingOpen.turfId,
        canvasserName: next.name,
        canvasserPhone: next.phone,
      });
      setActiveTurf(pendingOpen);
      setPendingOpen(null);
      void openTurf(pendingOpen.turfId).catch(() => {
        Alert.alert(
          "Couldn't refresh from server",
          "Showing the most recently synced version but data may be out of date, sync when you have a connection.",
        );
      });
      router.replace(`/turfs/${pendingOpen.turfId}`);
    } catch (err) {
      showBindError(err);
      setSaving(false);
    }
  };

  // The X and the content column share this anchor so the title sits a
  // fixed distance below the close button on every device. iOS's deep top
  // inset lets the control tuck beside the notch; Android's slim status
  // bar needs it pushed below.
  const closeTop = Platform.OS === "android" ? insets.top + 12 : Math.max(insets.top - 41, 12);

  return (
    <Pressable className="flex-1 bg-background dark:bg-background-dark" onPress={Keyboard.dismiss}>
      {/* X close button (matches Settings) */}
      <Pressable
        onPress={() => router.back()}
        hitSlop={4}
        className="absolute z-10 items-center justify-center w-12 h-12 rounded-full bg-surface dark:bg-surface-dark active:opacity-60"
        style={{
          top: closeTop,
          right: 22,
          shadowColor: "#000",
          shadowOffset: { width: 0, height: 2 },
          shadowOpacity: 0.15,
          shadowRadius: 6,
          elevation: 4,
        }}
      >
        <X size={20} color={isDark ? "#ededed" : "#1b1b1b"} strokeWidth={2} />
      </Pressable>

      {/* Top-anchored (not centered): the content block must live in the
          upper third so the keypad can never cover the Save button. */}
      <View
        className="flex-1 items-center px-6"
        style={{ paddingTop: closeTop + 48 }} // start below the 48px X row
      >
        <Text
          className="mt-20 mb-2 self-center text-4xl transform -skew-x-12 text-foreground dark:text-foreground-dark"
          style={{
            fontFamily: Platform.OS === "android" ? "Geist_700Bold_Italic" : "Geist_700Bold",
          }}
        >
          User info
        </Text>
        <Text
          className="px-4 mb-6 mt-6 text-center text-xl leading-6 text-muted-foreground dark:text-muted-foreground-dark"
          style={{ fontFamily: "Geist_400Regular" }}
        >
          Your contact information helps organizers know who did the canvassing, and allows them to
          contact you if necessary.
        </Text>

        <View className="gap-3 w-full max-w-xs">
          <Input
            value={name}
            onChangeText={setName}
            placeholder="Name"
            autoCapitalize="words"
            autoCorrect={false}
            returnKeyType="next"
          />
          {/* Verify (contact ownership) will sit alongside this field. */}
          <Input
            value={phone}
            onChangeText={setPhone}
            placeholder="Phone number"
            keyboardType="phone-pad"
            // Suppresses autofill/paste prompts. Not an Input default: an
            // empty content type also disables keyboard smarts like
            // auto-capitalization, which the name field needs.
            textContentType="none"
            style={{ fontVariant: ["tabular-nums"] }}
          />
          <Button title={saving ? "Loading..." : "Save"} onPress={save} disabled={!valid} />
        </View>
      </View>
    </Pressable>
  );
}
