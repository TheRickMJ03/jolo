// Auth context, reused from the JOLO app (email sign-in, sign-up, password
// reset) with phone sign-in added. Café owners sign in with the phone number
// their café is linked to; email accounts keep working but can't manage a café,
// because ownership is matched on the verified phone number.
import { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import {
  createUserWithEmailAndPassword,
  onAuthStateChanged,
  sendPasswordResetEmail,
  signInWithEmailAndPassword,
  signInWithPhoneNumber,
  signOut as firebaseSignOut,
  updateProfile,
} from "@react-native-firebase/auth";
import { doc, getDoc, serverTimestamp, setDoc } from "@react-native-firebase/firestore";
import { auth, db } from "@/FirebaseConfig";

const AuthContext = createContext(null);

/**
 * Creates the user's Firestore profile the first time we see them signed in, so
 * an interrupted sign-up (or an account made outside the app) still gets one.
 */
async function ensureUserProfile({ uid, email, phoneNumber, displayName }) {
  const ref = doc(db, "users", uid);
  if ((await getDoc(ref)).exists()) return;

  await setDoc(ref, {
    displayName: displayName ?? "JOLO member",
    avatarPath: null,
    stats: { postCount: 0, cafesVisitedCount: 0, friendCount: 0 },
    createdAt: serverTimestamp(),
  });
  await setDoc(doc(db, "users", uid, "private", "account"), {
    email: email ?? null,
    phoneNumber: phoneNumber ?? null,
    settings: {
      notifications: { friendPosts: true, likes: true, comments: true, friendRequests: true },
    },
  });
}

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [initializing, setInitializing] = useState(true);
  // The pending phone confirmation lives between "send code" and "enter code".
  const confirmation = useRef(null);

  useEffect(
    () =>
      onAuthStateChanged(auth, (nextUser) => {
        setUser(nextUser);
        setInitializing(false);
        // Don't block sign-in on this; a failed write is retried next launch.
        if (nextUser) {
          const { uid, email, phoneNumber, displayName } = nextUser;
          ensureUserProfile({ uid, email, phoneNumber, displayName }).catch((error) => {
            console.warn(
              `[jolo] profile sync failed: ${error?.code ?? "unknown"} — ${error?.message}`,
            );
          });
        }
      }),
    [],
  );

  const value = useMemo(
    () => ({
      user,
      initializing,
      signIn: (email, password) => signInWithEmailAndPassword(auth, email.trim(), password),
      signUp: async (name, email, password) => {
        const { user: created } = await createUserWithEmailAndPassword(
          auth,
          email.trim(),
          password,
        );
        const displayName = name.trim();
        await updateProfile(created, { displayName });
        await ensureUserProfile({ uid: created.uid, email: created.email, displayName }).catch(
          (error) => {
            console.warn(
              `[jolo] profile create failed: ${error?.code ?? "unknown"} — ${error?.message}`,
            );
          },
        );
      },
      /** Texts a 6-digit code to `e164` ("+19085551234"). */
      sendPhoneCode: async (e164) => {
        confirmation.current = await signInWithPhoneNumber(auth, e164);
      },
      /** Signs in with the code from the text; the root layout then shows the dashboard. */
      confirmPhoneCode: async (code) => {
        if (!confirmation.current) {
          const error = new Error("No code was requested.");
          error.code = "auth/missing-verification-id";
          throw error;
        }
        await confirmation.current.confirm(code.trim());
        confirmation.current = null;
      },
      signOut: () => firebaseSignOut(auth),
      resetPassword: (email) => sendPasswordResetEmail(auth, email.trim()),
    }),
    [user, initializing],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) throw new Error("useAuth must be used inside an AuthProvider");
  return context;
}
