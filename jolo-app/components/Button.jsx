import { ActivityIndicator, Pressable, StyleSheet, Text } from "react-native";
import { Palette } from "@/constants/Colors";
import { Radius, Typography } from "@/constants/Typography";

/** variant: "primary" (Espresso) | "outline" | "ghost" (text only). */
export function Button({
  label,
  onPress,
  variant = "primary",
  busy = false,
  disabled = false,
  style,
  accessibilityHint,
}) {
  const inactive = busy || disabled;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ disabled: inactive, busy }}
      onPress={onPress}
      disabled={inactive}
      hitSlop={variant === "ghost" ? 8 : 0}
      style={({ pressed }) => [
        styles.base,
        styles[variant],
        pressed && styles.pressed,
        inactive && styles.inactive,
        style,
      ]}
    >
      {busy ? (
        <ActivityIndicator color={variant === "primary" ? Palette.onPrimary : Palette.primary} />
      ) : (
        <Text
          style={[
            styles.label,
            variant === "primary" ? styles.labelOnPrimary : styles.labelPrimary,
          ]}
        >
          {label}
        </Text>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  base: {
    borderRadius: Radius.full,
    alignItems: "center",
    justifyContent: "center",
    minHeight: 48,
  },
  primary: {
    backgroundColor: Palette.primary,
    paddingVertical: 14,
    paddingHorizontal: 20,
  },
  outline: {
    borderWidth: 2,
    borderColor: Palette.primary,
    paddingVertical: 12,
    paddingHorizontal: 20,
  },
  ghost: {
    paddingVertical: 8,
    paddingHorizontal: 8,
    minHeight: 40,
  },
  label: { ...Typography.labelLg },
  labelOnPrimary: { color: Palette.onPrimary },
  labelPrimary: { color: Palette.primary },
  pressed: { transform: [{ scale: 0.97 }], opacity: 0.9 },
  inactive: { opacity: 0.6 },
});
