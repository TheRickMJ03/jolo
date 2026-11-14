// `npm run seed:cafes` — loads the Union County cafés (data/cafes, from
// OpenStreetMap via the JOLO app) into the LOCAL Firestore emulator, so the
// customer Finder has a map to show. It refuses to run against anything but the
// emulator: FIRESTORE_EMULATOR_HOST is always set, so the Admin SDK never
// reaches a real project.
//
//   FIRESTORE_EMULATOR_HOST=127.0.0.1:18180 npm run seed:cafes
//
// FIRESTORE_PROJECT_ID defaults to jolo-ec76d, the project in the app's
// GoogleService-Info.plist. The emulator keeps each project separate, so data
// written under demo-jolo is invisible to the app.
import { readFile } from "node:fs/promises";
import { initializeApp } from "firebase-admin/app";
import { FieldValue, GeoPoint, getFirestore } from "firebase-admin/firestore";

const host = process.env.FIRESTORE_EMULATOR_HOST ?? "127.0.0.1:8080";
process.env.FIRESTORE_EMULATOR_HOST = host;
const projectId = process.env.FIRESTORE_PROJECT_ID ?? "jolo-ec76d";
const file = new URL("../data/cafes/union-county-nj.json", import.meta.url);

initializeApp({ projectId });
const db = getFirestore();

const seed = JSON.parse(await readFile(file, "utf8"));
const COUNTERS = { ratingSum: 0, ratingCount: 0, postCount: 0, favoriteCount: 0 };

let batch = db.batch();
let pending = 0;
for (const { id, location, ...fields } of seed.cafes) {
  // merge: an owner-linked café or a menu pointer on the same id is kept.
  batch.set(
    db.collection("cafes").doc(id),
    {
      ...fields,
      location: new GeoPoint(location.lat, location.lng),
      importedAt: FieldValue.serverTimestamp(),
      ...COUNTERS,
    },
    { merge: true },
  );
  if (++pending === 400) {
    await batch.commit();
    batch = db.batch();
    pending = 0;
  }
}
if (pending > 0) await batch.commit();

console.log(`Seeded ${seed.cafes.length} cafés into ${projectId} on the emulator at ${host}.`);
