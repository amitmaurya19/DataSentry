jest.mock('react-native-linear-gradient', () => 'LinearGradient');

jest.mock('react-native-reanimated', () => {
  const React = require('react');
  const { View } = require('react-native');

  const Animated = React.forwardRef((props, ref) => React.createElement(View, { ...props, ref }, props.children));
  Animated.View = Animated;

  const passthrough = value => value;
  const passthroughStyle = callback => callback();

  return {
    __esModule: true,
    default: Animated,
    Easing: {
      linear: jest.fn(),
      quad: jest.fn(),
      cubic: jest.fn(),
      out: jest.fn(fn => fn),
    },
    cancelAnimation: jest.fn(),
    interpolate: jest.fn((value, inputRange, outputRange) => {
      if (!Array.isArray(outputRange) || outputRange.length === 0) return value;
      return outputRange[outputRange.length - 1];
    }),
    interpolateColor: jest.fn((value, inputRange, outputRange) => {
      if (!Array.isArray(outputRange) || outputRange.length === 0) return '#000000';
      return outputRange[outputRange.length - 1];
    }),
    useAnimatedStyle: jest.fn(passthroughStyle),
    useSharedValue: jest.fn(value => ({ value })),
    withRepeat: jest.fn(passthrough),
    withSequence: jest.fn((...values) => values[values.length - 1]),
    withTiming: jest.fn(passthrough),
  };
});

jest.mock('react-native-gesture-handler', () => {
  const { View } = require('react-native');
  return {
    GestureHandlerRootView: View,
  };
});

jest.mock('react-native-safe-area-context', () => {
  const { View } = require('react-native');
  return {
    SafeAreaProvider: View,
    useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
  };
});

const { NativeModules } = require('react-native');
NativeModules.VpnModule = {
  startVpn: jest.fn(() => Promise.resolve(true)),
  stopVpn: jest.fn(() => Promise.resolve(true)),
  playTick: jest.fn(),
  addListener: jest.fn(),
  removeListeners: jest.fn(),
};
