import { Alert } from "react-native";

// RN's fetch surfaces offline / unreachable-host failures as
// `TypeError: Network request failed`. Translate to a human-readable
// alert; pass other errors through as best-effort text. Shared by the
// two bind paths (landing Open, identity-sheet Save).
export function showBindError(err: unknown) {
  const message = String(err);
  if (message.includes("Network request failed")) {
    Alert.alert(
      "Connection error",
      "Could not reach the server to open the turf, try again when you have a network connection.",
    );
  } else {
    Alert.alert("Error", message);
  }
}
