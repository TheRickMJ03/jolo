import { StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { Palette } from "@/constants/Colors";
import { Radius, Typography } from "@/constants/Typography";
import { formatReviewTime } from "@/lib/reviews";

/** Five stars, the first `rating` of them filled. */
export function Stars({ rating, size = 13 }) {
  return (
    <View
      style={styles.stars}
      accessible
      accessibilityLabel={`${rating} out of 5 stars`}
      accessibilityRole="image"
    >
      {[1, 2, 3, 4, 5].map((n) => (
        <Ionicons
          key={n}
          name="star"
          size={size}
          color={n <= rating ? Palette.secondary : Palette.surfaceContainerHigh}
        />
      ))}
    </View>
  );
}

/** One review. showCafe: false on the owner's tab, where every review is about their café. */
export function ReviewCard({ review, showCafe = true, now }) {
  const time = formatReviewTime(review.createdAt, now);
  return (
    <View style={styles.card}>
      <View style={styles.head}>
        <View style={styles.avatar}>
          <Ionicons name="person" size={16} color={Palette.primary} />
        </View>
        <View style={styles.who}>
          <Text style={styles.user} numberOfLines={1}>
            {review.user}
          </Text>
          <Text style={styles.time}>
            {time}
            {review.source === "imessage" ? " · via iMessage" : ""}
          </Text>
        </View>
        <Stars rating={review.rating} />
      </View>
      {review.comment ? <Text style={styles.comment}>{review.comment}</Text> : null}
      {showCafe ? (
        <View style={styles.loc}>
          <Ionicons name="location-outline" size={11} color={Palette.onSurfaceVariant} />
          <Text style={styles.locText}>{review.cafeName}</Text>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: Palette.surfaceContainerLowest,
    borderRadius: Radius.lg,
    padding: 16,
    borderWidth: 1,
    borderColor: "rgba(211,195,192,0.4)",
  },
  head: { flexDirection: "row", alignItems: "center", gap: 10 },
  avatar: {
    width: 36,
    height: 36,
    borderRadius: Radius.full,
    backgroundColor: Palette.secondaryContainer,
    alignItems: "center",
    justifyContent: "center",
  },
  who: { flex: 1 },
  user: { fontFamily: "PlusJakartaSans_600SemiBold", fontSize: 13, color: Palette.onSurface },
  time: { ...Typography.labelMd, fontSize: 11, color: Palette.onSurfaceVariant, marginTop: 1 },
  stars: { flexDirection: "row", gap: 2 },
  comment: { ...Typography.bodySm, lineHeight: 19, color: Palette.onSurface, marginTop: 10 },
  loc: { flexDirection: "row", alignItems: "center", gap: 4, marginTop: 10 },
  locText: { ...Typography.labelMd, fontSize: 11, color: Palette.onSurfaceVariant },
});
