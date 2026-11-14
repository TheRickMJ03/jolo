import { StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { Palette } from "@/constants/Colors";
import { Radius, Typography } from "@/constants/Typography";

const KINDS = {
  error: { icon: "alert-circle-outline", background: Palette.errorContainer, color: "#410002" },
  success: {
    icon: "checkmark-circle",
    background: Palette.secondaryContainer,
    color: Palette.onSecondaryContainer,
  },
  info: {
    icon: "information-circle-outline",
    background: Palette.surfaceContainer,
    color: Palette.onSurfaceVariant,
  },
};

export function Banner({ kind = "info", children }) {
  const { icon, background, color } = KINDS[kind];
  return (
    <View
      style={[styles.banner, { backgroundColor: background }]}
      accessibilityRole={kind === "error" ? "alert" : "text"}
    >
      <Ionicons name={icon} size={16} color={color} />
      <Text style={[styles.text, { color }]}>{children}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  banner: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: Radius.md,
  },
  text: { ...Typography.labelMd, flexShrink: 1 },
});
