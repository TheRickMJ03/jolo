import { getApp } from "@react-native-firebase/app";
import { connectAuthEmulator, getAuth } from "@react-native-firebase/auth";
import { connectFirestoreEmulator, getFirestore } from "@react-native-firebase/firestore";

// React Native Firebase uses the native iOS and Android SDKs, which read the
// project from GoogleService-Info.plist / google-services.json at build time
// (see app.config.js), so there is no config object here.
export const app = getApp();
export const auth = getAuth(app);
export const db = getFirestore(app);

// EXPO_PUBLIC_USE_FIREBASE_EMULATORS=1 points the app at the local Auth and
// Firestore emulators (`npm run emulators`), so a demo never touches real data.
// Phone sign-in then needs no SMS: the emulator shows the code in its UI.
export const usingEmulators = process.env.EXPO_PUBLIC_USE_FIREBASE_EMULATORS === "1";

if (usingEmulators) {
  const host = process.env.EXPO_PUBLIC_EMULATOR_HOST ?? "localhost";
  // 8080 is the emulator's normal port. On this Mac, Screen Time's web filter
  // transparently captures only that port, which breaks the native SDK's gRPC
  // stream. EXPO_PUBLIC_FIRESTORE_EMULATOR_PORT can point at another published
  // port for the same emulator.
  const firestorePort = Number(process.env.EXPO_PUBLIC_FIRESTORE_EMULATOR_PORT ?? 8080);
  connectAuthEmulator(auth, `http://${host}:9099`);
  connectFirestoreEmulator(db, host, firestorePort);
  // The emulator can't verify the app with APNs or reCAPTCHA; skip that step.
  auth.settings.appVerificationDisabledForTesting = true;
}
