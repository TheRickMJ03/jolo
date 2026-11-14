// Writes the café the owner app looks up by phone number (cafes/owner-{digits}).
//
// Two backends, one rule (mergeCafe): the owner's name, business and location
// are updated, and everything else on the café — the menu pointer, map
// coordinates, hours — is kept. Signing up again never resets a menu.
//
//   FIRESTORE_EMULATOR_HOST set  → the emulator's REST API. "Bearer owner"
//     skips security rules there. PATCH hangs on the demo Mac, so an update is
//     a read, then a delete and a create of the merged document.
//   otherwise                    → the real project through the Firebase Admin
//     SDK, with JOLO_SERVICE_ACCOUNT (a key file) or Application Default
//     Credentials. Clients can't create cafés (firestore.rules); this server can.
import { firestoreEmulatorHost, firestoreProjectId, firestoreServiceAccount } from "../env.ts";
import type { OwnerProfile } from "./types.ts";

export interface LinkedCafe extends OwnerProfile {
  phone: string;
}

/** "+1 908 555 1234" → "+19085551234". Null when it isn't a usable number. */
export function toE164(input: string): string | null {
  const trimmed = input.trim();
  const digits = trimmed.replace(/\D/g, "");
  if (trimmed.startsWith("+")) return digits.length >= 8 && digits.length <= 15 ? `+${digits}` : null;
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return null;
}

export const cafeIdFor = (phone: string) => `owner-${phone.replace(/\D/g, "")}`;

/** Plain values for a café document. */
export type CafeFields = Record<string, unknown>;

/**
 * The café after this sign-up: the profile on top of whatever was there.
 * A brand-new café starts with no menu (currentMenuVersion 0).
 */
export function mergeCafe(existing: CafeFields | null | undefined, profile: LinkedCafe): CafeFields {
  const before = existing ?? {};
  return {
    ...before,
    name: profile.businessName,
    ownerName: profile.name,
    address: profile.location,
    ownerPhone: profile.phone,
    phone: profile.phone,
    source: before.source ?? "imessage",
    currentMenuVersion: typeof before.currentMenuVersion === "number" ? before.currentMenuVersion : 0,
  };
}

// ---------------------------------------------------------------------------
// Emulator: REST, typed values
// ---------------------------------------------------------------------------

type RestValue = Record<string, unknown>;

/** A plain value → the REST API's typed value. Only the types a café uses. */
export function toRest(value: unknown): RestValue {
  if (value === null || value === undefined) return { nullValue: null };
  if (typeof value === "string") return { stringValue: value };
  if (typeof value === "boolean") return { booleanValue: value };
  if (typeof value === "number") {
    return Number.isInteger(value) ? { integerValue: String(value) } : { doubleValue: value };
  }
  throw new Error(`can't store ${typeof value} in a café document`);
}

/** The REST API's typed value → a plain value. Unknown types (maps, timestamps, …) are kept as they came. */
export function fromRest(value: RestValue): unknown {
  if ("stringValue" in value) return value.stringValue;
  if ("integerValue" in value) return Number(value.integerValue);
  if ("doubleValue" in value) return value.doubleValue;
  if ("booleanValue" in value) return value.booleanValue;
  if ("nullValue" in value) return null;
  return { __rest: value };
}

function restFields(fields: CafeFields): Record<string, RestValue> {
  const out: Record<string, RestValue> = {};
  for (const [key, value] of Object.entries(fields)) {
    // A value read back as-is (a timestamp, a location, hours) goes back as-is.
    out[key] =
      value && typeof value === "object" && "__rest" in value ? (value.__rest as RestValue) : toRest(value);
  }
  return out;
}

export async function linkViaEmulator(
  profile: LinkedCafe,
  host: string,
  project = firestoreProjectId,
  request: typeof fetch = fetch,
): Promise<void> {
  const id = cafeIdFor(profile.phone);
  const base = `http://${host}/v1/projects/${project}/databases/(default)/documents`;
  const doc = `${base}/cafes/${id}`;
  const headers = { Authorization: "Bearer owner", "content-type": "application/json" };

  const current = await request(doc, { headers });
  let existing: CafeFields | null = null;
  if (current.ok) {
    const body = (await current.json()) as { fields?: Record<string, RestValue> };
    existing = Object.fromEntries(Object.entries(body.fields ?? {}).map(([key, value]) => [key, fromRest(value)]));
  } else if (current.status !== 404) {
    throw new Error(`cafe read failed: ${current.status} ${await current.text()}`);
  }

  const merged = mergeCafe(existing, profile);
  if (existing) await request(doc, { method: "DELETE", headers });
  const response = await request(`${base}/cafes?documentId=${id}`, {
    method: "POST",
    headers,
    body: JSON.stringify({ fields: restFields(merged) }),
  });
  if (!response.ok) throw new Error(`cafe link failed: ${response.status} ${await response.text()}`);
}

// ---------------------------------------------------------------------------
// Real project: Admin SDK
// ---------------------------------------------------------------------------

/** The slice of Firestore the Admin path needs, so tests can pass a fake. */
export interface CafeStore {
  read(id: string): Promise<CafeFields | null>;
  write(id: string, fields: CafeFields): Promise<void>;
}

export async function linkWith(store: CafeStore, profile: LinkedCafe): Promise<void> {
  const id = cafeIdFor(profile.phone);
  const existing = await store.read(id);
  const merged = mergeCafe(existing, profile);
  // Only the fields this sign-up owns are written; the rest stay as they are.
  const { name, ownerName, address, ownerPhone, phone, source, currentMenuVersion } = merged;
  await store.write(id, { name, ownerName, address, ownerPhone, phone, source, currentMenuVersion });
}

let adminStore: Promise<CafeStore> | undefined;

async function firestoreAdmin(): Promise<CafeStore> {
  const { applicationDefault, cert, getApps, initializeApp } = await import("firebase-admin/app");
  const { getFirestore } = await import("firebase-admin/firestore");
  const app =
    getApps()[0] ??
    initializeApp({
      credential: firestoreServiceAccount ? cert(firestoreServiceAccount) : applicationDefault(),
      projectId: firestoreProjectId,
    });
  const db = getFirestore(app);
  return {
    async read(id) {
      const snapshot = await db.collection("cafes").doc(id).get();
      return snapshot.exists ? (snapshot.data() ?? {}) : null;
    },
    async write(id, fields) {
      await db.collection("cafes").doc(id).set(fields, { merge: true });
    },
  };
}

export async function linkOwnerCafe(profile: LinkedCafe, host = firestoreEmulatorHost): Promise<void> {
  if (host) return linkViaEmulator(profile, host);
  // A failed start (no credentials yet) is retried on the next sign-up.
  adminStore ??= firestoreAdmin().catch((error) => {
    adminStore = undefined;
    throw error;
  });
  return linkWith(await adminStore, profile);
}
