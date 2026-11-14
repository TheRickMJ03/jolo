// The owner's analytics hub. Everything about how the café is doing, in one
// place: suggestions first, then the evidence behind them.
//   Your menu         live menu and versions (no scraper)
//   Customer asks     weekly insights from the agent's backend
//   Other shops       drinks other cafés added or serve (recommend job)
//   Asked near you    JOLO searches and drink taps in your town (recommend job)
//   On the web        café blogs and Reddit (recommend job, scraper)
import { useState } from "react";
import {
  ActivityIndicator,
  Linking,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { Banner } from "@/components/Banner";
import { EmptyState } from "@/components/EmptyState";
import { Palette } from "@/constants/Colors";
import { Radius, Spacing, Typography } from "@/constants/Typography";
import { useInsights } from "@/hooks/useInsights";
import { useCurrentMenu, useMenuHistory } from "@/hooks/useMenu";
import { useOwnerAnalytics } from "@/hooks/useOwnerAnalytics";
import { countRows, weekLabel } from "@/lib/insights";
import {
  askSummary,
  buildSuggestions,
  menuStats,
  menuTiles,
  otherShopRows,
  sourcesLine,
  webRows,
} from "@/lib/owner-insights";
import { useCafe } from "@/lib/owner-context";

const SUGGESTION_ICONS = {
  add: "add-circle-outline",
  feature: "star-outline",
  restock: "refresh-circle-outline",
  check: "alert-circle-outline",
};

export default function InsightsScreen() {
  const cafe = useCafe();
  const menu = useCurrentMenu(cafe);
  const history = useMenuHistory(cafe.id);
  const insights = useInsights(cafe.id);
  const {
    analytics,
    loading: analyticsLoading,
    error: analyticsError,
  } = useOwnerAnalytics(cafe.id);
  const [showPastWeeks, setShowPastWeeks] = useState(false);

  const items = menu.version?.items ?? [];
  const stats = menuStats(items, history.versions);
  const suggestions = buildSuggestions({ items, analytics, weeks: insights.weeks });
  const asks = askSummary(insights.weeks);
  const shops = otherShopRows(analytics, items);
  const web = webRows(analytics, items);
  const nearby = analytics?.nearby;
  const loading = menu.loading || insights.loading || analyticsLoading;

  return (
    <SafeAreaView style={styles.root} edges={["top"]}>
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={styles.title} accessibilityRole="header">
          Insights
        </Text>
        <Text style={styles.subtitle}>
          {analytics ? sourcesLine(analytics) : `How ${cafe.name} is doing, and what to try next.`}
        </Text>

        {insights.error || analyticsError ? (
          <Banner kind="error">Some insights couldn't load. Check your connection.</Banner>
        ) : null}
        {loading ? <ActivityIndicator color={Palette.primary} /> : null}

        <Section title="Suggestions" icon="bulb-outline">
          {suggestions.length === 0 ? (
            <Text style={styles.muted}>
              {analytics
                ? "Nothing to suggest right now. Your menu covers what's trending."
                : "Suggestions appear once trends are collected for your area."}
            </Text>
          ) : (
            suggestions.map((suggestion) => (
              <View
                key={suggestion.id}
                style={styles.suggestion}
                accessible
                accessibilityLabel={`${suggestion.title}. ${suggestion.reasons.join(". ")}`}
              >
                <Ionicons
                  name={SUGGESTION_ICONS[suggestion.kind]}
                  size={22}
                  color={suggestion.kind === "check" ? Palette.error : Palette.secondary}
                />
                <View style={styles.flex}>
                  <Text style={styles.suggestionTitle}>{suggestion.title}</Text>
                  <Text style={styles.reasons}>{suggestion.reasons.join(" · ")}</Text>
                </View>
              </View>
            ))
          )}
        </Section>

        <Section title="Your menu" icon="restaurant-outline">
          {items.length === 0 ? (
            <Text style={styles.muted}>No menu yet. Text JOLO a photo of your menu to start.</Text>
          ) : (
            <View style={styles.tiles}>
              {menuTiles(stats).map((tile) => (
                <View
                  key={tile.key}
                  style={styles.tile}
                  accessible
                  accessibilityLabel={`${tile.label}: ${tile.value}`}
                >
                  <Text style={[styles.tileValue, tile.warn && styles.warn]}>{tile.value}</Text>
                  <Text style={styles.tileLabel}>{tile.label}</Text>
                </View>
              ))}
            </View>
          )}
        </Section>

        <Section title="Customer asks" icon="chatbubbles-outline">
          {!asks ? (
            <Text style={styles.muted}>
              Weekly counts appear after customers start asking JOLO about your menu.
            </Text>
          ) : (
            <>
              <Text style={styles.week}>
                {weekLabel(asks.weekStart)}
                {asks.change ? ` · ${asks.change}` : ""}
              </Text>
              <View style={styles.tiles}>
                {countRows(asks.counts).map((row) => (
                  <View
                    key={row.key}
                    style={styles.tile}
                    accessible
                    accessibilityLabel={`${row.label}: ${row.value}`}
                  >
                    <Text style={styles.tileValue}>{row.value}</Text>
                    <Text style={styles.tileLabel}>{row.label}</Text>
                  </View>
                ))}
              </View>
              {asks.topItems.length > 0 ? (
                <View style={styles.block}>
                  <Text style={styles.blockTitle}>Most asked about</Text>
                  {asks.topItems.slice(0, 5).map((item) => (
                    <BarRow
                      key={item.name}
                      label={item.name}
                      value={item.mentions}
                      max={asks.topItems[0].mentions}
                    />
                  ))}
                </View>
              ) : null}
              {asks.summary ? <Text style={styles.body}>{asks.summary}</Text> : null}
              {insights.weeks.length > 1 ? (
                <Pressable
                  onPress={() => setShowPastWeeks((open) => !open)}
                  accessibilityRole="button"
                  style={styles.toggle}
                >
                  <Text style={styles.toggleText}>
                    {showPastWeeks
                      ? "Hide past weeks"
                      : `Past weeks (${insights.weeks.length - 1})`}
                  </Text>
                  <Ionicons
                    name={showPastWeeks ? "chevron-up" : "chevron-down"}
                    size={16}
                    color={Palette.secondary}
                  />
                </Pressable>
              ) : null}
              {showPastWeeks
                ? insights.weeks.slice(1).map((week) => (
                    <Text key={week.weekStart} style={styles.pastWeek}>
                      {weekLabel(week.weekStart)} ·{" "}
                      {countRows(week.counts)
                        .map((row) => `${row.value} ${row.label.toLowerCase()}`)
                        .join(" · ")}
                    </Text>
                  ))
                : null}
            </>
          )}
        </Section>

        {analytics ? (
          <>
            <Section title="Other shops" icon="storefront-outline">
              {shops.length === 0 ? (
                <Text style={styles.muted}>No other menus have changed this month.</Text>
              ) : (
                shops.map((row) => (
                  <View key={row.name} style={styles.row}>
                    <View style={styles.flex}>
                      <Text style={styles.rowTitle}>{row.name}</Text>
                      <Text style={styles.rowDetail}>{row.detail}</Text>
                    </View>
                    <MenuBadge onMenu={row.onMenu} />
                  </View>
                ))
              )}
            </Section>

            <Section title={`Asked about in ${nearby?.scope ?? "your area"}`} icon="search-outline">
              {(nearby?.terms ?? []).length === 0 ? (
                <Text style={styles.muted}>No JOLO searches near you yet.</Text>
              ) : (
                <>
                  {nearby.terms.map((term) => (
                    <BarRow
                      key={term.term}
                      label={term.term}
                      value={term.count}
                      max={nearby.terms[0].count}
                    />
                  ))}
                  <Text style={styles.footnote}>
                    From {nearby.searches} {nearby.searches === 1 ? "search" : "searches"} and drink
                    taps on JOLO in the last 30 days. Counts only, never who asked.
                  </Text>
                </>
              )}
            </Section>

            <Section title="On the web" icon="globe-outline">
              {web.length === 0 ? (
                <Text style={styles.muted}>No drink trends found yet.</Text>
              ) : (
                web.map((drink) => (
                  <Pressable
                    key={drink.name}
                    style={styles.row}
                    disabled={!drink.example?.url}
                    onPress={() => drink.example?.url && Linking.openURL(drink.example.url)}
                    accessibilityRole={drink.example?.url ? "link" : undefined}
                    accessibilityHint={drink.example?.url ? "Opens an example post" : undefined}
                  >
                    <View style={styles.flex}>
                      <View style={styles.titleLine}>
                        <Text style={styles.rowTitle}>{drink.name}</Text>
                        {drink.momentum === "rising" ? (
                          <View style={styles.rising}>
                            <Ionicons
                              name="trending-up"
                              size={12}
                              color={Palette.onSecondaryContainer}
                            />
                            <Text style={styles.risingText}>Rising</Text>
                          </View>
                        ) : null}
                      </View>
                      <Text style={styles.rowDetail}>
                        {drink.sourceLabels.join(" · ")}
                        {drink.mentions ? ` · ${drink.mentions} posts` : ""}
                      </Text>
                      {drink.example?.title ? (
                        <Text style={styles.example} numberOfLines={1}>
                          “{drink.example.title}”
                        </Text>
                      ) : null}
                    </View>
                    <MenuBadge onMenu={drink.onMenu} />
                  </Pressable>
                ))
              )}
            </Section>
          </>
        ) : !analyticsLoading ? (
          <EmptyState icon="analytics-outline" title="Trends are on their way">
            Other shops, what people ask near you and web trends appear after JOLO's trends job runs
            for your area.
          </EmptyState>
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}

function Section({ title, icon, children }) {
  return (
    <View style={styles.card}>
      <View style={styles.cardHead}>
        <Ionicons name={icon} size={18} color={Palette.secondary} />
        <Text style={styles.cardTitle} accessibilityRole="header">
          {title}
        </Text>
      </View>
      {children}
    </View>
  );
}

function BarRow({ label, value, max }) {
  const width = max > 0 ? `${Math.max(6, Math.round((value / max) * 100))}%` : "0%";
  return (
    <View style={styles.barRow} accessible accessibilityLabel={`${label}: ${value}`}>
      <View style={styles.barLabelLine}>
        <Text style={styles.barLabel} numberOfLines={1}>
          {label}
        </Text>
        <Text style={styles.barValue}>{value}</Text>
      </View>
      <View style={styles.barTrack}>
        <View style={[styles.barFill, { width }]} />
      </View>
    </View>
  );
}

function MenuBadge({ onMenu }) {
  return (
    <View style={[styles.badge, onMenu ? styles.badgeOn : styles.badgeOff]}>
      <Text style={[styles.badgeText, onMenu ? styles.badgeTextOn : styles.badgeTextOff]}>
        {onMenu ? "On your menu" : "Not on menu"}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: Palette.background },
  content: { padding: Spacing.marginMain, gap: Spacing.stackSm, paddingBottom: 120 },
  title: { ...Typography.headlineLgMobile, color: Palette.primary },
  subtitle: { ...Typography.bodySm, color: Palette.onSurfaceVariant, marginBottom: Spacing.xs },
  flex: { flex: 1, gap: 2 },
  muted: { ...Typography.bodySm, color: Palette.onSurfaceVariant },
  body: { ...Typography.bodyMd, color: Palette.onSurface },
  footnote: { ...Typography.labelMd, color: Palette.onSurfaceVariant, marginTop: 4 },
  card: {
    backgroundColor: Palette.surfaceContainerLow,
    borderRadius: Radius.lg,
    padding: Spacing.cardPadding,
    gap: Spacing.sm,
  },
  cardHead: { flexDirection: "row", alignItems: "center", gap: 8 },
  cardTitle: { ...Typography.labelLg, color: Palette.primary, fontSize: 16 },
  suggestion: {
    flexDirection: "row",
    gap: Spacing.sm,
    alignItems: "flex-start",
    backgroundColor: Palette.surfaceContainerLowest,
    borderRadius: Radius.md,
    padding: Spacing.sm,
  },
  suggestionTitle: {
    ...Typography.bodyMd,
    fontFamily: "PlusJakartaSans_600SemiBold",
    color: Palette.onSurface,
  },
  reasons: { ...Typography.bodySm, color: Palette.onSurfaceVariant },
  tiles: { flexDirection: "row", flexWrap: "wrap", gap: Spacing.sm },
  tile: {
    minWidth: 96,
    flexGrow: 1,
    flexBasis: "28%",
    backgroundColor: Palette.surfaceContainerLowest,
    borderRadius: Radius.md,
    padding: Spacing.xs + 4,
  },
  tileValue: { ...Typography.headlineMd, color: Palette.primary, fontVariant: ["tabular-nums"] },
  tileLabel: { ...Typography.labelMd, color: Palette.onSurfaceVariant },
  warn: { color: Palette.error },
  week: { ...Typography.labelLg, color: Palette.secondary },
  block: { gap: 6 },
  blockTitle: { ...Typography.labelLg, color: Palette.onSurface },
  toggle: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    alignSelf: "flex-start",
    paddingVertical: 4,
  },
  toggleText: { ...Typography.labelLg, color: Palette.secondary },
  pastWeek: { ...Typography.bodySm, color: Palette.onSurfaceVariant },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: Spacing.sm,
    paddingVertical: 6,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: Palette.outlineVariant,
  },
  titleLine: { flexDirection: "row", alignItems: "center", gap: 6, flexWrap: "wrap" },
  rowTitle: {
    ...Typography.bodyMd,
    fontFamily: "PlusJakartaSans_600SemiBold",
    color: Palette.onSurface,
  },
  rowDetail: { ...Typography.bodySm, color: Palette.onSurfaceVariant },
  example: { ...Typography.labelMd, color: Palette.secondary },
  rising: {
    flexDirection: "row",
    alignItems: "center",
    gap: 2,
    backgroundColor: Palette.secondaryContainer,
    borderRadius: Radius.full,
    paddingHorizontal: 6,
    paddingVertical: 1,
  },
  risingText: { ...Typography.labelMd, fontSize: 11, color: Palette.onSecondaryContainer },
  badge: { borderRadius: Radius.full, paddingHorizontal: 8, paddingVertical: 3 },
  badgeOn: { backgroundColor: Palette.surfaceContainerHigh },
  badgeOff: { backgroundColor: Palette.secondaryContainer },
  badgeText: { ...Typography.labelMd, fontSize: 11 },
  badgeTextOn: { color: Palette.onSurfaceVariant },
  badgeTextOff: { color: Palette.onSecondaryContainer },
  barRow: { gap: 3 },
  barLabelLine: { flexDirection: "row", justifyContent: "space-between", gap: Spacing.sm },
  barLabel: { ...Typography.bodySm, color: Palette.onSurface, flexShrink: 1 },
  barValue: {
    ...Typography.labelMd,
    color: Palette.onSurfaceVariant,
    fontVariant: ["tabular-nums"],
  },
  barTrack: {
    height: 6,
    borderRadius: 3,
    backgroundColor: Palette.surfaceContainerHigh,
    overflow: "hidden",
  },
  barFill: { height: 6, borderRadius: 3, backgroundColor: Palette.secondary },
});
