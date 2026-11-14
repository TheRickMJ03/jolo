// Writes the café the owner app looks up by phone number. The emulator accepts
// "Bearer owner" on its REST API and skips security rules; a normal client
// create is rejected. PATCH hangs on this Mac, so an update is a delete plus
// a create of the same id.
import { firestoreEmulatorHost, firestoreProjectId } from "../env.ts";
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

export async function linkOwnerCafe(profile: LinkedCafe, host = firestoreEmulatorHost): Promise<void> {
  if (!host) throw new Error("no Firestore emulator host");
  const project = firestoreProjectId;
  const id = `owner-${profile.phone.replace(/\D/g, "")}`;
  const base = `http://${host}/v1/projects/${project}/databases/(default)/documents`;
  const doc = `${base}/cafes/${id}`;
  const headers = { Authorization: "Bearer owner", "content-type": "application/json" };
  await fetch(doc, { method: "DELETE", headers });
  const response = await fetch(`${base}/cafes?documentId=${id}`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      fields: {
        name: { stringValue: profile.businessName },
        ownerName: { stringValue: profile.name },
        address: { stringValue: profile.location },
        ownerPhone: { stringValue: profile.phone },
        phone: { stringValue: profile.phone },
        currentMenuVersion: { integerValue: "0" },
        source: { stringValue: "imessage" },
      },
    }),
  });
  if (!response.ok) throw new Error(`cafe link failed: ${response.status} ${await response.text()}`);
}
