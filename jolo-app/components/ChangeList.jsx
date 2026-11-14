import { StyleSheet, Text, View } from "react-native";
import { Palette } from "@/constants/Colors";
import { Typography } from "@/constants/Typography";
import { changeLines } from "@/lib/menu";

// Same + • – symbols as the iMessage confirmation, so owners see one language.
// Colour is never the only signal: the symbol says it too.
const COLORS = {
  added: Palette.onSecondaryContainer,
  changed: Palette.secondary,
  removed: Palette.error,
};

export function ChangeList({ changes, max = Infinity }) {
  const lines = changeLines(changes);
  const shown = lines.slice(0, max);
  if (lines.length === 0) return <Text style={styles.none}>No changes</Text>;
  return (
    <View style={styles.list}>
      {shown.map((line, i) => (
        <Text key={i} style={[styles.line, { color: COLORS[line.kind] }]}>
          {line.text}
        </Text>
      ))}
      {lines.length > shown.length ? (
        <Text style={styles.more}>…and {lines.length - shown.length} more</Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  list: { gap: 2 },
  line: { ...Typography.bodySm },
  more: { ...Typography.labelMd, color: Palette.onSurfaceVariant },
  none: { ...Typography.bodySm, color: Palette.onSurfaceVariant },
});
