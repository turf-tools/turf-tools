import { useNavigation } from "expo-router";
import { useEffect, useRef } from "react";

// A turf screen's back stack must be its hierarchy — map → building →
// person — no matter how it was reached (tap-through, Next teleport,
// replace, deep link). Screens navigate with plain push/replace and each
// destination aligns the history beneath itself after its entrance
// transition ends: a RESET that keeps the top route object is applied by
// react-native-screens with no visual change, while one that changes the
// top briefly shows the screen below it mid-animation
// (react-navigation#10440) — so alignment never drives the transition.
//
// Dispatches plain RESET action objects (what CommonActions.reset
// returns) — the @react-navigation packages aren't direct dependencies.

type RouteLike = { key?: string; name: string; params?: object };

// Call from a turf screen with the routes that belong beneath it: the map
// is implied; a person screen passes its buildingId, a building screen
// passes nothing.
export function useAlignedTurfStack(turfId: string, buildingId?: string) {
  const navigation = useNavigation();
  // The rewrite must wait for the entrance transition to settle — resets
  // mid-animation change the visible screen below the moving one.
  const settled = useRef(false);

  useEffect(() => {
    const align = () => {
      if (!navigation.isFocused()) return;
      const state = navigation.getState();
      const top = state?.routes[state.index];
      if (!state || !top) return;
      const below = state.routes.slice(0, state.index);
      const desired: RouteLike[] = [
        state.routes.find((r) => r.name === "index") ?? { name: "index" },
      ];
      if (buildingId) {
        desired.push(
          below.find(
            (r) =>
              r.name === "buildings/[buildingId]" &&
              (r.params as { buildingId?: string } | undefined)?.buildingId === buildingId,
          ) ?? { name: "buildings/[buildingId]", params: { turfId, buildingId } },
        );
      }
      const aligned =
        below.length === desired.length && desired.every((route, i) => route === below[i]);
      if (aligned) return;
      navigation.dispatch({
        type: "RESET",
        payload: { index: desired.length, routes: [...desired, top] },
      });
    };

    // Re-running because buildingId arrived late (turf data loaded after
    // the transition) must still align.
    if (settled.current) align();
    const listen = navigation.addListener as unknown as (
      type: "transitionEnd",
      callback: (e: { data: { closing: boolean } }) => void,
    ) => () => void;
    return listen("transitionEnd", (e) => {
      if (e.data.closing) return;
      settled.current = true;
      align();
    });
  }, [navigation, turfId, buildingId]);
}
