// What customers say about this café: reviews posted in the app's Social tab
// or texted in over iMessage. Live, newest first.
import { useMemo } from "react";
import { ActivityIndicator, FlatList, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Banner } from "@/components/Banner";
import { EmptyState } from "@/components/EmptyState";
import { ReviewCard, Stars } from "@/components/ReviewCard";
import { Palette } from "@/constants/Colors";
import { Radius, Spacing, Typography } from "@/constants/Typography";
import { useReviews } from "@/hooks/useReviews";
import { useCafe } from "@/lib/owner-context";
import { ratingSummary } from "@/lib/reviews";

export default function ReviewsScreen() {
  const cafe = useCafe();
  const { loading, reviews, error } = useReviews({ cafeId: cafe.id });
  const summary = useMemo(() => ratingSummary(reviews), [reviews]);

  return (
    <SafeAreaView style={styles.root} edges={["top"]}>
      <FlatList
        contentContainerStyle={styles.content}
        data={reviews}
        keyExtractor={(review) => review.id}
        ListHeaderComponent={
          <View style={styles.header}>
            <Text style={styles.title} accessibilityRole="header">
              Reviews
            </Text>
            <Text style={styles.subtitle}>
              What customers say about {cafe.name}, in the app and by text.
            </Text>
            {error ? <Banner kind="error">Couldn't load your reviews.</Banner> : null}
            {loading ? <ActivityIndicator color={Palette.primary} /> : null}
            {summary.count > 0 ? <Summary summary={summary} /> : null}
          </View>
        }
        ListEmptyComponent={
          loading || error ? null : (
            <EmptyState icon="star-outline" title="No reviews yet">
              When a customer reviews {cafe.name}, it shows up here right away.
            </EmptyState>
          )
        }
        renderItem={({ item }) => <ReviewCard review={item} showCafe={false} />}
      />
    </SafeAreaView>
  );
}

function Summary({ summary }) {
  const most = Math.max(...summary.byStar, 1);
  return (
    <View style={styles.summary}>
      <View style={styles.average}>
        <Text style={styles.averageNumber}>{summary.average.toFixed(1)}</Text>
        <Stars rating={Math.round(summary.average)} size={14} />
        <Text style={styles.count}>
          {summary.count} review{summary.count === 1 ? "" : "s"}
        </Text>
      </View>
      <View style={styles.bars}>
        {[5, 4, 3, 2, 1].map((star) => {
          const n = summary.byStar[star - 1];
          return (
            <View
              key={star}
              style={styles.barRow}
              accessible
              accessibilityLabel={`${star} stars: ${n}`}
            >
              <Text style={styles.barLabel}>{star}</Text>
              <View style={styles.barTrack}>
                <View style={[styles.barFill, { width: `${(n / most) * 100}%` }]} />
              </View>
              <Text style={styles.barCount}>{n}</Text>
            </View>
          );
        })}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: Palette.background },
  content: { padding: Spacing.marginMain, gap: Spacing.stackSm },
  header: { gap: Spacing.xs, marginBottom: Spacing.xs },
  title: { ...Typography.headlineLgMobile, color: Palette.primary },
  subtitle: { ...Typography.bodySm, color: Palette.onSurfaceVariant },
  summary: {
    flexDirection: "row",
    gap: Spacing.stackMd,
    alignItems: "center",
    backgroundColor: Palette.surfaceContainerLow,
    borderRadius: Radius.lg,
    padding: Spacing.cardPadding,
    marginTop: Spacing.xs,
  },
  average: { alignItems: "center", gap: 4, minWidth: 84 },
  averageNumber: {
    ...Typography.headlineLgMobile,
    color: Palette.primary,
    fontVariant: ["tabular-nums"],
  },
  count: { ...Typography.labelMd, color: Palette.onSurfaceVariant },
  bars: { flex: 1, gap: 4 },
  barRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  barLabel: { ...Typography.labelMd, width: 10, color: Palette.onSurfaceVariant },
  barTrack: {
    flex: 1,
    height: 6,
    borderRadius: Radius.full,
    backgroundColor: Palette.surfaceContainerHigh,
    overflow: "hidden",
  },
  barFill: { height: 6, borderRadius: Radius.full, backgroundColor: Palette.secondary },
  barCount: {
    ...Typography.labelMd,
    width: 24,
    textAlign: "right",
    color: Palette.onSurfaceVariant,
    fontVariant: ["tabular-nums"],
  },
});
