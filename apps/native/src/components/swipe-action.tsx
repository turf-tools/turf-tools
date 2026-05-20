import { type ReactNode } from "react";
import { Pressable, useWindowDimensions, type ViewStyle } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, {
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
} from "react-native-reanimated";

type Props = {
  children: ReactNode;
  actionWidth?: number;
  fullSwipeThreshold?: number;
  onTap: () => void;
  onFullSwipe?: () => void;
  actionContent: ReactNode;
  actionClassName?: string;
  // Inline style for the action container.
  actionStyle?: ViewStyle;
  hitSlopLeft?: number;
};

const SPRING_OPEN = { damping: 30, stiffness: 400, overshootClamping: true };
const SPRING_CLOSE = { damping: 30, stiffness: 400, overshootClamping: true };

// Angle threshold: tan(25deg) ≈ 0.47. If abs(dy/dx) > this, the swipe
// is too diagonal/vertical and we let the ScrollView handle it.
const MAX_ANGLE_RATIO = 0.47;
// Minimum distance before we decide whether to activate or fail.
const MIN_DECISION_DISTANCE = 10;

export function SwipeAction({
  children,
  actionWidth = 80,
  fullSwipeThreshold,
  onTap,
  onFullSwipe,
  actionContent,
  actionClassName = "",
  actionStyle,
  hitSlopLeft = 40,
}: Props) {
  const { width: screenWidth } = useWindowDimensions();
  const threshold = fullSwipeThreshold ?? screenWidth * 0.5;

  const translateX = useSharedValue(0);
  const startX = useSharedValue(0);
  const isOpen = useSharedValue(false);
  const fullSwipeFired = useSharedValue(false);
  const touchStartX = useSharedValue(0);
  const touchStartY = useSharedValue(0);

  const handleFullSwipe = () => {
    onFullSwipe?.();
  };

  const handleTap = () => {
    onTap();
  };

  const pan = Gesture.Pan()
    .manualActivation(true)
    .onTouchesDown((e) => {
      "worklet";
      if (e.changedTouches.length > 0) {
        touchStartX.value = e.changedTouches[0].absoluteX;
        touchStartY.value = e.changedTouches[0].absoluteY;
      }
    })
    .onTouchesMove((e, stateManager) => {
      "worklet";
      if (e.changedTouches.length === 0) return;
      const dx = e.changedTouches[0].absoluteX - touchStartX.value;
      const dy = e.changedTouches[0].absoluteY - touchStartY.value;
      const distance = Math.sqrt(dx * dx + dy * dy);

      if (distance < MIN_DECISION_DISTANCE) return;

      // Check if touch started too close to the left edge (reserved for back gesture).
      if (e.changedTouches[0].absoluteX - dx < hitSlopLeft) {
        stateManager.fail();
        return;
      }

      const absX = Math.abs(dx);
      const absY = Math.abs(dy);

      if (absX === 0 || absY / absX > MAX_ANGLE_RATIO) {
        // Too vertical — fail and let ScrollView handle it.
        stateManager.fail();
      } else {
        // Predominantly horizontal — activate.
        stateManager.activate();
      }
    })
    .onStart(() => {
      "worklet";
      startX.value = translateX.value;
      fullSwipeFired.value = false;
    })
    .onUpdate((e) => {
      "worklet";
      const next = startX.value + e.translationX;
      translateX.value = Math.max(0, next);

      if (onFullSwipe && translateX.value > threshold && !fullSwipeFired.value) {
        fullSwipeFired.value = true;
        runOnJS(handleFullSwipe)();
      }
    })
    .onEnd((e) => {
      "worklet";
      if (fullSwipeFired.value) {
        translateX.value = withSpring(0, SPRING_CLOSE);
        isOpen.value = false;
        return;
      }

      const projectedX = translateX.value + e.velocityX * 0.05;

      if (isOpen.value) {
        if (projectedX < actionWidth * 0.5) {
          translateX.value = withSpring(0, SPRING_CLOSE);
          isOpen.value = false;
        } else {
          translateX.value = withSpring(actionWidth, SPRING_OPEN);
        }
      } else {
        if (projectedX > actionWidth * 0.5) {
          translateX.value = withSpring(actionWidth, SPRING_OPEN);
          isOpen.value = true;
        } else {
          translateX.value = withSpring(0, SPRING_CLOSE);
        }
      }
    });

  const tap = Gesture.Tap().onEnd(() => {
    "worklet";
    if (isOpen.value) {
      translateX.value = withSpring(0, SPRING_CLOSE);
      isOpen.value = false;
    }
  });

  const rowStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: translateX.value }],
  }));

  const actionAnimatedStyle = useAnimatedStyle(() => ({
    width: translateX.value,
  }));

  return (
    <GestureDetector gesture={pan}>
      <Animated.View className="overflow-hidden">
        {/* Action button — positioned behind the row */}
        <Animated.View
          className={`absolute left-0 top-0 bottom-0 ${actionClassName}`}
          style={[actionAnimatedStyle, actionStyle]}
        >
          <Pressable
            onPress={() => {
              handleTap();
              translateX.value = withSpring(0, SPRING_CLOSE);
              isOpen.value = false;
            }}
            className="h-full justify-center items-center"
            style={{ width: actionWidth }}
          >
            {actionContent}
          </Pressable>
        </Animated.View>

        {/* Row content — slides right */}
        <GestureDetector gesture={tap}>
          <Animated.View style={rowStyle}>{children}</Animated.View>
        </GestureDetector>
      </Animated.View>
    </GestureDetector>
  );
}
