// A customer's iMessage, saved where the app's For you can read it.
//
// The words they typed become "What you like". The agent writes the cafés it
// found separately, and those become History.
//
// When this phone already has an app account, the row goes in users/{uid}/events,
// which the app already loads. Otherwise it waits at customerAsks/{phone}/items
// until they sign in with this number.
import { randomUUID } from "node:crypto";

import {
  firestoreEmulatorHost,
  firestoreProjectId,
  firestoreServiceAccount,
  skipDotenv,
} from "../env.ts";
import { toE164 } from "./link-cafe.ts";

const MAX_TEXT = 280;

/** The ask to store, or null when this message isn't a customer's question. */
export function askFromCustomerMessage(
  role: string | undefined,
  eventType: string,
  text: string,
  handle: string,
): { phone: string; text: string } | null {
  if (role !== "customer" || eventType !== "message") return null;
  const body = text.trim().slice(0, MAX_TEXT);
  const phone = toE164(handle);
  if (!body || !phone) return null;
  return { phone, text: body };
}

type AskDb = {
  userId(phone: string): Promise<string | null>;
  saveForUser(uid: string, text: string): Promise<void>;
  saveForPhone(phone: string, text: string): Promise<void>;
};

export async function saveCustomerAsk(db: AskDb, phone: string, text: string): Promise<void> {
  const uid = await db.userId(phone);
  if (uid) {
    await db.saveForUser(uid, text);
    return;
  }
  await db.saveForPhone(phone, text);
}

export async function recordCustomerAsk(phone: string, text: string): Promise<void> {
  const body = text.trim().slice(0, MAX_TEXT);
  if (!body) return;
  if (firestoreEmulatorHost) {
    await saveViaEmulator(phone, body, firestoreEmulatorHost);
    return;
  }
  if (!firestoreServiceAccount && skipDotenv) return;
  await saveWithAdmin(phone, body);
}

async function saveViaEmulator(phone: string, text: string, host: string): Promise<void> {
  const base = `http://${host}/v1/projects/${firestoreProjectId}/databases/(default)/documents`;
  const response = await fetch(`${base}/customerAsks/${encodeURIComponent(phone)}/items`, {
    method: "POST",
    headers: { Authorization: "Bearer owner", "content-type": "application/json" },
    body: JSON.stringify({
      fields: {
        text: { stringValue: text },
        historyOnly: { booleanValue: false },
        createdAt: { timestampValue: new Date().toISOString() },
      },
    }),
  });
  if (!response.ok) throw new Error(`ask save failed: ${response.status} ${await response.text()}`);
}

let adminDb: Promise<AskDb> | undefined;

async function saveWithAdmin(phone: string, text: string): Promise<void> {
  adminDb ??= openAdmin().catch((error) => {
    adminDb = undefined;
    throw error;
  });
  await saveCustomerAsk(await adminDb, phone, text);
}

async function openAdmin(): Promise<AskDb> {
  const { applicationDefault, cert, getApps, initializeApp } = await import("firebase-admin/app");
  const { FieldValue, getFirestore } = await import("firebase-admin/firestore");
  const app =
    getApps()[0] ??
    initializeApp({
      credential: firestoreServiceAccount ? cert(firestoreServiceAccount) : applicationDefault(),
      projectId: firestoreProjectId,
    });
  const db = getFirestore(app);
  return {
    async userId(phone) {
      const snap = await db.collectionGroup("private").where("phoneNumber", "==", phone).limit(1).get();
      return snap.docs[0]?.ref.parent.parent?.id ?? null;
    },
    async saveForUser(uid, body) {
      await db.collection("users").doc(uid).collection("events").doc(randomUUID()).set({
        type: "search",
        text: body,
        createdAt: FieldValue.serverTimestamp(),
      });
    },
    async saveForPhone(number, body) {
      await db.collection("customerAsks").doc(number).collection("items").doc(randomUUID()).set({
        text: body,
        historyOnly: false,
        createdAt: FieldValue.serverTimestamp(),
      });
    },
  };
}
