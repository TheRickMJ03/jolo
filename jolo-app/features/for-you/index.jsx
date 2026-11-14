import { useState } from "react";
import { ActivityIndicator, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Banner } from "@/components/Banner";
import { Button } from "@/components/Button";
import { DrinkCard } from "@/components/DrinkCard";
import { EmptyState } from "@/components/EmptyState";
import { Palette } from "@/constants/Colors";
import { Radius, Spacing, Typography } from "@/constants/Typography";
import { CARD_LIMIT, searchDrinks } from "@/lib/recommendations";
import { useForYouState } from "@/lib/user-session";

const HEADINGS = {
  personal: "Picked for you",
  popular: "Popular on fresh menus",
  search: "Matching drinks",
};

export default function ForYouScreen() {
  const { loading, error, source, cards, catalog, record } = useForYouState();
  const [draft, setDraft] = useState("");
  const [submitted, setSubmitted] = useState("");

  const results = submitted ? searchDrinks(catalog, submitted).slice(0, CARD_LIMIT) : cards;
  const heading = submitted ? HEADINGS.search : (HEADINGS[source] ?? HEADINGS.popular);

  const submit = () => {
    const text = draft.trim();
    if (!text) {
      setSubmitted("");
      return;
    }
    setSubmitted(text);
    record({ type: "search", text });
  };

  const drinkEvent = (type, card) =>
    record({
      type,
      cafeId: card.cafeId,
      itemId: card.itemId,
      itemName: card.itemName,
    });

  return (
    <SafeAreaView style={styles.root} edges={["top"]}>
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <Text style={styles.title} accessibilityRole="header">
          For you
        </Text>
        <View style={styles.searchRow}>
          <TextInput
            value={draft}
            onChangeText={setDraft}
            onSubmitEditing={submit}
            placeholder="Try oat milk latte"
            placeholderTextColor={Palette.outline}
            returnKeyType="search"
            accessibilityLabel="Search drinks"
            style={styles.search}
          />
          <Button label="Search" onPress={submit} />
        </View>
        {submitted ? (
          <Button
            label="Clear search"
            variant="ghost"
            onPress={() => {
              setDraft("");
              setSubmitted("");
            }}
            style={styles.clear}
          />
        ) : null}

        {error === "load" ? (
          <Banner kind="error">Couldn't load drinks. Check your connection.</Banner>
        ) : null}
        {error === "save" ? <Banner kind="error">Couldn't save that. Try again.</Banner> : null}

        <Text style={styles.heading}>{heading}</Text>
        {loading ? (
          <ActivityIndicator color={Palette.primary} accessibilityLabel="Finding drinks" />
        ) : results.length === 0 ? (
          <EmptyState
            icon="cafe-outline"
            title={submitted ? "No match on today's menus" : "No drinks yet"}
          >
            {submitted
              ? "That search is saved. It will shape the next set of suggestions."
              : "Cafés publish today's menu by texting JOLO. Your searches and the drinks you mark as ordered tune this list."}
          </EmptyState>
        ) : (
          <View style={styles.list}>
            {results.map((card) => (
              <DrinkCard
                key={`${card.cafeId}:${card.itemId}`}
                card={card}
                onOpen={() => drinkEvent("open", card)}
                onSave={() => drinkEvent(card.saved ? "unsave" : "save", card)}
                onOrder={() => drinkEvent("purchase", card)}
                onDismiss={() => drinkEvent("dismiss", card)}
              />
            ))}
          </View>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: Palette.background },
  content: { padding: Spacing.marginMain, gap: Spacing.stackSm, paddingBottom: 120 },
  title: { ...Typography.headlineLgMobile, color: Palette.primary },
  searchRow: { flexDirection: "row", gap: Spacing.xs, alignItems: "center" },
  search: {
    ...Typography.bodyMd,
    flex: 1,
    color: Palette.onSurface,
    backgroundColor: Palette.surfaceContainerLow,
    borderRadius: Radius.full,
    paddingHorizontal: Spacing.md,
    paddingVertical: 14,
  },
  clear: { alignSelf: "flex-start" },
  heading: { ...Typography.labelLg, color: Palette.secondary, marginTop: Spacing.xs },
  list: { gap: Spacing.stackMd },
});
