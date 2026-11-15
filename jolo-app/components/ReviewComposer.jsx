import { useEffect, useMemo, useState } from "react";
import {
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { Palette } from "@/constants/Colors";
import { Radius, Spacing, Typography } from "@/constants/Typography";
import { MAX_COMMENT, validateReview } from "@/lib/reviews";
import { Banner } from "./Banner";
import { Button } from "./Button";

const MATCHES_SHOWN = 6;

/**
 * Write a review: pick the café, tap 1–5 stars, add a comment (optional).
 * onPost({ cafe, rating, comment }) saves it and may throw; the sheet stays
 * open with the error so nothing typed is lost.
 */
export function ReviewComposer({ visible, cafes, onPost, onClose, posting = false }) {
  const [search, setSearch] = useState("");
  const [cafe, setCafe] = useState(null);
  const [rating, setRating] = useState(0);
  const [comment, setComment] = useState("");
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!visible) return;
    setSearch("");
    setCafe(null);
    setRating(0);
    setComment("");
    setError(null);
  }, [visible]);

  const matches = useMemo(() => {
    const needle = search.trim().toLowerCase();
    const list = (cafes ?? []).filter((c) => !needle || c.name.toLowerCase().includes(needle));
    return list.sort((a, b) => a.name.localeCompare(b.name)).slice(0, MATCHES_SHOWN);
  }, [cafes, search]);

  const post = async () => {
    const problem = validateReview({ cafe, rating, comment });
    if (problem) {
      setError(problem);
      return;
    }
    setError(null);
    try {
      await onPost({ cafe, rating, comment: comment.trim() });
    } catch (postError) {
      console.warn(`[jolo] review not posted: ${postError?.message ?? postError}`);
      setError("Couldn't post your review. Check your connection and try again.");
    }
  };

  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={onClose}
    >
      <KeyboardAvoidingView
        style={styles.root}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <View style={styles.header}>
          <Button label="Cancel" variant="ghost" onPress={onClose} />
          <Text style={styles.title} accessibilityRole="header">
            Write a review
          </Text>
          <Button label="Post" variant="ghost" onPress={post} busy={posting} />
        </View>

        <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
          {error ? <Banner kind="error">{error}</Banner> : null}

          <View style={styles.field}>
            <Text style={styles.label}>Café</Text>
            {cafe ? (
              <Pressable
                style={styles.picked}
                onPress={() => setCafe(null)}
                accessibilityRole="button"
                accessibilityLabel={`${cafe.name}. Change café`}
              >
                <Ionicons name="cafe" size={16} color={Palette.secondary} />
                <Text style={styles.pickedName} numberOfLines={1}>
                  {cafe.name}
                </Text>
                <Text style={styles.change}>Change</Text>
              </Pressable>
            ) : (
              <>
                <TextInput
                  style={styles.input}
                  value={search}
                  onChangeText={setSearch}
                  placeholder="Search cafés"
                  placeholderTextColor={Palette.outline}
                  accessibilityLabel="Search cafés"
                  autoCorrect={false}
                />
                {matches.length === 0 ? (
                  <Text style={styles.hint}>No café by that name on JOLO yet.</Text>
                ) : (
                  <View style={styles.matches}>
                    {matches.map((c) => (
                      <Pressable
                        key={c.id}
                        style={({ pressed }) => [styles.match, pressed && styles.pressed]}
                        onPress={() => setCafe(c)}
                        accessibilityRole="button"
                        accessibilityLabel={c.name}
                      >
                        <Text style={styles.matchName} numberOfLines={1}>
                          {c.name}
                        </Text>
                        {c.municipality || c.address ? (
                          <Text style={styles.matchWhere} numberOfLines={1}>
                            {c.municipality || c.address}
                          </Text>
                        ) : null}
                      </Pressable>
                    ))}
                  </View>
                )}
              </>
            )}
          </View>

          <View style={styles.field}>
            <Text style={styles.label}>Rating</Text>
            <View style={styles.starRow}>
              {[1, 2, 3, 4, 5].map((n) => (
                <Pressable
                  key={n}
                  onPress={() => setRating(n)}
                  hitSlop={6}
                  accessibilityRole="button"
                  accessibilityLabel={`${n} star${n === 1 ? "" : "s"}`}
                  accessibilityState={{ selected: rating === n }}
                >
                  <Ionicons
                    name={n <= rating ? "star" : "star-outline"}
                    size={34}
                    color={n <= rating ? Palette.secondary : Palette.outline}
                  />
                </Pressable>
              ))}
            </View>
          </View>

          <View style={styles.field}>
            <Text style={styles.label}>Comment</Text>
            <TextInput
              style={[styles.input, styles.comment]}
              value={comment}
              onChangeText={setComment}
              placeholder="What did you order? How was it?"
              placeholderTextColor={Palette.outline}
              multiline
              maxLength={MAX_COMMENT}
              accessibilityLabel="Comment"
            />
            <Text style={styles.count}>
              {comment.length}/{MAX_COMMENT}
            </Text>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: Palette.background },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: Spacing.sm,
    paddingTop: Spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: Palette.outlineVariant,
  },
  title: { ...Typography.headlineSm, color: Palette.onSurface },
  body: { padding: Spacing.marginMain, gap: Spacing.stackMd },
  field: { gap: 6 },
  label: { ...Typography.labelMd, color: Palette.onSurfaceVariant },
  input: {
    ...Typography.bodyMd,
    color: Palette.onSurface,
    backgroundColor: Palette.surfaceContainerLowest,
    borderWidth: 1,
    borderColor: "rgba(129,116,113,0.4)",
    borderRadius: Radius.md,
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  hint: { ...Typography.bodySm, color: Palette.onSurfaceVariant },
  matches: {
    borderWidth: 1,
    borderColor: "rgba(211,195,192,0.6)",
    borderRadius: Radius.md,
    overflow: "hidden",
  },
  match: {
    paddingHorizontal: 16,
    paddingVertical: 10,
    backgroundColor: Palette.surfaceContainerLowest,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: Palette.outlineVariant,
  },
  matchName: { ...Typography.bodyMd, color: Palette.onSurface },
  matchWhere: { ...Typography.labelMd, fontSize: 11, color: Palette.onSurfaceVariant },
  picked: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 16,
    minHeight: 48,
    borderRadius: Radius.md,
    backgroundColor: Palette.secondaryContainer,
  },
  pickedName: { ...Typography.bodyMd, flex: 1, color: Palette.onSecondaryContainer },
  change: { ...Typography.labelMd, color: Palette.secondary },
  starRow: { flexDirection: "row", gap: 10 },
  comment: { minHeight: 120, textAlignVertical: "top" },
  count: {
    ...Typography.labelMd,
    fontSize: 11,
    color: Palette.onSurfaceVariant,
    alignSelf: "flex-end",
  },
  pressed: { opacity: 0.7 },
});
