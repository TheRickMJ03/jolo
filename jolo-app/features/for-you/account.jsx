import { ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { Button } from "@/components/Button";
import { Palette } from "@/constants/Colors";
import { Radius, Spacing, Typography } from "@/constants/Typography";
import { usingEmulators } from "@/FirebaseConfig";
import { useAuth } from "@/lib/auth";
import { formatPhone } from "@/lib/phone";
import { useForYouState } from "@/lib/user-session";

export default function AccountScreen() {
  const { user, signOut } = useAuth();
  const { taste } = useForYouState();
  const signedInAs = user?.phoneNumber ? formatPhone(user.phoneNumber) : (user?.email ?? "");
  const niches = taste?.niches ?? [];

  return (
    <SafeAreaView style={styles.root} edges={["top"]}>
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={styles.title} accessibilityRole="header">
          Account
        </Text>

        <View style={styles.card}>
          <Row icon="person-outline" label="Signed in as" value={signedInAs || "JOLO member"} />
        </View>

        <View style={styles.card}>
          <Text style={styles.cardTitle}>Your taste</Text>
          {niches.length === 0 ? (
            <Text style={styles.body}>
              Search for a drink and mark the ones you order. That becomes the taste we look up.
            </Text>
          ) : (
            niches.map((niche) => (
              <Text key={niche} style={styles.niche}>
                {niche}
              </Text>
            ))
          )}
        </View>

        {usingEmulators ? (
          <Text style={styles.emulator}>Connected to the local Firebase emulators.</Text>
        ) : null}

        <Button label="Sign out" variant="outline" onPress={signOut} />
      </ScrollView>
    </SafeAreaView>
  );
}

function Row({ icon, label, value }) {
  return (
    <View style={styles.row} accessible accessibilityLabel={`${label}: ${value}`}>
      <Ionicons name={icon} size={18} color={Palette.secondary} />
      <View style={styles.rowText}>
        <Text style={styles.rowLabel}>{label}</Text>
        <Text style={styles.rowValue}>{value}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: Palette.background },
  content: { padding: Spacing.marginMain, gap: Spacing.stackMd },
  title: { ...Typography.headlineLgMobile, color: Palette.primary },
  card: {
    backgroundColor: Palette.surfaceContainerLow,
    borderRadius: Radius.lg,
    padding: Spacing.cardPadding,
    gap: Spacing.sm,
  },
  cardTitle: { ...Typography.labelLg, color: Palette.onSurface },
  body: { ...Typography.bodyMd, color: Palette.onSurfaceVariant },
  niche: { ...Typography.bodyMd, color: Palette.onSurface },
  row: { flexDirection: "row", gap: Spacing.sm, alignItems: "flex-start" },
  rowText: { flex: 1 },
  rowLabel: { ...Typography.labelMd, color: Palette.onSurfaceVariant },
  rowValue: { ...Typography.bodyMd, color: Palette.onSurface },
  emulator: { ...Typography.labelMd, color: Palette.secondary, textAlign: "center" },
});
