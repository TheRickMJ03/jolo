import { useEffect } from "react";
import { StyleSheet } from "react-native";
import { Stack } from "expo-router";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import * as SplashScreen from "expo-splash-screen";
import {
  useFonts,
  Montserrat_600SemiBold,
  Montserrat_700Bold,
  Montserrat_900Black,
} from "@expo-google-fonts/montserrat";
import {
  PlusJakartaSans_400Regular,
  PlusJakartaSans_500Medium,
  PlusJakartaSans_600SemiBold,
} from "@expo-google-fonts/plus-jakarta-sans";
import { Button } from "@/components/Button";
import { EmptyState } from "@/components/EmptyState";
import { Palette } from "@/constants/Colors";
import { useOwnerCafe } from "@/hooks/useOwnerCafe";
import { AuthProvider, useAuth } from "@/lib/auth";
import { destinationForCafe } from "@/lib/home";

SplashScreen.preventAutoHideAsync();

export default function RootLayout() {
  const [fontsLoaded] = useFonts({
    Montserrat_600SemiBold,
    Montserrat_700Bold,
    Montserrat_900Black,
    PlusJakartaSans_400Regular,
    PlusJakartaSans_500Medium,
    PlusJakartaSans_600SemiBold,
  });

  if (!fontsLoaded) return null;

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <AuthProvider>
          <RootNavigator />
        </AuthProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}

function RootNavigator() {
  const { user, initializing, signOut } = useAuth();
  const lookup = useOwnerCafe(user);
  // A signed-out session has nothing to look up. An owner is "ready".
  const cafeStatus = user ? lookup.status : "signed-out";

  useEffect(() => {
    // Hold the splash screen until we know which tabs to open, so a customer
    // never sees the owner dashboard flash (and the reverse).
    if (initializing || cafeStatus === "loading") return;
    SplashScreen.hideAsync();
  }, [initializing, cafeStatus]);

  if (initializing || cafeStatus === "loading") return null;

  if (cafeStatus === "error") {
    return (
      <SafeAreaView style={styles.root}>
        <EmptyState
          icon="cloud-offline-outline"
          title="Couldn't load your account"
          action={<Button label="Sign out" variant="outline" onPress={signOut} />}
        >
          Check your connection and try again.
        </EmptyState>
      </SafeAreaView>
    );
  }

  const destination = destinationForCafe(cafeStatus);

  return (
    <Stack screenOptions={{ contentStyle: { backgroundColor: Palette.background } }}>
      {/* Each group is unreachable in the wrong state, even by deep link. */}
      <Stack.Protected guard={!user}>
        <Stack.Screen name="(login)" options={{ headerShown: false }} />
      </Stack.Protected>
      <Stack.Protected guard={destination === "owner"}>
        <Stack.Screen name="owner" options={{ headerShown: false }} />
      </Stack.Protected>
      <Stack.Protected guard={destination === "user"}>
        <Stack.Screen name="user" options={{ headerShown: false }} />
      </Stack.Protected>
      <Stack.Screen name="+not-found" />
    </Stack>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: Palette.background, justifyContent: "center" },
});
