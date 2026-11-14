import { Pressable, StyleSheet, Switch, Text, View } from "react-native";
import { Palette } from "@/constants/Colors";
import { Spacing, Typography } from "@/constants/Typography";
import { formatPrice } from "@/lib/menu";

/** One menu item: tap to edit, switch for sold out. Prices right-aligned, tabular. */
export function MenuItemRow({ item, onPress, onToggleAvailable, edited }) {
  const soldOut = item.available === false;
  return (
    <View style={styles.row}>
      <Pressable
        style={({ pressed }) => [styles.main, pressed && styles.pressed]}
        onPress={onPress}
        accessibilityRole="button"
        accessibilityLabel={`${item.name}, ${formatPrice(item.priceCents)}${soldOut ? ", sold out" : ""}`}
        accessibilityHint="Edit this item"
      >
        <View style={styles.text}>
          <Text style={[styles.name, soldOut && styles.soldOutText]} numberOfLines={2}>
            {item.name}
            {edited ? <Text style={styles.edited}> • edited</Text> : null}
          </Text>
          {item.description ? (
            <Text style={styles.description} numberOfLines={2}>
              {item.description}
            </Text>
          ) : null}
          {soldOut ? <Text style={styles.soldOutLabel}>Sold out</Text> : null}
        </View>
        <Text style={[styles.price, soldOut && styles.soldOutText]}>
          {formatPrice(item.priceCents)}
        </Text>
      </Pressable>
      <Switch
        value={!soldOut}
        onValueChange={(value) => onToggleAvailable(value)}
        trackColor={{ true: Palette.secondary, false: Palette.outlineVariant }}
        accessibilityLabel={`${item.name} available`}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: Spacing.sm,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: Palette.outlineVariant,
  },
  main: { flex: 1, flexDirection: "row", alignItems: "center", gap: Spacing.sm },
  text: { flex: 1, gap: 2 },
  name: {
    ...Typography.bodyMd,
    color: Palette.onSurface,
    fontFamily: "PlusJakartaSans_600SemiBold",
  },
  edited: { ...Typography.labelMd, color: Palette.secondary },
  description: { ...Typography.bodySm, color: Palette.onSurfaceVariant },
  soldOutLabel: { ...Typography.labelMd, color: Palette.error },
  soldOutText: { color: Palette.outline },
  price: {
    ...Typography.bodyMd,
    color: Palette.onSurface,
    fontVariant: ["tabular-nums"],
    minWidth: 64,
    textAlign: "right",
  },
  pressed: { opacity: 0.7 },
});
