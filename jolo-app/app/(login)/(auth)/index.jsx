// Sign-in, adapted from the JOLO app's login screen: phone number first (that's
// how owners are linked to their café), email kept for existing accounts. The
// JOLO app's Google/Apple buttons weren't wired to anything, so they're gone.
import { useState } from "react";
import {
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { router } from "expo-router";
import { BlurView } from "expo-blur";
import { Ionicons } from "@expo/vector-icons";
import { Banner } from "@/components/Banner";
import { Button } from "@/components/Button";
import { Palette } from "@/constants/Colors";
import { Radius, Spacing, Typography } from "@/constants/Typography";
import { useAuth } from "@/lib/auth";
import { authErrorMessage } from "@/lib/auth-errors";

export default function LoginView() {
  const { signIn } = useAuth();
  const [showEmail, setShowEmail] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const handleSignIn = async () => {
    if (!email || !password) {
      setError("Enter your email and password to sign in.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await signIn(email, password);
      // The root layout swaps to the dashboard once the session exists.
    } catch (caught) {
      setError(authErrorMessage(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <SafeAreaView style={styles.root} edges={["top", "bottom"]}>
      <View style={styles.watermark} pointerEvents="none">
        {["J", "O", "L", "O"].map((letter, i) => (
          <Text key={i} style={styles.watermarkLetter}>
            {letter}
          </Text>
        ))}
      </View>

      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
          <View>
            <Text style={styles.brand}>JOLO</Text>
            <Text style={styles.tagline}>Your menu, always up to date.</Text>
          </View>

          <BlurView intensity={30} tint="light" style={styles.card}>
            <Button
              label="Continue with phone number"
              onPress={() => router.push("/phone")}
              accessibilityHint="Sign in with a code texted to your café's phone"
            />
            <Text style={styles.hint}>
              Café owners: use the number your café is linked to on JOLO.
            </Text>

            {showEmail ? (
              <>
                <View style={styles.divider}>
                  <View style={styles.dividerLine} />
                  <Text style={styles.dividerLabel}>or with email</Text>
                  <View style={styles.dividerLine} />
                </View>
                <View style={styles.field}>
                  <Text style={styles.fieldLabel}>Email</Text>
                  <View style={[styles.inputWrap, error && !email && styles.inputWrapError]}>
                    <Ionicons name="mail-outline" size={16} color={Palette.onSurfaceVariant} />
                    <TextInput
                      style={styles.input}
                      placeholder="you@example.com"
                      placeholderTextColor="rgba(79,68,66,0.5)"
                      value={email}
                      onChangeText={setEmail}
                      keyboardType="email-address"
                      autoCapitalize="none"
                      textContentType="emailAddress"
                      autoComplete="email"
                      accessibilityLabel="Email"
                    />
                  </View>
                </View>
                <View style={styles.field}>
                  <Text style={styles.fieldLabel}>Password</Text>
                  <View style={[styles.inputWrap, error && !password && styles.inputWrapError]}>
                    <Ionicons
                      name="lock-closed-outline"
                      size={16}
                      color={Palette.onSurfaceVariant}
                    />
                    <TextInput
                      style={styles.input}
                      placeholder="Your password"
                      placeholderTextColor="rgba(79,68,66,0.5)"
                      value={password}
                      onChangeText={setPassword}
                      secureTextEntry
                      textContentType="password"
                      autoComplete="password"
                      accessibilityLabel="Password"
                    />
                  </View>
                </View>

                {error ? <Banner kind="error">{error}</Banner> : null}

                <Button
                  label="Sign in with email"
                  variant="outline"
                  onPress={handleSignIn}
                  busy={busy}
                />
                <View style={styles.linkRow}>
                  <Button
                    label="Create account"
                    variant="ghost"
                    onPress={() => router.push("/register")}
                  />
                  <Button
                    label="Forgot password?"
                    variant="ghost"
                    onPress={() => router.push("/forgot-password")}
                  />
                </View>
              </>
            ) : (
              <Button
                label="Use email instead"
                variant="ghost"
                onPress={() => setShowEmail(true)}
              />
            )}
          </BlurView>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: Palette.background, overflow: "hidden" },
  flex: { flex: 1 },
  watermark: { position: "absolute", top: "8%", left: -28, flexDirection: "column" },
  watermarkLetter: {
    fontFamily: "Montserrat_900Black",
    fontSize: 180,
    lineHeight: 150,
    color: Palette.watermark,
    opacity: 0.55,
    letterSpacing: -8,
  },
  content: {
    flexGrow: 1,
    justifyContent: "flex-end",
    paddingHorizontal: Spacing.marginMain,
    paddingBottom: Spacing.xl,
    gap: Spacing.stackLg,
  },
  brand: { ...Typography.headlineXl, color: Palette.primary },
  tagline: { ...Typography.bodyLg, color: Palette.onSurfaceVariant },
  card: {
    borderRadius: Radius.xl,
    padding: Spacing.cardPadding,
    overflow: "hidden",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.5)",
    backgroundColor: "rgba(252,249,248,0.55)",
    gap: Spacing.sm,
  },
  hint: { ...Typography.bodySm, color: Palette.onSurfaceVariant, textAlign: "center" },
  field: { gap: 6 },
  fieldLabel: { ...Typography.labelMd, color: Palette.onSurfaceVariant },
  inputWrap: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    backgroundColor: Palette.surfaceContainerLowest,
    borderWidth: 1,
    borderColor: "rgba(129,116,113,0.4)",
    borderRadius: Radius.md,
    paddingHorizontal: 16,
    paddingVertical: 14,
  },
  inputWrapError: { borderColor: Palette.error },
  input: { flex: 1, ...Typography.bodyMd, color: Palette.onSurface, padding: 0 },
  divider: { flexDirection: "row", alignItems: "center", gap: Spacing.sm, paddingVertical: 4 },
  dividerLine: { flex: 1, height: 1, backgroundColor: "rgba(129,116,113,0.25)" },
  dividerLabel: { ...Typography.labelMd, color: "rgba(44,27,23,0.6)" },
  linkRow: { flexDirection: "row", justifyContent: "space-between" },
});
