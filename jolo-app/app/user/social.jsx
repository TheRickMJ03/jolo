import { useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import BottomSheet, { BottomSheetScrollView } from "@gorhom/bottom-sheet";
import { NotificationsPanel } from "@/components/NotificationsPanel";
import { Palette } from "@/constants/Colors";
import { Radius, Spacing, Typography } from "@/constants/Typography";
import { useAreaTrends } from "@/hooks/useAreaTrends";
import { useForYou } from "@/hooks/useForYou";
import { useAuth } from "@/lib/auth";
import { formatPrice } from "@/lib/menu";

const INITIAL_POSTS = [
  {
    id: "p1",
    user: "Priya S.",
    drink: "Oat Milk Cortado",
    rating: 5,
    comment: "Best cortado in the city, no contest. The oat milk here is perfectly steamed.",
    location: "Bean & Leaf - Westside",
    time: "12 min ago",
  },
  {
    id: "p2",
    user: "Marcus T.",
    drink: "Vanilla Latte",
    rating: 4,
    comment: "Solid go-to pick. A little sweet for me but great texture.",
    location: "Aroma & Crema - Downtown",
    time: "48 min ago",
  },
  {
    id: "p3",
    user: "Elena R.",
    drink: "Caramel Cold Brew",
    rating: 5,
    comment: "Perfect for a hot afternoon. Will be back for this one all summer.",
    location: "The Roastery Lab",
    time: "2h ago",
  },
];

const DRINKS = ["Latte", "Cappuccino", "Cold Brew", "Matcha"];

const SIGNAL_ICONS = { web: "trending-up", new: "sparkles-outline", asks: "chatbubble-outline" };

export default function SocialView() {
  const { user } = useAuth();
  const area = useAreaTrends();
  // Personal picks come from this person's searches; "personal" shows them when they exist.
  const forYou = useForYou(user, "personal");
  const picks = forYou.source === "personal" ? forYou.cards : [];
  const sheetRef = useRef(null);
  const snapPoints = useMemo(() => ["68%"], []);
  const [notifOpen, setNotifOpen] = useState(false);
  const [posts, setPosts] = useState(INITIAL_POSTS);
  const [draftDrink, setDraftDrink] = useState(null);
  const [draftRating, setDraftRating] = useState(0);
  const [draftComment, setDraftComment] = useState("");
  const [touched, setTouched] = useState(false);

  const openComposer = () => sheetRef.current?.expand();
  const closeComposer = () => sheetRef.current?.close();

  const submitPost = () => {
    if (!draftDrink || draftRating === 0) {
      setTouched(true);
      return;
    }
    setPosts((prev) => [
      {
        id: `p${Date.now()}`,
        user: "You",
        drink: draftDrink,
        rating: draftRating,
        comment: draftComment || "Loved it!",
        location: "Aroma & Crema - Downtown",
        time: "Just now",
      },
      ...prev,
    ]);
    setDraftDrink(null);
    setDraftRating(0);
    setDraftComment("");
    setTouched(false);
    closeComposer();
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
        ) : area.trending.length === 0 ? (
          <Text style={styles.emptyLine}>
            Nothing is trending on local menus yet. Check back after cafés update their menus.
          </Text>
        ) : (
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.trendingRow}
          >
            {area.trending.map((card) => (
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

        <Text style={styles.sectionTitle}>Community Feed</Text>
        <View style={styles.feedList}>
          {posts.map((post) => (
            <View key={post.id} style={styles.postCard}>
              <View style={styles.postHead}>
                <View style={styles.postAvatar}>
                  <Ionicons name="person" size={16} color={Palette.primary} />
                </View>
                <View>
                  <Text style={styles.postUser}>{post.user}</Text>
                  <Text style={styles.postTime}>{post.time}</Text>
                </View>
              </View>
              <View style={styles.postDrinkRow}>
                <View style={styles.postDrink}>
                  <Ionicons name="cafe" size={12} color={Palette.onSecondaryContainer} />
                  <Text style={styles.postDrinkText}>{post.drink}</Text>
                </View>
                <View style={styles.postStars}>
                  {[1, 2, 3, 4, 5].map((n) => (
                    <Ionicons
                      key={n}
                      name="star"
                      size={13}
                      color={n <= post.rating ? Palette.secondary : Palette.surfaceContainerHigh}
                    />
                  ))}
                </View>
              </View>
              <Text style={styles.postComment}>{post.comment}</Text>
              <View style={styles.postLoc}>
                <Ionicons name="location-outline" size={11} color={Palette.onSurfaceVariant} />
                <Text style={styles.postLocText}>{post.location}</Text>
              </View>
            </View>
          ))}
        </View>
      </ScrollView>

      <Pressable
        style={({ pressed }) => [styles.fab, pressed && styles.pressed]}
        onPress={openComposer}
      >
        <Ionicons name="add" size={26} color={Palette.onPrimary} />
      </Pressable>

      <BottomSheet
        ref={sheetRef}
        index={-1}
        snapPoints={snapPoints}
        enablePanDownToClose
        backgroundStyle={styles.sheetBg}
        handleStyle={styles.sheetHandleArea}
        handleIndicatorStyle={styles.handle}
      >
        <BottomSheetScrollView
          contentContainerStyle={styles.composerScroll}
          showsVerticalScrollIndicator={false}
        >
          <View style={styles.drawerHead}>
            <Text style={styles.drawerTitle}>Post a Drink</Text>
            <Pressable onPress={closeComposer} hitSlop={8}>
              <Ionicons name="close" size={20} color={Palette.onSurfaceVariant} />
            </Pressable>
          </View>

          <Text style={styles.fieldLabel}>Drink</Text>
          <View style={styles.chipRow}>
            {DRINKS.map((d) => (
              <Pressable
                key={d}
                onPress={() => setDraftDrink(d)}
                style={({ pressed }) => [
                  styles.chip,
                  draftDrink === d && styles.chipActive,
                  pressed && styles.pressed,
                ]}
              >
                <Text style={[styles.chipLabel, draftDrink === d && styles.chipLabelActive]}>
                  {d}
                </Text>
              </Pressable>
            ))}
          </View>

          <Text style={styles.fieldLabel}>Your Rating</Text>
          <View style={styles.starRow}>
            {[1, 2, 3, 4, 5].map((n) => (
              <Pressable key={n} onPress={() => setDraftRating(n)} hitSlop={4}>
                <Ionicons
                  name="star"
                  size={30}
                  color={n <= draftRating ? Palette.secondary : Palette.surfaceContainerHigh}
                />
              </Pressable>
            ))}
          </View>

          <Text style={styles.fieldLabel}>Comment</Text>
          <TextInput
            style={styles.textarea}
            placeholder="What did you think?"
            placeholderTextColor="rgba(79,68,66,0.5)"
            value={draftComment}
            onChangeText={setDraftComment}
            multiline
          />

          <Text style={styles.fieldLabel}>Posting From</Text>
          <View style={styles.locationChip}>
            <Ionicons name="location-outline" size={13} color={Palette.onSurfaceVariant} />
            <Text style={styles.locationChipText}>Aroma & Crema - Downtown</Text>
          </View>

          {touched && (!draftDrink || draftRating === 0) && (
            <Text style={styles.hint}>Pick a drink and a rating before posting.</Text>
          )}

          <Pressable
            style={({ pressed }) => [styles.postBtn, pressed && styles.pressed]}
            onPress={submitPost}
          >
            <Text style={styles.postBtnLabel}>Post to Feed</Text>
          </Pressable>
        </BottomSheetScrollView>
      </BottomSheet>
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

  feedList: {
    gap: Spacing.sm,
    marginTop: Spacing.xs,
  },
  postCard: {
    backgroundColor: Palette.surfaceContainerLowest,
    borderRadius: Radius.lg,
    padding: 16,
    borderWidth: 1,
    borderColor: "rgba(211,195,192,0.4)",
  },
  postHead: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  postAvatar: {
    width: 36,
    height: 36,
    borderRadius: Radius.full,
    backgroundColor: Palette.secondaryContainer,
    alignItems: "center",
    justifyContent: "center",
  },
  postUser: {
    fontFamily: "PlusJakartaSans_600SemiBold",
    fontSize: 13,
    color: Palette.onSurface,
  },
  postTime: {
    ...Typography.labelMd,
    fontSize: 11,
    color: Palette.onSurfaceVariant,
    marginTop: 1,
  },
  postDrinkRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginTop: 12,
  },
  postDrink: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    backgroundColor: Palette.secondaryContainer,
    paddingHorizontal: 12,
    paddingVertical: 5,
    borderRadius: 9999,
  },
  postDrinkText: {
    ...Typography.labelMd,
    fontFamily: "PlusJakartaSans_600SemiBold",
    color: Palette.onSecondaryContainer,
  },
  postStars: {
    flexDirection: "row",
    gap: 2,
  },
  postComment: {
    ...Typography.bodySm,
    lineHeight: 19,
    color: Palette.onSurface,
    marginTop: 10,
  },
  postLoc: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    marginTop: 10,
  },
  postLocText: {
    ...Typography.labelMd,
    fontSize: 11,
    color: Palette.onSurfaceVariant,
  },

  fab: {
    position: "absolute",
    right: Spacing.marginMain,
    bottom: 104,
    width: 56,
    height: 56,
    borderRadius: Radius.full,
    backgroundColor: Palette.primary,
    alignItems: "center",
    justifyContent: "center",
    shadowColor: "#1e0f0a",
    shadowOpacity: 0.28,
    shadowRadius: 24,
    shadowOffset: { width: 0, height: 10 },
    elevation: 6,
  },

  sheetBg: {
    backgroundColor: Palette.surfaceContainerLowest,
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
  },
  sheetHandleArea: {
    paddingTop: 12,
    paddingBottom: 4,
  },
  handle: {
    width: 48,
    height: 5,
    borderRadius: 9999,
    backgroundColor: Palette.outlineVariant,
  },
  composerScroll: {
    paddingHorizontal: Spacing.marginMain,
    paddingBottom: 32,
  },
  drawerHead: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 16,
  },
  drawerTitle: {
    fontFamily: "Montserrat_700Bold",
    fontSize: 18,
    color: Palette.primary,
  },
  fieldLabel: {
    ...Typography.labelMd,
    fontFamily: "PlusJakartaSans_600SemiBold",
    letterSpacing: 0.5,
    textTransform: "uppercase",
    color: Palette.onSurfaceVariant,
    marginBottom: 8,
    marginTop: 18,
  },
  chipRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
  },
  chip: {
    paddingHorizontal: 15,
    paddingVertical: 9,
    borderRadius: 9999,
    borderWidth: 1,
    borderColor: "rgba(211,195,192,0.6)",
    backgroundColor: Palette.surfaceContainerLowest,
  },
  chipActive: {
    backgroundColor: Palette.primary,
    borderColor: Palette.primary,
  },
  chipLabel: {
    ...Typography.labelMd,
    color: Palette.onSurface,
  },
  chipLabelActive: {
    color: Palette.onPrimary,
  },
  starRow: {
    flexDirection: "row",
    gap: 6,
  },
  textarea: {
    ...Typography.bodyMd,
    fontSize: 14,
    color: Palette.onSurface,
    backgroundColor: Palette.surfaceContainerLowest,
    borderWidth: 1,
    borderColor: "rgba(211,195,192,0.6)",
    borderRadius: Radius.md,
    paddingHorizontal: 14,
    paddingVertical: 12,
    minHeight: 76,
    textAlignVertical: "top",
  },
  locationChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    alignSelf: "flex-start",
    backgroundColor: Palette.surfaceContainer,
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 9999,
  },
  locationChipText: {
    ...Typography.labelMd,
    color: Palette.onSurfaceVariant,
  },
  hint: {
    ...Typography.labelMd,
    fontSize: 11,
    color: Palette.error,
    marginTop: 8,
  },
  postBtn: {
    marginTop: 22,
    backgroundColor: Palette.primary,
    paddingVertical: 15,
    borderRadius: 9999,
    alignItems: "center",
    justifyContent: "center",
  },
  postBtnLabel: {
    ...Typography.labelLg,
    color: Palette.onPrimary,
  },

  pressed: {
    transform: [{ scale: 0.96 }],
    opacity: 0.9,
  },
});
