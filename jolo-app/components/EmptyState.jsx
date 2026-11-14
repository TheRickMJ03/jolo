import { StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { Palette } from "@/constants/Colors";
import { Radius, Spacing, Typography } from "@/constants/Typography";

export function EmptyState({ icon = "cafe-outline", title, children, action }) {
  return (
    <View style={styles.wrap}>
      <View style={styles.iconWrap}>
        <Ionicons name={icon} size={32} color={Palette.primary} />
      </View>
      <Text style={styles.title} accessibilityRole="header">
        {title}
      </Text>
      {children ? <Text style={styles.body}>{children}</Text> : null}
      {action}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: Spacing.marginMain,
    paddingVertical: Spacing.xl,
    gap: Spacing.stackSm,
  },
  iconWrap: {
    width: 64,
    height: 64,
    borderRadius: Radius.full,
    backgroundColor: Palette.secondaryContainer,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: Spacing.xs,
  },
  title: { ...Typography.headlineSm, color: Palette.onSurface, textAlign: "center" },
  body: { ...Typography.bodyMd, color: Palette.onSurfaceVariant, textAlign: "center" },
});
