module.exports = {
  preset: 'react-native',
  setupFilesAfterEnv: ['<rootDir>/jest.setup.js'],
  transformIgnorePatterns: [
    'node_modules/(?!((jest-)?react-native|@react-native|react-native-linear-gradient|react-native-reanimated|react-native-gesture-handler|react-native-safe-area-context)/)',
  ],
};
