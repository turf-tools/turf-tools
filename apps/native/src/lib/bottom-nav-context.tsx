import { useFocusEffect } from "expo-router";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
} from "react";
import { View } from "react-native";
import { BottomNav } from "@/components/bottom-nav";

type ButtonAction = "search" | "list" | "next" | "mic";

type BottomNavConfig = {
  buttons: Array<ButtonAction | null>;
  onPress: (action: ButtonAction) => void;
};

type ContextValue = {
  setConfig: (config: BottomNavConfig | null) => void;
};

const BottomNavContext = createContext<ContextValue | null>(null);

export function BottomNavProvider({ children }: { children: ReactNode }) {
  const [config, setConfig] = useState<BottomNavConfig | null>(null);
  const contextValue = useMemo<ContextValue>(() => ({ setConfig }), []);

  return (
    <BottomNavContext.Provider value={contextValue}>
      <View className="flex-1">
        {children}
        {config && <BottomNav buttons={config.buttons} onPress={config.onPress} />}
      </View>
    </BottomNavContext.Provider>
  );
}

export function useBottomNav(
  buttons: Array<ButtonAction | null> | null,
  onPress?: (action: ButtonAction) => void,
) {
  const ctx = useContext(BottomNavContext);
  const onPressRef = useRef(onPress);
  onPressRef.current = onPress;
  const ctxRef = useRef(ctx);
  ctxRef.current = ctx;

  const buttonsKey = buttons === null ? "null" : buttons.join(",");

  useFocusEffect(
    useCallback(() => {
      if (buttonsKey === "null") {
        ctxRef.current?.setConfig(null);
      } else {
        ctxRef.current?.setConfig({
          buttons: buttonsKey.split(",") as Array<ButtonAction>,
          onPress: (action) => onPressRef.current?.(action),
        });
      }
    }, [buttonsKey]),
  );
}
