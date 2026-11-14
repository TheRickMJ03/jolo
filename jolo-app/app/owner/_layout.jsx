import { ActivityIndicator, StyleSheet, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Tabs } from "expo-router";
import { Button } from "@/components/Button";
import { EmptyState } from "@/components/EmptyState";
import { TabBarIcon } from "@/components/navigation/TabBarIcon";
import { Palette } from "@/constants/Colors";
import { Typography } from "@/constants/Typography";
import { useOwnerCafe } from "@/hooks/useOwnerCafe";
import { useAuth } from "@/lib/auth";
import { OwnerCafeProvider } from "@/lib/owner-context";
import { formatPhone } from "@/lib/phone";

export default function OwnerLayout() {
  const { user, signOut } = useAuth();
  const { status, cafe } = useOwnerCafe(user);

  if (status === "loading") {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={Palette.primary} accessibilityLabel="Finding your café" />
      </View>
    );
  }

  if (status !== "ready") {
    const signOutButton = <Button label="Sign out" variant="outline" onPress={signOut} />;
    return (
      <SafeAreaView style={styles.root}>
        {status === "no-phone" ? (
          <EmptyState
            icon="phone-portrait-outline"
            title="Sign in with your café's phone"
            action={signOutButton}
          >
            You're signed in with email. The owner dashboard is matched to your café by phone
            number, so sign out and continue with the phone number your café uses.
          </EmptyState>
        ) : status === "not-linked" ? (
          <EmptyState icon="link-outline" title="No café linked yet" action={signOutButton}>
            We couldn't find a café linked to {formatPhone(user?.phoneNumber)}. Ask the JOLO team to
            link it, and this screen updates as soon as they do.
          </EmptyState>
        ) : (
          <EmptyState
            icon="cloud-offline-outline"
            title="Couldn't load your café"
            action={signOutButton}
          >
            Check your connection and try again.
          </EmptyState>
        )}
      </SafeAreaView>
    );
  }

  return (
    <OwnerCafeProvider value={cafe}>
      <Tabs
        screenOptions={{
          headerShown: false,
          tabBarActiveTintColor: Palette.primary,
          tabBarInactiveTintColor: Palette.onSurfaceVariant,
          tabBarLabelStyle: { fontFamily: Typography.labelMd.fontFamily, fontSize: 11 },
          tabBarStyle: {
            backgroundColor: Palette.background,
            borderTopColor: Palette.outlineVariant,
            height: 80,
            paddingTop: 8,
          },
        }}
      >
        <Tabs.Screen name="index" options={tab("Menu", "restaurant")} />
        <Tabs.Screen name="history" options={tab("History", "time")} />
        <Tabs.Screen name="insights" options={tab("Insights", "stats-chart")} />
        <Tabs.Screen name="account" options={tab("Account", "person")} />
      </Tabs>
    </OwnerCafeProvider>
  );
}

function tab(title, icon) {
  return {
    title,
    tabBarIcon: ({ color, focused }) => (
      <TabBarIcon name={focused ? icon : `${icon}-outline`} color={color} focused={focused} />
    ),
  };
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: Palette.background, justifyContent: "center" },
  center: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: Palette.background,
  },
});
