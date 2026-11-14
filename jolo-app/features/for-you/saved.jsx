import { ActivityIndicator, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Banner } from "@/components/Banner";
import { DrinkCard } from "@/components/DrinkCard";
import { EmptyState } from "@/components/EmptyState";
import { Palette } from "@/constants/Colors";
import { Spacing, Typography } from "@/constants/Typography";
import { useForYouState } from "@/lib/user-session";

export default function SavedScreen() {
  const { loading, error, saved, record } = useForYouState();

  const drinkEvent = (type, card) =>
    record({
      type,
      cafeId: card.cafeId,
      itemId: card.itemId,
      itemName: card.itemName,
    });

  return (
    <SafeAreaView style={styles.root} edges={["top"]}>
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={styles.title} accessibilityRole="header">
          Saved
        </Text>
        {error === "load" ? (
          <Banner kind="error">Couldn't load drinks. Check your connection.</Banner>
        ) : null}
        {error === "save" ? <Banner kind="error">Couldn't save that. Try again.</Banner> : null}
        {loading ? (
          <ActivityIndicator color={Palette.primary} accessibilityLabel="Finding drinks" />
        ) : saved.length === 0 ? (
          <EmptyState icon="bookmark-outline" title="Nothing saved">
            Save a drink from For you and it stays here, with the café and the price from today's
            menu.
          </EmptyState>
        ) : (
          <View style={styles.list}>
            {saved.map((card) => (
              <DrinkCard
                key={`${card.cafeId}:${card.itemId}`}
                card={card}
                showDismiss={false}
                onOpen={() => drinkEvent("open", card)}
                onSave={() => drinkEvent("unsave", card)}
                onOrder={() => drinkEvent("purchase", card)}
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
  content: { padding: Spacing.marginMain, gap: Spacing.stackMd, paddingBottom: 120 },
  title: { ...Typography.headlineLgMobile, color: Palette.primary },
  list: { gap: Spacing.stackMd },
});
