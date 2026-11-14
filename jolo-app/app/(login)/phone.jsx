// Phone sign-in: number → 6-digit code from a text → signed in. Firebase
// verifies the number, so request.auth.token.phone_number can be trusted by
// the Firestore rules that decide who owns which café.
import { useState } from "react";
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { router } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { Banner } from "@/components/Banner";
import { Button } from "@/components/Button";
import { Palette } from "@/constants/Colors";
import { Radius, Spacing, Typography } from "@/constants/Typography";
import { useAuth } from "@/lib/auth";
import { authErrorMessage } from "@/lib/auth-errors";
import { formatPhone, toE164 } from "@/lib/phone";

export default function PhoneSignInScreen() {
  const { sendPhoneCode, confirmPhoneCode } = useAuth();
  const [step, setStep] = useState("number"); // "number" | "code"
  const [number, setNumber] = useState("");
  const [e164, setE164] = useState(null);
  const [code, setCode] = useState("");
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const sendCode = async () => {
    const normalized = toE164(number);
    if (!normalized) {
      setError("Enter a 10-digit US number, or an international one starting with +.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await sendPhoneCode(normalized);
      setE164(normalized);
      setCode("");
      setStep("code");
    } catch (caught) {
      setError(authErrorMessage(caught));
    } finally {
      setBusy(false);
    }
  };

  const confirm = async () => {
    if (!/^\d{6}$/.test(code.trim())) {
      setError("Enter the 6-digit code from the text.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await confirmPhoneCode(code);
      // Signed in: the root layout swaps to the owner dashboard.
    } catch (caught) {
      setError(authErrorMessage(caught));
      setBusy(false);
    }
  };

  return (
    <SafeAreaView style={styles.root} edges={["top", "bottom"]}>
      <View style={styles.header}>
        <Pressable
          style={({ pressed }) => [styles.backBtn, pressed && styles.pressed]}
          onPress={() => (step === "code" ? setStep("number") : router.back())}
          accessibilityRole="button"
          accessibilityLabel="Back"
        >
          <Ionicons name="chevron-back" size={22} color={Palette.primary} />
        </Pressable>
      </View>

      <KeyboardAvoidingView
        style={styles.body}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <View style={styles.iconWrap}>
          <Ionicons
            name={step === "number" ? "phone-portrait-outline" : "chatbubble-ellipses-outline"}
            size={28}
            color={Palette.primary}
          />
        </View>

        {step === "number" ? (
          <>
            <Text style={styles.title} accessibilityRole="header">
              Sign in with your phone
            </Text>
            <Text style={styles.subtitle}>
              Use the number your café is linked to. We'll text you a 6-digit code.
            </Text>
            <Text style={styles.fieldLabel}>Phone number</Text>
            <TextInput
              style={styles.input}
              value={number}
              onChangeText={setNumber}
              placeholder="(908) 555-1234"
              placeholderTextColor="rgba(79,68,66,0.5)"
              keyboardType="phone-pad"
              textContentType="telephoneNumber"
              autoComplete="tel"
              autoFocus
              accessibilityLabel="Phone number"
            />
            {error ? <Banner kind="error">{error}</Banner> : null}
            <Button label="Text me a code" onPress={sendCode} busy={busy} style={styles.cta} />
          </>
        ) : (
          <>
            <Text style={styles.title} accessibilityRole="header">
              Enter the code
            </Text>
            <Text style={styles.subtitle}>We texted a 6-digit code to {formatPhone(e164)}.</Text>
            <Text style={styles.fieldLabel}>Code</Text>
            <TextInput
              style={[styles.input, styles.codeInput]}
              value={code}
              onChangeText={(text) => setCode(text.replace(/\D/g, "").slice(0, 6))}
              placeholder="123456"
              placeholderTextColor="rgba(79,68,66,0.5)"
              keyboardType="number-pad"
              textContentType="oneTimeCode"
              autoComplete="sms-otp"
              autoFocus
              maxLength={6}
              accessibilityLabel="6-digit code"
            />
            {error ? <Banner kind="error">{error}</Banner> : null}
            <Button label="Sign in" onPress={confirm} busy={busy} style={styles.cta} />
            <Button label="Send a new code" variant="ghost" onPress={sendCode} disabled={busy} />
          </>
        )}
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: Palette.background },
  header: { paddingHorizontal: Spacing.marginMain, paddingTop: 8 },
  backBtn: {
    width: 40,
    height: 40,
    borderRadius: Radius.full,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: Palette.surfaceContainer,
  },
  body: {
    flex: 1,
    paddingHorizontal: Spacing.marginMain,
    paddingTop: Spacing.lg,
    gap: Spacing.stackSm,
  },
  iconWrap: {
    width: 56,
    height: 56,
    borderRadius: Radius.full,
    backgroundColor: Palette.secondaryContainer,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: Spacing.xs,
  },
  title: { ...Typography.headlineLgMobile, color: Palette.primary },
  subtitle: { ...Typography.bodyMd, color: Palette.onSurfaceVariant, marginBottom: Spacing.sm },
  fieldLabel: { ...Typography.labelMd, color: Palette.onSurfaceVariant },
  input: {
    ...Typography.bodyLg,
    color: Palette.onSurface,
    backgroundColor: Palette.surfaceContainerLowest,
    borderWidth: 1,
    borderColor: "rgba(211,195,192,0.6)",
    borderRadius: Radius.md,
    paddingHorizontal: 16,
    paddingVertical: 14,
  },
  codeInput: { letterSpacing: 8, fontVariant: ["tabular-nums"] },
  cta: { marginTop: Spacing.sm },
  pressed: { transform: [{ scale: 0.97 }], opacity: 0.9 },
});
