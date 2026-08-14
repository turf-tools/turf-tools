import { router } from "expo-router";
import { useAtomValue } from "jotai";
import { X } from "lucide-react-native";
import { Platform, Pressable, Text, View } from "react-native";
import QRCode from "react-native-qrcode-svg";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useQuery } from "@tanstack/react-query";
import { activeTurfAtom } from "@/lib/atoms/active-turf";
import { themeAtom } from "@/lib/atoms/theme";
import { buildTurfQr } from "@/lib/turf-qr";
import { client } from "@/rpc/client";

// Share sheet — the active turf's QR, so a canvasser can hand the turf
// to another device by letting them scan straight off this screen. Same
// payload as the admin board's printable codes.
export default function ShareScreen() {
  const insets = useSafeAreaInsets();
  const isDark = useAtomValue(themeAtom) === "dark";
  const activeTurf = useAtomValue(activeTurfAtom);
  const { data: meta } = useQuery({
    queryKey: ["turf", activeTurf?.turfId] as const,
    queryFn: () => client.turfs.getById({ turfId: activeTurf!.turfId }),
    enabled: !!activeTurf,
    staleTime: Infinity,
  });
  const turfCode = meta?.turfCode ?? null;
  const shareUrl = activeTurf && turfCode ? buildTurfQr(activeTurf.host, turfCode) : null;

  // The X and the content column share this anchor so the title sits a
  // fixed distance below the close button on every device. iOS's deep top
  // inset lets the control tuck beside the notch; Android's slim status
  // bar needs it pushed below.
  const closeTop = Platform.OS === "android" ? insets.top + 12 : Math.max(insets.top - 41, 12);

  return (
    <View className="flex-1 bg-background dark:bg-background-dark">
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

      <View
        className="flex-1 items-center px-6"
        style={{ paddingTop: closeTop + 48 }} // start below the 48px X row
      >
        <Text
          className="mt-20 mb-2 self-center text-center text-4xl transform -skew-x-12 text-foreground dark:text-foreground-dark"
          style={{
            fontFamily: Platform.OS === "android" ? "Geist_700Bold_Italic" : "Geist_700Bold",
          }}
        >
          Share turf
        </Text>
        <Text
          className="px-4 mb-6 mt-6 text-center text-xl leading-6 text-muted-foreground dark:text-muted-foreground-dark"
          style={{ fontFamily: "Geist_400Regular" }}
        >
          Have another canvasser scan this
        </Text>

        {shareUrl ? (
          <>
            {/* Plate stays white in dark mode — inverted QR codes scan poorly. */}
            <View className="items-center rounded-2xl bg-white p-8">
              <QRCode value={shareUrl} size={220} />
            </View>
            <View className="mt-6 items-center gap-0.5">
              <Text
                className="text-xl text-muted-foreground dark:text-muted-foreground-dark"
                style={{ fontFamily: "Geist_400Regular" }}
              >
                Server: {activeTurf?.host}
              </Text>
              <Text
                className="text-xl text-muted-foreground dark:text-muted-foreground-dark"
                style={{ fontFamily: "Geist_400Regular", fontVariant: ["tabular-nums"] }}
              >
                Code: {turfCode}
              </Text>
            </View>
          </>
        ) : (
          <Text
            className="text-xl text-muted-foreground dark:text-muted-foreground-dark"
            style={{ fontFamily: "Geist_400Regular" }}
          >
            No active turf to share
          </Text>
        )}
      </View>
    </View>
  );
}
