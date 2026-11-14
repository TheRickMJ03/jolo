// Writes from the app. Saving an edit creates menuVersions/{current + 1} and
// moves cafes/{id}.currentMenuVersion in ONE transaction, which is also what
// firestore.rules requires. If the menu moved on meanwhile (a new version
// arrived by iMessage), the transaction refuses and the owner's edits are kept.
import { doc, runTransaction, serverTimestamp } from "@react-native-firebase/firestore";
import { db } from "@/FirebaseConfig";

export class MenuConflictError extends Error {
  constructor(latestVersion) {
    super("The menu was updated somewhere else while you were editing.");
    this.latestVersion = latestVersion;
  }
}

/** `next` is a document from buildNextVersion(). Resolves to the new version number. */
export async function saveMenuVersion(cafeId, next) {
  const cafeRef = doc(db, "cafes", cafeId);
  const versionRef = doc(db, "cafes", cafeId, "menuVersions", String(next.version));

  await runTransaction(db, async (transaction) => {
    const cafe = await transaction.get(cafeRef);
    const current = cafe.data()?.currentMenuVersion ?? 0;
    if (current !== next.basedOn) throw new MenuConflictError(current);

    transaction.set(versionRef, { ...next, createdAt: serverTimestamp() });
    transaction.update(cafeRef, {
      currentMenuVersion: next.version,
      menuUpdatedAt: serverTimestamp(),
    });
  });
  return next.version;
}
