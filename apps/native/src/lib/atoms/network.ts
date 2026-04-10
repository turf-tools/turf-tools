import NetInfo from "@react-native-community/netinfo";
import { atom } from "jotai";

// Reactive online/offline state. Subscribes to NetInfo on first mount and
// unsubscribes when no longer used. Read with `useAtomValue(isOnlineAtom)`.
const baseIsOnlineAtom = atom(true);
baseIsOnlineAtom.onMount = (set) => {
  const unsubscribe = NetInfo.addEventListener((state) => {
    set(state.isConnected ?? false);
  });
  return unsubscribe;
};

export const isOnlineAtom = baseIsOnlineAtom;
