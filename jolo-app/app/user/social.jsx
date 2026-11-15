import { useMemo, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { NotificationsPanel } from "@/components/NotificationsPanel";
import { ReviewCard } from "@/components/ReviewCard";
import { ReviewComposer } from "@/components/ReviewComposer";
import { Palette } from "@/constants/Colors";
import { Radius, Spacing, Typography } from "@/constants/Typography";
import { useAreaTrends } from "@/hooks/useAreaTrends";
import { useCafes } from "@/hooks/useCafes";
import { usePostReview, useReviews } from "@/hooks/useReviews";
import { useUserLocation } from "@/hooks/useUserLocation";
import { nearestFirst } from "@/lib/area-trends";
import { useForYou } from "@/hooks/useForYou";
import { useAuth } from "@/lib/auth";
import { formatPrice } from "@/lib/menu";

const SIGNAL_ICONS = { web: "trending-up", new: "sparkles-outline", asks: "chatbubble-outline" };

export default function SocialView() {
  const { user } = useAuth();
  const area = useAreaTrends();
  const { coords } = useUserLocation();
  const reviews = useReviews();
  const trending = useMemo(() => nearestFirst(area.trending, coords), [area.trending, coords]);
  // Personal picks come from this person's searches; "personal" shows them when they exist.
  const forYou = useForYou(user, "personal");
  const picks = forYou.source === "personal" ? forYou.cards : [];
  const [notifOpen, setNotifOpen] = useState(false);
  const [composing, setComposing] = useState(false);
  const { cafes } = useCafes();
  const { post, posting } = usePostReview(user);
  const postReview = async (review) => {
    await post(review);
    setComposing(false);
  };

  return (
    <View style={styles.root}>
      <SafeAreaView edges={["top"]} style={styles.headerSafe}>
        <View style={styles.header}>
          <View style={styles.avatar}>
            <Ionicons name="person" size={20} color={Palette.primary} />
          </View>
          <Text style={styles.headerTitle}>Social</Text>
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
      </SafeAreaView>

      <ScrollView contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>
        <Text style={styles.sectionTitle}>Trending near you</Text>
        {area.loading ? (
          <ActivityIndicator color={Palette.primary} accessibilityLabel="Finding trending drinks" />
        ) : trending.length === 0 ? (
          <Text style={styles.emptyLine}>
            Nothing is trending on local menus yet. Check back after cafés update their menus.
          </Text>
        ) : (
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.trendingRow}
          >
            {trending.map((card) => (
              <DrinkTrendCard
                key={`${card.cafeId}:${card.itemId}`}
                card={card}
                icon={SIGNAL_ICONS[card.signals?.[0]?.kind] ?? "cafe-outline"}
                onPress={() =>
                  forYou.record({
                    type: "open",
                    cafeId: card.cafeId,
                    itemId: card.itemId,
                    itemName: card.itemName,
                  })
                }
              />
            ))}
          </ScrollView>
        )}

        <Text style={styles.sectionTitle}>Picked for you</Text>
        {forYou.loading ? (
          <ActivityIndicator color={Palette.primary} accessibilityLabel="Finding your picks" />
        ) : picks.length === 0 ? (
          <Text style={styles.emptyLine}>
            Search for drinks in Finder, like "oat milk latte", and JOLO will pick some for you from
            today's menus.
          </Text>
        ) : (
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.trendingRow}
          >
            {picks.map((card) => (
              <DrinkTrendCard
                key={`${card.cafeId}:${card.itemId}`}
                card={card}
                icon="heart-outline"
                onPress={() =>
                  forYou.record({
                    type: "open",
                    cafeId: card.cafeId,
                    itemId: card.itemId,
                    itemName: card.itemName,
                  })
                }
              />
            ))}
          </ScrollView>
        )}

        <View style={styles.sectionRow}>
          <Text style={[styles.sectionTitle, styles.sectionTitleInRow]}>Reviews</Text>
          <Pressable
            style={({ pressed }) => [styles.writeBtn, pressed && styles.pressed]}
            onPress={() => setComposing(true)}
            accessibilityRole="button"
            accessibilityLabel="Write a review"
          >
            <Ionicons name="create-outline" size={15} color={Palette.onSecondaryContainer} />
            <Text style={styles.writeBtnText}>Write</Text>
          </Pressable>
        </View>
        {reviews.loading ? (
          <ActivityIndicator color={Palette.primary} accessibilityLabel="Loading reviews" />
        ) : reviews.error && reviews.reviews.length === 0 ? (
          <Text style={styles.emptyLine}>Couldn't load reviews. Check your connection.</Text>
        ) : reviews.reviews.length === 0 ? (
          <Text style={styles.emptyLine}>
            No reviews yet. Been to a café lately? Tap Write to be the first.
          </Text>
        ) : (
          <View style={styles.feedList}>
            {reviews.reviews.map((review) => (
              <ReviewCard key={review.id} review={review} />
            ))}
          </View>
        )}
      </ScrollView>

      <ReviewComposer
        visible={composing}
        cafes={cafes}
        posting={posting}
        onPost={postReview}
        onClose={() => setComposing(false)}
      />
    </View>
  );
}

