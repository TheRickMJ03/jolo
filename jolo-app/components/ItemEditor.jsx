import { useEffect, useState } from "react";
import {
  KeyboardAvoidingView,
  Modal,
  Platform,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from "react-native";
import { Palette } from "@/constants/Colors";
import { Radius, Spacing, Typography } from "@/constants/Typography";
import { parsePriceInput, validateItem } from "@/lib/menu";
import { Banner } from "./Banner";
import { Button } from "./Button";

const priceText = (cents) => (typeof cents === "number" ? (cents / 100).toFixed(2) : "");

/**
 * Add or edit one item. `item` null = closed; an item without an id = new.
 * onSave gets the edited fields; onRemove deletes it (existing items only).
 */
export function ItemEditor({ item, onSave, onRemove, onClose }) {
  const [name, setName] = useState("");
  const [price, setPrice] = useState("");
  const [category, setCategory] = useState("");
  const [description, setDescription] = useState("");
  const [available, setAvailable] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!item) return;
    setName(item.name ?? "");
    setPrice(priceText(item.priceCents));
    setCategory(item.category ?? "");
    setDescription(item.description ?? "");
    setAvailable(item.available !== false);
    setError(null);
  }, [item]);

  const isNew = !item?.id;

  const save = () => {
    const priceCents = parsePriceInput(price);
    if (priceCents === undefined) {
      setError("Enter a price like 4.75, or leave it empty.");
      return;
    }
    const edited = { ...item, name: name.trim(), priceCents, category, description, available };
    const [problem] = validateItem(edited);
    if (problem) {
      setError(problem);
      return;
    }
    onSave(edited);
  };

  return (
    <Modal
      visible={Boolean(item)}
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
            {isNew ? "New item" : "Edit item"}
          </Text>
          <Button label="Done" variant="ghost" onPress={save} />
        </View>

        <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
          <Field label="Name">
            <TextInput
              style={styles.input}
              value={name}
              onChangeText={setName}
              placeholder="Cortado"
              placeholderTextColor={Palette.outline}
              autoFocus={isNew}
              accessibilityLabel="Name"
            />
          </Field>
          <Field label="Price">
            <View style={styles.priceRow}>
              <Text style={styles.currency}>$</Text>
              <TextInput
                style={[styles.input, styles.priceInput]}
                value={price}
                onChangeText={setPrice}
                placeholder="4.75"
                placeholderTextColor={Palette.outline}
                keyboardType="decimal-pad"
                accessibilityLabel="Price in dollars"
              />
            </View>
          </Field>
          <Field label="Category (optional)">
            <TextInput
              style={styles.input}
              value={category}
              onChangeText={setCategory}
              placeholder="Coffee"
              placeholderTextColor={Palette.outline}
              accessibilityLabel="Category"
            />
          </Field>
          <Field label="Description (optional)">
            <TextInput
              style={[styles.input, styles.multiline]}
              value={description}
              onChangeText={setDescription}
              placeholder="Equal parts espresso and steamed milk"
              placeholderTextColor={Palette.outline}
              multiline
              accessibilityLabel="Description"
            />
          </Field>
          <View style={styles.switchRow}>
            <Text style={styles.switchLabel}>Available today</Text>
            <Switch
              value={available}
              onValueChange={setAvailable}
              trackColor={{ true: Palette.secondary, false: Palette.outlineVariant }}
              accessibilityLabel="Available today"
            />
          </View>

          {error ? <Banner kind="error">{error}</Banner> : null}

          <Button label={isNew ? "Add to menu" : "Save item"} onPress={save} />
          {!isNew ? (
            <Button label="Remove from menu" variant="outline" onPress={() => onRemove(item)} />
          ) : null}
        </ScrollView>
      </KeyboardAvoidingView>
    </Modal>
  );
}

function Field({ label, children }) {
  return (
    <View style={styles.field}>
      <Text style={styles.fieldLabel}>{label}</Text>
      {children}
    </View>
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
  fieldLabel: { ...Typography.labelMd, color: Palette.onSurfaceVariant },
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
  multiline: { minHeight: 80, textAlignVertical: "top" },
  priceRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  currency: { ...Typography.headlineSm, color: Palette.onSurfaceVariant },
  priceInput: { flex: 1, fontVariant: ["tabular-nums"] },
  switchRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  switchLabel: { ...Typography.bodyMd, color: Palette.onSurface },
});
