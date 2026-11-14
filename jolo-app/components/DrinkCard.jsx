import { Pressable, StyleSheet, Text, View } from "react-native";
import { Button } from "@/components/Button";
import { Palette } from "@/constants/Colors";
import { Radius, Spacing, Typography } from "@/constants/Typography";
import { formatPrice } from "@/lib/menu";

/**
 * One orderable drink. The price column is the menu's prices, right-aligned.
 * Tapping the drink records an open; the buttons record save, order, dismiss.
 */
export function DrinkCard({ card, onOpen, onSave, onOrder, onDismiss, showDismiss = true }) {
  const prices = card.prices ?? [];
  return (
    <View style={styles.card}>
      <Pressable
        onPress={onOpen}
        accessibilityRole="button"
        accessibilityLabel={`${card.itemName} at ${card.cafeName}, ${card.priceLabel}`}
        accessibilityHint="Opens this recommendation"
        style={({ pressed }) => [styles.main, pressed && styles.pressed]}
      >
        <View style={styles.text}>
          <Text style={styles.name}>{card.itemName}</Text>
          <Text style={styles.meta}>
            {card.cafeName}
            {card.updatedLabel ? ` · ${card.updatedLabel}` : ""}
          </Text>
        </View>
        <View style={styles.prices}>
          {prices.length === 0 ? (
            <Text style={[styles.price, styles.noPrice]}>No price</Text>
          ) : (
            prices.map((price, index) => (
              <Text key={index} style={styles.price}>
                {price.size ? <Text style={styles.size}>{price.size} </Text> : null}
                {formatPrice(price.usd)}
              </Text>
            ))
          )}
        </View>
      </Pressable>
      {card.why ? <Text style={styles.why}>{card.why}</Text> : null}
      {card.ordered ? <Text style={styles.ordered}>You ordered this</Text> : null}
      <View style={styles.actions}>
        {card.ordered ? null : (
          <Button label="I ordered this" onPress={onOrder} style={styles.order} />
        )}
        <View style={styles.secondary}>
          <Button
            label={card.saved ? "Saved" : "Save"}
            variant="outline"
            onPress={onSave}
            accessibilityHint={card.saved ? "Remove this drink from Saved" : "Save this drink"}
          />
          {showDismiss && onDismiss ? (
            <Button label="Not for me" variant="ghost" onPress={onDismiss} />
          ) : null}
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: Palette.surfaceContainerLow,
    borderRadius: Radius.lg,
    padding: Spacing.cardPadding,
    gap: Spacing.sm,
  },
  main: { flexDirection: "row", alignItems: "flex-start", gap: Spacing.sm },
  pressed: { opacity: 0.7 },
  text: { flex: 1, gap: 2 },
  name: { ...Typography.headlineSm, color: Palette.onSurface },
  meta: { ...Typography.bodySm, color: Palette.onSurfaceVariant },
  prices: { alignItems: "flex-end", minWidth: 72 },
  price: {
    ...Typography.bodyMd,
    color: Palette.primary,
    fontFamily: "PlusJakartaSans_600SemiBold",
    fontVariant: ["tabular-nums"],
    textAlign: "right",
  },
  size: { ...Typography.labelMd, color: Palette.onSurfaceVariant },
  noPrice: { color: Palette.outline },
  why: { ...Typography.bodyMd, color: Palette.onSurface },
  ordered: { ...Typography.labelMd, color: Palette.secondary },
  actions: { gap: Spacing.xs },
  order: { alignSelf: "stretch" },
  secondary: { flexDirection: "row", flexWrap: "wrap", gap: Spacing.xs, alignItems: "center" },
});
