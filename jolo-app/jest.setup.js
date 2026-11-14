// Screens use SafeAreaView; the library ships a mock that needs no provider.
jest.mock(
  "react-native-safe-area-context",
  () => require("react-native-safe-area-context/jest/mock").default,
);