/** One drink on a local menu: the café, the menu's price, and why it's here. */
function DrinkTrendCard({ card, icon, onPress }) {
  const price = card.priceUsd ?? card.prices?.find((p) => typeof p?.usd === "number")?.usd;
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [styles.trendCard, pressed && styles.pressed]}
      accessibilityRole="button"
      accessibilityLabel={`${card.itemName} at ${card.cafeName}${
        typeof price === "number" ? `, ${formatPrice(price)}` : ""
      }. ${card.why ?? ""}`}
    >
      <View style={styles.trendIcon}>
        <Ionicons name={icon} size={22} color={Palette.primary} />
      </View>
      <Text style={styles.trendName} numberOfLines={2}>
        {card.itemName}
      </Text>
      <View style={styles.trendLoc}>
        <Ionicons name="location-outline" size={11} color={Palette.onSurfaceVariant} />
        <Text style={styles.trendLocText} numberOfLines={1}>
          {card.cafeName}
          {card.distanceLabel ? ` · ${card.distanceLabel}` : ""}
        </Text>
      </View>
      {typeof price === "number" ? (
        <Text style={styles.trendPrice}>{formatPrice(price)}</Text>
      ) : null}
      {card.why ? (
        <Text style={styles.trendWhy} numberOfLines={3}>
          {card.why}
        </Text>
      ) : null}
    </Pressable>
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

  scroll: {
    paddingHorizontal: Spacing.marginMain,
    paddingBottom: 110,
  },
  sectionTitle: {
    ...Typography.headlineSm,
    color: Palette.primary,
    marginTop: Spacing.sm,
    marginBottom: Spacing.sm,
  },

  trendingRow: {
    gap: 14,
    paddingRight: Spacing.marginMain,
    paddingBottom: 4,
  },
  trendCard: {
    width: 168,
    backgroundColor: Palette.surfaceContainerLowest,
    borderRadius: Radius.lg,
    padding: 12,
    borderWidth: 1,
    borderColor: "rgba(211,195,192,0.4)",
  },
  trendIcon: {
    width: 44,
    height: 44,
    borderRadius: Radius.md,
    backgroundColor: Palette.secondaryContainer,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 8,
  },
  trendName: {
    fontFamily: "Montserrat_600SemiBold",
    fontSize: 14,
    lineHeight: 18,
    color: Palette.onSurface,
  },
  trendLoc: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    marginTop: 5,
  },
  trendLocText: {
    ...Typography.labelMd,
    fontSize: 11,
    color: Palette.onSurfaceVariant,
    flexShrink: 1,
  },
  trendPrice: {
    ...Typography.labelMd,
    fontSize: 13,
    fontFamily: "PlusJakartaSans_600SemiBold",
    color: Palette.secondary,
    marginTop: 6,
    fontVariant: ["tabular-nums"],
  },
  trendWhy: {
    ...Typography.labelMd,
    fontSize: 11,
    lineHeight: 15,
    color: Palette.onSurfaceVariant,
    marginTop: 4,
  },
  emptyLine: {
    ...Typography.bodySm,
    color: Palette.onSurfaceVariant,
    marginBottom: Spacing.sm,
  },

  sectionRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginTop: Spacing.sm,
    marginBottom: Spacing.sm,
  },
  sectionTitleInRow: { marginTop: 0, marginBottom: 0 },
  writeBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    minHeight: 36,
    paddingHorizontal: 14,
    borderRadius: Radius.full,
    backgroundColor: Palette.secondaryContainer,
  },
  writeBtnText: {
    ...Typography.labelMd,
    fontFamily: "PlusJakartaSans_600SemiBold",
    color: Palette.onSecondaryContainer,
  },
  feedList: {
    gap: Spacing.sm,
    marginTop: Spacing.xs,
  },
  pressed: {
    transform: [{ scale: 0.96 }],
    opacity: 0.9,
  },
});
