import { ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { Button } from "@/components/Button";
import { Palette } from "@/constants/Colors";
import { Radius, Spacing, Typography } from "@/constants/Typography";
import { usingEmulators } from "@/FirebaseConfig";
import { useAuth } from "@/lib/auth";
import { useCafe } from "@/lib/owner-context";
import { formatPhone } from "@/lib/phone";

// The iMessage address owners text their menu to; shown when configured.
const JOLO_HANDLE = process.env.EXPO_PUBLIC_JOLO_IMESSAGE_HANDLE;

export default function AccountScreen() {
  const cafe = useCafe();
  const { user, signOut } = useAuth();

  return (
    <SafeAreaView style={styles.root} edges={["top"]}>
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={styles.title} accessibilityRole="header">
          Account
        </Text>

        <View style={styles.card}>
          {cafe.ownerName ? (
            <Row icon="person-outline" label="Name" value={cafe.ownerName} />
          ) : null}
          <Row icon="cafe-outline" label="Business" value={cafe.name} />
          {cafe.address ? (
            <Row icon="location-outline" label="Location" value={cafe.address} />
          ) : null}
          <Row icon="call-outline" label="Signed in as" value={formatPhone(user?.phoneNumber)} />
        </View>

        <View style={styles.card}>
          <Text style={styles.cardTitle}>Update your menu by text</Text>
          <Text style={styles.body}>
            Text a photo of your menu to {JOLO_HANDLE ? formatPhone(JOLO_HANDLE) : "JOLO"} and say
            "update the menu". JOLO asks whether the photo is your full menu or just part of it,
            shows you what changed, and saves it when you reply "yes". It appears here right away.
          </Text>
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
  row: { flexDirection: "row", gap: Spacing.sm, alignItems: "flex-start" },
  rowText: { flex: 1 },
  rowLabel: { ...Typography.labelMd, color: Palette.onSurfaceVariant },
  rowValue: { ...Typography.bodyMd, color: Palette.onSurface },
  emulator: { ...Typography.labelMd, color: Palette.secondary, textAlign: "center" },
});
