// The owner's menu. Live from Firestore: a menu texted in by iMessage appears
// here on its own. Edits collect in a draft, and "Save" writes ONE new version
// (version N+1, the whole menu), exactly like an iMessage update does.
import { useMemo, useState } from "react";
import { ActivityIndicator, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Banner } from "@/components/Banner";
import { Button } from "@/components/Button";
import { ChangeList } from "@/components/ChangeList";
import { EmptyState } from "@/components/EmptyState";
import { ItemEditor } from "@/components/ItemEditor";
import { MenuItemRow } from "@/components/MenuItemRow";
import { Palette } from "@/constants/Colors";
import { Radius, Spacing, Typography } from "@/constants/Typography";
import { useCurrentMenu } from "@/hooks/useMenu";
import { useAuth } from "@/lib/auth";
import { relativeDay } from "@/lib/insights";
import {
  buildNextVersion,
  diffMenus,
  groupBySection,
  hasChanges,
  needsCheck,
  normalizeItem,
  NothingToSaveError,
  uniqueItemId,
} from "@/lib/menu";
import { MenuConflictError, saveMenuVersion } from "@/lib/menu-store";
import { useCafe } from "@/lib/owner-context";

export default function MenuScreen() {
  const cafe = useCafe();
  const { user } = useAuth();
  const { loading, version, error: loadError } = useCurrentMenu(cafe);
  const [draft, setDraft] = useState(null); // null = no unsaved edits
  const [editing, setEditing] = useState(null);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState(null); // { kind, text }

  const saved = useMemo(() => (version?.items ?? []).map(normalizeItem), [version]);
  const items = draft ?? saved;
  const pending = useMemo(() => (draft ? diffMenus(saved, draft) : null), [draft, saved]);
  const editedIds = useMemo(() => {
    if (!draft) return new Set();
    const before = new Map(saved.map((item) => [item.id, JSON.stringify(item)]));
    return new Set(
      draft
        .filter((item) => before.has(item.id) && before.get(item.id) !== JSON.stringify(item))
        .map((item) => item.id),
    );
  }, [draft, saved]);
  const toCheck = items.filter(needsCheck).length;
  const dirty = pending ? hasChanges(pending) : false;

  const update = (next) => {
    setNotice(null);
    setDraft(next);
  };

  const saveItem = (edited) => {
    if (edited.id) {
      update(items.map((item) => (item.id === edited.id ? normalizeItem(edited) : item)));
    } else {
      const id = uniqueItemId(
        edited.item,
        items.map((item) => item.id),
      );
      update([...items, normalizeItem({ ...edited, id })]);
    }
    setEditing(null);
  };

  const removeItem = (target) => {
    update(items.filter((item) => item.id !== target.id));
    setEditing(null);
  };

  const toggle = (target, available) =>
    update(items.map((item) => (item.id === target.id ? { ...item, available } : item)));

  const save = async () => {
    setSaving(true);
    setNotice(null);
    try {
      const next = buildNextVersion({
        currentVersion: cafe.currentMenuVersion,
        currentItems: saved,
        nextItems: draft,
        uid: user.uid,
        phone: user.phoneNumber,
      });
      const number = await saveMenuVersion(cafe.id, next);
      setDraft(null);
      setNotice({ kind: "success", text: `Saved as version ${number}. Customers see it now.` });
    } catch (caught) {
      if (caught instanceof NothingToSaveError) {
        setDraft(null);
      } else if (caught instanceof MenuConflictError) {
        // The draft is kept; the next save is based on the new version.
        setNotice({
          kind: "error",
          text: "Your menu was just updated (maybe by text). Your edits are still here — check them and save again.",
        });
      } else {
        setNotice({ kind: "error", text: caught?.message ?? "Couldn't save. Try again." });
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <SafeAreaView style={styles.root} edges={["top"]}>
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={styles.cafe} accessibilityRole="header">
          {cafe.name}
        </Text>
        {cafe.ownerName ? <Text style={styles.meta}>{cafe.ownerName}</Text> : null}
        {cafe.address ? <Text style={styles.meta}>{cafe.address}</Text> : null}
        <Text style={styles.meta}>
          {cafe.currentMenuVersion > 0
            ? `Version ${cafe.currentMenuVersion}${cafe.menuUpdatedAt ? ` · updated ${relativeDay(cafe.menuUpdatedAt)}` : ""}${version?.source === "imessage" ? " by text" : ""}`
            : "No menu yet"}
        </Text>

        {notice ? <Banner kind={notice.kind}>{notice.text}</Banner> : null}
        {loadError ? (
          <Banner kind="error">Couldn't load your menu. Check your connection.</Banner>
        ) : null}

        {toCheck > 0 ? (
          <Banner kind="info">
            {toCheck === 1
              ? "JOLO wasn't sure about 1 item. It's marked \"Check this\"."
              : `JOLO wasn't sure about ${toCheck} items. They're marked "Check this".`}
          </Banner>
        ) : null}

        {loading ? (
          <ActivityIndicator style={styles.spinner} color={Palette.primary} />
        ) : items.length === 0 ? (
          <EmptyState icon="camera-outline" title="Text us your menu">
            Send a photo of your menu board to JOLO by iMessage and say "update the menu" — or add
            items here.
          </EmptyState>
        ) : (
          groupBySection(items).map(({ section, items: group }) => (
            <View key={section} style={styles.section}>
              <Text style={styles.sectionTitle}>{section}</Text>
              {group.map((item) => (
                <MenuItemRow
                  key={item.id}
                  item={item}
                  edited={editedIds.has(item.id)}
                  onPress={() => setEditing(item)}
                  onToggleAvailable={(available) => toggle(item, available)}
                />
              ))}
            </View>
          ))
        )}

        <Button
          label="Add an item"
          variant="outline"
          onPress={() => setEditing({ item: "", category: "drink", prices: [], available: true })}
          style={styles.add}
        />
      </ScrollView>

      {dirty ? (
        <View style={styles.saveBar} accessibilityLiveRegion="polite">
          <ChangeList changes={pending} max={3} />
          <View style={styles.saveActions}>
            <Button
              label="Discard"
              variant="ghost"
              onPress={() => setDraft(null)}
              disabled={saving}
            />
            <Button label="Save changes" onPress={save} busy={saving} style={styles.saveButton} />
          </View>
        </View>
      ) : null}

      <ItemEditor
        item={editing}
        onSave={saveItem}
        onRemove={removeItem}
        onClose={() => setEditing(null)}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: Palette.background },
  content: { padding: Spacing.marginMain, gap: Spacing.stackSm, paddingBottom: 160 },
  cafe: { ...Typography.headlineLgMobile, color: Palette.primary },
  meta: { ...Typography.bodySm, color: Palette.onSurfaceVariant, marginBottom: Spacing.xs },
  spinner: { marginTop: Spacing.xl },
  section: { marginTop: Spacing.sm },
  sectionTitle: {
    ...Typography.labelLg,
    color: Palette.secondary,
    textTransform: "uppercase",
  },
  add: { marginTop: Spacing.md },
  saveBar: {
    position: "absolute",
    left: Spacing.sm,
    right: Spacing.sm,
    bottom: Spacing.sm,
    padding: Spacing.sm,
    borderRadius: Radius.lg,
    backgroundColor: Palette.surfaceContainerLowest,
    borderWidth: 1,
    borderColor: Palette.outlineVariant,
    gap: Spacing.xs,
    shadowColor: "#100403",
    shadowOpacity: 0.12,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 6 },
    elevation: 6,
  },
  saveActions: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  saveButton: { flex: 1, marginLeft: Spacing.sm },
});
