import { useEffect, useState } from "react";
import {
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from "react-native";
import { Palette } from "@/constants/Colors";
import { Radius, Spacing, Typography } from "@/constants/Typography";
import {
  CATEGORIES,
  CATEGORY_LABELS,
  MAX_SIZES,
  needsCheck,
  parsePriceInput,
  validateItem,
} from "@/lib/menu";
import { Banner } from "./Banner";
import { Button } from "./Button";

const EMPTY_ROW = { size: "", price: "" };
const toRows = (prices) =>
  prices?.length
    ? prices.map((price) => ({ size: price.size ?? "", price: price.usd.toFixed(2) }))
    : [EMPTY_ROW];

/**
 * Add or edit one item. `item` null = closed; an item without an id = new.
 * onSave gets the edited fields; onRemove deletes it (existing items only).
 *
 * Prices are one row per size, because that is how the menu reader returns
 * them and size names are what it gets wrong most often.
 */
export function ItemEditor({ item, onSave, onRemove, onClose }) {
  const [name, setName] = useState("");
  const [section, setSection] = useState("");
  const [category, setCategory] = useState("drink");
  const [rows, setRows] = useState([EMPTY_ROW]);
  const [available, setAvailable] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!item) return;
    setName(item.item ?? "");
    setSection(item.section ?? "");
    setCategory(CATEGORIES.includes(item.category) ? item.category : "drink");
    setRows(toRows(item.prices));
    setAvailable(item.available !== false);
    setError(null);
  }, [item]);

  const isNew = !item?.id;
  const setRow = (index, patch) =>
    setRows(rows.map((row, i) => (i === index ? { ...row, ...patch } : row)));

  const save = () => {
    const prices = [];
    for (const row of rows) {
      const size = row.size.trim();
      const usd = parsePriceInput(row.price);
      if (usd === undefined) {
        setError("Enter a price like 4.75, or leave it empty.");
        return;
      }
      if (usd === null) {
        if (!size) continue; // an empty row: no price for this item
        setError(`Enter a price for ${size}, or remove that size.`);
        return;
      }
      prices.push({ size: size || null, usd });
    }
    // Saving from here means the owner has looked at it, so it no longer needs a check.
    const edited = {
      ...item,
      item: name.trim(),
      section,
      category,
      prices,
      available,
      confidence: 1,
    };
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
          {item && needsCheck(item) ? (
            <Banner kind="info">
              JOLO wasn't sure it read this one right. Check it against your menu, then save.
            </Banner>
          ) : null}

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

          <Field label={rows.length > 1 ? "Sizes and prices" : "Price"}>
            {rows.map((row, i) => {
              const nth = i === 0 ? "" : ` ${i + 1}`;
              return (
                <View key={i} style={styles.priceRow}>
                  <TextInput
                    style={[styles.input, styles.sizeInput]}
                    value={row.size}
                    onChangeText={(size) => setRow(i, { size })}
                    placeholder={rows.length > 1 ? "12 oz" : "Size (optional)"}
                    placeholderTextColor={Palette.outline}
                    accessibilityLabel={`Size${nth}`}
                  />
                  <Text style={styles.currency}>$</Text>
                  <TextInput
                    style={[styles.input, styles.priceInput]}
                    value={row.price}
                    onChangeText={(price) => setRow(i, { price })}
                    placeholder="4.75"
                    placeholderTextColor={Palette.outline}
                    keyboardType="decimal-pad"
                    accessibilityLabel={`Price${nth} in dollars`}
                  />
                  {rows.length > 1 ? (
                    <Pressable
                      style={styles.removeSize}
                      onPress={() => setRows(rows.filter((_, j) => j !== i))}
                      accessibilityRole="button"
                      accessibilityLabel={`Remove size${nth}`}
                      hitSlop={8}
                    >
                      <Text style={styles.removeSizeText}>✕</Text>
                    </Pressable>
                  ) : null}
                </View>
              );
            })}
            {rows.length < MAX_SIZES ? (
              <Button
                label="Add a size"
                variant="ghost"
                onPress={() => setRows([...rows, EMPTY_ROW])}
                style={styles.addSize}
              />
            ) : null}
          </Field>

          <Field label="Section (optional)">
            <TextInput
              style={styles.input}
              value={section}
              onChangeText={setSection}
              placeholder="Espresso"
              placeholderTextColor={Palette.outline}
              accessibilityLabel="Section"
            />
          </Field>

          <Field label="Type">
            <View style={styles.chips} accessibilityRole="radiogroup">
              {CATEGORIES.map((value) => {
                const selected = value === category;
                return (
                  <Pressable
                    key={value}
                    style={[styles.chip, selected && styles.chipSelected]}
                    onPress={() => setCategory(value)}
                    accessibilityRole="radio"
                    accessibilityState={{ selected }}
                    accessibilityLabel={CATEGORY_LABELS[value]}
                  >
                    <Text style={[styles.chipText, selected && styles.chipTextSelected]}>
                      {CATEGORY_LABELS[value]}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
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
  priceRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  sizeInput: { flex: 1 },
  currency: { ...Typography.headlineSm, color: Palette.onSurfaceVariant },
  priceInput: { width: 104, fontVariant: ["tabular-nums"] },
  removeSize: { width: 32, height: 44, alignItems: "center", justifyContent: "center" },
  removeSizeText: { ...Typography.bodyMd, color: Palette.onSurfaceVariant },
  addSize: { alignSelf: "flex-start" },
  chips: { flexDirection: "row", gap: 8 },
  chip: {
    flex: 1,
    minHeight: 44,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: Radius.md,
    borderWidth: 1,
    borderColor: "rgba(129,116,113,0.4)",
    backgroundColor: Palette.surfaceContainerLowest,
  },
  chipSelected: { backgroundColor: Palette.secondary, borderColor: Palette.secondary },
  chipText: { ...Typography.bodyMd, color: Palette.onSurface },
  chipTextSelected: { color: Palette.onSecondary, fontFamily: "PlusJakartaSans_600SemiBold" },
  switchRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  switchLabel: { ...Typography.bodyMd, color: Palette.onSurface },
});
