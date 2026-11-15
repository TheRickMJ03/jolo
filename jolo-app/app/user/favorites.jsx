import { useMemo, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { NotificationsPanel } from "@/components/NotificationsPanel";
import { Palette } from "@/constants/Colors";
import { Radius, Spacing, Typography } from "@/constants/Typography";
import { useCafes } from "@/hooks/useCafes";
import { useUserActivity } from "@/hooks/useUserActivity";
import { useUserLocation } from "@/hooks/useUserLocation";
import { useAuth } from "@/lib/auth";
import { distanceMiles, formatDistance, isInServiceArea } from "@/lib/geo";
import { relativeDay } from "@/lib/insights";
import { recentCafes, recentRequests } from "@/lib/user-activity";

// Sample drink trends from recommend/job.py DEMO_TRENDS, after extract_drinks.
// Bare words the extractor also keeps ("Latte", "Matcha") are left off; the
// longer names already cover them.
const DRINK_TRENDS = [
  { id: "brown-sugar-oat-latte", name: "Brown sugar oat latte", momentum: "Rising" },
  { id: "lavender-oat-latte", name: "Lavender oat latte", momentum: "Rising" },
  { id: "lavender-latte", name: "Lavender latte", momentum: "Rising" },
  { id: "oat-cortado", name: "Oat cortado", momentum: "Steady" },
  { id: "iced-matcha", name: "Iced matcha", momentum: "Steady" },
  { id: "cold-brew", name: "Cold brew", momentum: "Steady" },
];

export default function FavoritesView() {
  const { user } = useAuth();
  const activity = useUserActivity(user);
  const { cafes } = useCafes();
  const { coords } = useUserLocation();
  const [notifOpen, setNotifOpen] = useState(false);
  const [activeTab, setActiveTab] = useState("recommendations");
  const [savedTrends, setSavedTrends] = useState([]);

  const nearby = coords != null && isInServiceArea(coords);
  const requests = useMemo(() => recentRequests(activity.events), [activity.events]);
  const history = useMemo(() => {
    return recentCafes(activity.events, cafes).map((cafe) => ({
      ...cafe,
      miles: nearby && cafe.coordinate ? distanceMiles(coords, cafe.coordinate) : null,
    }));
  }, [activity.events, cafes, nearby, coords]);

  const toggleTrend = (item) => {
    const saved = savedTrends.includes(item.id);
    setSavedTrends((prev) => (saved ? prev.filter((id) => id !== item.id) : [...prev, item.id]));
  };

  return (
    <View style={styles.root}>
      <SafeAreaView edges={["top"]} style={styles.headerSafe}>
        <View style={styles.header}>
          <View style={styles.avatar}>
            <Ionicons name="person" size={20} color={Palette.primary} />
          </View>
          <Text style={styles.headerTitle}>For you</Text>
          <Pressable
            style={({ pressed }) => [styles.bellBtn, pressed && styles.pressed]}
            onPress={() => setNotifOpen((v) => !v)}
          >
            <Ionicons name="notifications-outline" size={22} color={Palette.primary} />
            <View style={styles.badgeDot} />
          </Pressable>
        </View>
        <NotificationsPanel
          visible={notifOpen}
          onClose={() => setNotifOpen(false)}
          style={{ top: 60, right: Spacing.marginMain }}
        />

        <View style={styles.segTabs}>
          <Pressable onPress={() => setActiveTab("recommendations")}>
            <Text style={[styles.segTab, activeTab === "recommendations" && styles.segTabActive]}>
              Recommendations
            </Text>
          </Pressable>
          <Pressable onPress={() => setActiveTab("history")}>
            <Text style={[styles.segTab, activeTab === "history" && styles.segTabActive]}>
              History
            </Text>
          </Pressable>
        </View>
      </SafeAreaView>

      <ScrollView contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>
        {activeTab === "recommendations" ? (
          <>
            <View style={styles.sectionHead}>
              <Text style={styles.sectionTitle}>What you like</Text>
              {requests.length > 0 ? (
                <Text style={styles.seeAll}>See all {requests.length}</Text>
              ) : null}
            </View>
            {activity.loading ? (
              <ActivityIndicator
                color={Palette.primary}
                accessibilityLabel="Loading your requests"
              />
            ) : activity.error ? (
              <EmptyRow
                icon="cloud-offline-outline"
                text="Couldn't load your requests. Check your connection."
              />
            ) : requests.length > 0 ? (
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={styles.circleRow}
              >
                {requests.map((item) => (
                  <View key={item.id} style={styles.circleCard}>
                    <View style={styles.circleThumb}>
                      <Ionicons name="cafe" size={38} color={Palette.primary} />
                    </View>
                    <Text style={styles.circleName} numberOfLines={2}>
                      {item.text}
                    </Text>
                    <Text style={styles.circleSub}>
                      {item.createdAt ? `Asked ${relativeDay(item.createdAt)}` : "Recent search"}
                    </Text>
                  </View>
                ))}
              </ScrollView>
            ) : (
              <EmptyRow
                icon="search-outline"
                text='Search in Finder, or ask JOLO over iMessage, and it will show up here.'
              />
            )}

            <View style={[styles.sectionHead, styles.sectionHeadSecond]}>
              <Text style={styles.sectionTitle}>Trending now</Text>
              <Text style={styles.seeAll}>See all {DRINK_TRENDS.length}</Text>
            </View>
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={styles.circleRow}
            >
              {DRINK_TRENDS.map((item) => {
                const saved = savedTrends.includes(item.id);
                return (
                  <View key={item.id} style={styles.circleCard}>
                    <View style={styles.circleThumb}>
                      <Ionicons name="cafe" size={38} color={Palette.primary} />
                      <Pressable style={styles.circleHeart} onPress={() => toggleTrend(item)}>
                        <Ionicons
                          name={saved ? "heart" : "heart-outline"}
                          size={14}
                          color={saved ? Palette.error : Palette.onSurfaceVariant}
                        />
                      </Pressable>
                    </View>
                    <Text style={styles.circleName} numberOfLines={2}>
                      {item.name}
                    </Text>
                    <Text style={styles.circleSub}>{item.momentum}</Text>
                  </View>
                );
              })}
            </ScrollView>
          </>
        ) : (
          <>
            <View style={styles.sectionHead}>
              <Text style={styles.sectionTitle}>Recent cafés</Text>
              {history.length > 0 ? (
                <Text style={styles.seeAll}>See all {history.length}</Text>
              ) : null}
            </View>
            {activity.loading ? (
              <ActivityIndicator
                color={Palette.primary}
                accessibilityLabel="Loading café history"
              />
            ) : activity.error ? (
              <EmptyRow
                icon="cloud-offline-outline"
                text="Couldn't load your café history. Check your connection."
              />
            ) : history.length > 0 ? (
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={styles.circleRow}
              >
                {history.map((item) => (
                  <View key={item.id} style={styles.circleCard}>
                    <View style={styles.circleThumb}>
                      <Ionicons name="cafe" size={38} color={Palette.primary} />
                    </View>
                    <Text style={styles.circleName} numberOfLines={2}>
                      {item.name}
                    </Text>
                    <View style={styles.circleSubRow}>
                      <Ionicons name="star" size={11} color={Palette.secondary} />
                      <Text style={styles.circleSub}>
                        {item.rating != null ? item.rating.toFixed(1) : "No rating"}
                        {item.miles != null ? ` · ${formatDistance(item.miles)}` : ""}
                      </Text>
                    </View>
                  </View>
                ))}
              </ScrollView>
            ) : (
              <EmptyRow
                icon="location-outline"
                text="Search for a café, open one on the map, or ask JOLO over iMessage, and it will show up here."
              />
            )}
          </>
        )}
      </ScrollView>
    </View>
  );
}

function EmptyRow({ icon, text }) {
  return (
    <View style={styles.emptyRow}>
      <View style={styles.emptyIcon}>
        <Ionicons name={icon} size={20} color={Palette.onSurfaceVariant} />
      </View>
      <Text style={styles.emptyText}>{text}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: Palette.background },
  headerSafe: { backgroundColor: Palette.background, position: "relative", zIndex: 20 },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: Spacing.marginMain,
    paddingVertical: 12,
  },
  avatar: {
    width: 40,
    height: 40,
    borderRadius: Radius.full,
    backgroundColor: Palette.secondaryContainer,
    borderWidth: 1,
    borderColor: "rgba(211,195,192,0.4)",
    alignItems: "center",
    justifyContent: "center",
  },
  headerTitle: {
    ...Typography.headlineMd,
    fontFamily: "Montserrat_700Bold",
    color: Palette.primary,
  },
  bellBtn: {
    width: 40,
    height: 40,
    borderRadius: Radius.full,
    alignItems: "center",
    justifyContent: "center",
  },
  badgeDot: {
    position: "absolute",
    top: 6,
    right: 7,
    width: 8,
    height: 8,
    borderRadius: 9999,
    backgroundColor: Palette.error,
    borderWidth: 2,
    borderColor: Palette.background,
  },

  segTabs: {
    flexDirection: "row",
    gap: 28,
    paddingHorizontal: Spacing.marginMain,
    borderBottomWidth: 1,
    borderBottomColor: Palette.surfaceContainerHigh,
  },
  segTab: {
    ...Typography.bodyMd,
    fontFamily: "PlusJakartaSans_600SemiBold",
    fontSize: 15,
    color: Palette.onSurfaceVariant,
    paddingVertical: 10,
    borderBottomWidth: 3,
    borderBottomColor: "transparent",
  },
  segTabActive: {
    color: Palette.primary,
    borderBottomColor: Palette.primary,
  },

  scroll: {
    paddingHorizontal: Spacing.marginMain,
    paddingTop: Spacing.sm,
    paddingBottom: 110,
  },
  sectionHead: {
    flexDirection: "row",
    alignItems: "baseline",
    justifyContent: "space-between",
    marginBottom: Spacing.sm,
  },
  sectionHeadSecond: {
    marginTop: Spacing.lg,
  },
  sectionTitle: {
    fontFamily: "Montserrat_700Bold",
    fontSize: 22,
    color: Palette.onSurface,
  },
  seeAll: {
    ...Typography.labelLg,
    color: Palette.secondary,
  },

  circleRow: {
    gap: 18,
    paddingRight: Spacing.marginMain,
    paddingBottom: 8,
  },
  circleCard: {
    width: 100,
    alignItems: "center",
  },
  circleThumb: {
    width: 100,
    height: 100,
    borderRadius: Radius.full,
    backgroundColor: Palette.secondaryContainer,
    alignItems: "center",
    justifyContent: "center",
    overflow: "visible",
  },
  circleHeart: {
    position: "absolute",
    bottom: -6,
    right: -2,
    width: 28,
    height: 28,
    borderRadius: Radius.full,
    backgroundColor: Palette.surfaceContainerLowest,
    borderWidth: 2,
    borderColor: Palette.background,
    alignItems: "center",
    justifyContent: "center",
  },
  circleName: {
    fontFamily: "Montserrat_600SemiBold",
    fontSize: 13,
    lineHeight: 16,
    textAlign: "center",
    color: Palette.onSurface,
    marginTop: 10,
  },
  circleSub: {
    ...Typography.labelMd,
    fontSize: 11,
    color: Palette.onSurfaceVariant,
    textAlign: "center",
    marginTop: 3,
  },
  circleSubRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 3,
    marginTop: 3,
  },

  emptyRow: {
    alignItems: "center",
    gap: 8,
    paddingVertical: 28,
    paddingHorizontal: 16,
    backgroundColor: Palette.surfaceContainerLowest,
    borderRadius: 20,
    borderWidth: 1,
    borderStyle: "dashed",
    borderColor: "rgba(211,195,192,0.6)",
  },
  emptyIcon: {
    width: 44,
    height: 44,
    borderRadius: Radius.full,
    backgroundColor: Palette.surfaceContainer,
    alignItems: "center",
    justifyContent: "center",
  },
  emptyText: {
    ...Typography.bodySm,
    color: Palette.onSurfaceVariant,
    textAlign: "center",
    maxWidth: 240,
  },

  pressed: {
    transform: [{ scale: 0.96 }],
    opacity: 0.9,
  },
});
