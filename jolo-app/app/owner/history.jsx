import { ActivityIndicator, FlatList, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { Banner } from "@/components/Banner";
import { ChangeList } from "@/components/ChangeList";
import { EmptyState } from "@/components/EmptyState";
import { Palette } from "@/constants/Colors";
import { Radius, Spacing, Typography } from "@/constants/Typography";
import { useMenuHistory } from "@/hooks/useMenu";
import { relativeDay } from "@/lib/insights";
import { useCafe } from "@/lib/owner-context";

export default function HistoryScreen() {
  const cafe = useCafe();
  const { loading, versions, error } = useMenuHistory(cafe.id);

  return (
    <SafeAreaView style={styles.root} edges={["top"]}>
      <FlatList
        contentContainerStyle={styles.content}
        data={versions}
        keyExtractor={(version) => String(version.version)}
        ListHeaderComponent={
          <View style={styles.header}>
            <Text style={styles.title} accessibilityRole="header">
              History
            </Text>
            <Text style={styles.subtitle}>Every change is kept. The newest is live.</Text>
            {error ? <Banner kind="error">Couldn't load the history.</Banner> : null}
            {loading ? <ActivityIndicator color={Palette.primary} /> : null}
          </View>
        }
        ListEmptyComponent={
          loading ? null : (
            <EmptyState icon="time-outline" title="No versions yet">
              Your first menu update will show up here.
            </EmptyState>
          )
        }
        renderItem={({ item: version }) => {
          const live = version.version === cafe.currentMenuVersion;
          return (
            <View style={[styles.card, live && styles.cardLive]}>
              <View style={styles.cardHeader}>
                <Ionicons
                  name={version.source === "app" ? "phone-portrait-outline" : "chatbubble-outline"}
                  size={16}
                  color={Palette.secondary}
                />
                <Text style={styles.cardTitle}>
                  Version {version.version}
                  {live ? " · live" : ""}
                </Text>
                <Text style={styles.cardMeta}>
                  {version.source === "app" ? "in the app" : "by text"}
                  {version.createdAt ? ` · ${relativeDay(version.createdAt)}` : ""}
                </Text>
              </View>
              {version.scope === "partial" ? (
                <Text style={styles.scope}>Partial photo — items not shown were kept</Text>
              ) : null}
              <ChangeList changes={version.changes} max={8} />
            </View>
          );
        }}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: Palette.background },
  content: { padding: Spacing.marginMain, gap: Spacing.stackSm },
  header: { gap: Spacing.xs, marginBottom: Spacing.xs },
  title: { ...Typography.headlineLgMobile, color: Palette.primary },
  subtitle: { ...Typography.bodySm, color: Palette.onSurfaceVariant },
  card: {
    backgroundColor: Palette.surfaceContainerLow,
    borderRadius: Radius.lg,
    padding: Spacing.cardPadding,
    gap: Spacing.xs,
  },
  cardLive: { borderWidth: 2, borderColor: Palette.secondaryContainer },
  cardHeader: { flexDirection: "row", alignItems: "center", gap: 6, flexWrap: "wrap" },
  cardTitle: { ...Typography.labelLg, color: Palette.onSurface },
  cardMeta: { ...Typography.labelMd, color: Palette.onSurfaceVariant },
  scope: { ...Typography.labelMd, color: Palette.onSurfaceVariant, fontStyle: "italic" },
});
