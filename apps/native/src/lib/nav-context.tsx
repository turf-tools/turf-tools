import { useFocusEffect } from "expo-router";
import { useAtomValue } from "jotai";
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
import { TopNav } from "@/components/top-nav";
import { themeAtom } from "@/lib/atoms/theme";

type ButtonAction = "search" | "list" | "next" | "mic";

type TopNavVariant = "default" | "minimal";

type TopNavConfig = {
  title: string;
  showBack: boolean;
  variant: TopNavVariant;
};

type BottomNavConfig = {
  buttons: Array<ButtonAction | null>;
  onPress: (action: ButtonAction) => void;
};

type ContextValue = {
  setTopConfig: (config: TopNavConfig | null) => void;
  setBottomConfig: (config: BottomNavConfig | null) => void;
};

const NavContext = createContext<ContextValue | null>(null);

export function NavProvider({ children }: { children: ReactNode }) {
  const [topConfig, setTopConfig] = useState<TopNavConfig | null>(null);
  const [bottomConfig, setBottomConfig] = useState<BottomNavConfig | null>(null);
  const theme = useAtomValue(themeAtom);
  const isDark = theme === "dark";

  const contextValue = useMemo<ContextValue>(() => ({ setTopConfig, setBottomConfig }), []);

  return (
    <NavContext.Provider value={contextValue}>
      <View className="flex-1">
        {topConfig && (
          <TopNav
            title={topConfig.title}
            showBack={topConfig.showBack}
            variant={topConfig.variant}
            isDark={isDark}
          />
        )}
        <View className="flex-1">{children}</View>
        {bottomConfig && (
          <BottomNav
            buttons={bottomConfig.buttons}
            onPress={bottomConfig.onPress}
            isDark={isDark}
          />
        )}
      </View>
    </NavContext.Provider>
  );
}

// Combined hook: register both top and bottom nav for the focused screen.
export function useScreenNav(options: {
  title: string;
  showBack?: boolean;
  topVariant?: TopNavVariant;
  bottomButtons: Array<ButtonAction | null>;
  onBottomPress: (action: ButtonAction) => void;
}) {
  const ctx = useContext(NavContext);
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const ctxRef = useRef(ctx);
  ctxRef.current = ctx;

  const buttonsKey = options.bottomButtons.join(",");
  const titleKey = options.title;
  const showBack = options.showBack ?? true;
  const variant = options.topVariant ?? "default";

  useFocusEffect(
    useCallback(() => {
      ctxRef.current?.setTopConfig({ title: titleKey, showBack, variant });
      ctxRef.current?.setBottomConfig({
        buttons: buttonsKey.split(",") as Array<ButtonAction>,
        onPress: (action) => optionsRef.current.onBottomPress(action),
      });
    }, [buttonsKey, titleKey, showBack, variant]),
  );
}
