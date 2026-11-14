import { Pressable, StyleSheet, Switch, Text, View } from "react-native";
import { Palette } from "@/constants/Colors";
import { Spacing, Typography } from "@/constants/Typography";
import { formatPrice, formatPrices, needsCheck } from "@/lib/menu";

/**
 * One menu item: tap to edit, switch for sold out. Prices right-aligned and
 * tabular, one line per size. "Check this" marks an item the menu reader
 * wasn't sure of, until the owner edits or confirms it.
 */
export function MenuItemRow({ item, onPress, onToggleAvailable, edited }) {
  const soldOut = item.available === false;
  const check = needsCheck(item);
  const prices = item.prices ?? [];
  return (
    <View style={styles.row}>
      <Pressable
        style={({ pressed }) => [styles.main, pressed && styles.pressed]}
        onPress={onPress}
        accessibilityRole="button"
        accessibilityLabel={`${item.item}, ${formatPrices(prices)}${soldOut ? ", sold out" : ""}${check ? ", check this" : ""}`}
        accessibilityHint="Edit this item"
      >
        <View style={styles.text}>
          <Text style={[styles.name, soldOut && styles.soldOutText]} numberOfLines={2}>
            {item.item}
            {edited ? <Text style={styles.edited}> • edited</Text> : null}
          </Text>
          {check ? <Text style={styles.check}>Check this</Text> : null}
          {soldOut ? <Text style={styles.soldOutLabel}>Sold out</Text> : null}
        </View>
        <View style={styles.prices}>
          {prices.length === 0 ? (
            <Text style={[styles.price, styles.noPrice]}>No price</Text>
          ) : (
            prices.map((price, i) => (
              <Text key={i} style={[styles.price, soldOut && styles.soldOutText]}>
                {price.size ? <Text style={styles.size}>{price.size} </Text> : null}
                {formatPrice(price.usd)}
              </Text>
            ))
          )}
        </View>
      </Pressable>
      <Switch
        value={!soldOut}
        onValueChange={(value) => onToggleAvailable(value)}
        trackColor={{ true: Palette.secondary, false: Palette.outlineVariant }}
        accessibilityLabel={`${item.item} available`}
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
  check: { ...Typography.labelMd, color: Palette.secondary },
  soldOutLabel: { ...Typography.labelMd, color: Palette.error },
  soldOutText: { color: Palette.outline },
  prices: { alignItems: "flex-end", minWidth: 64 },
  price: {
    ...Typography.bodyMd,
    color: Palette.onSurface,
    fontVariant: ["tabular-nums"],
    textAlign: "right",
  },
  size: { ...Typography.bodySm, color: Palette.onSurfaceVariant },
  noPrice: { color: Palette.outline },
  pressed: { opacity: 0.7 },
});
