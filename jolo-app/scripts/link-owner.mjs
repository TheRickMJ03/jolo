// `npm run link-owner -- --service-account ./service-account.json --cafe <cafeId> --phone "(908) 555-1234" [--yes]`
//
// Links a café to its owner's phone number by setting cafes/{id}.ownerPhone.
// Clients can never write that field, so this Admin SDK script (and the
// agent's backend) are the only ways in. Without --yes it only shows what it
// would change.
//
// Use the service account of the project you mean to change. The key file is
// git-ignored; never commit it.
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { cert, initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

import { toE164 } from "../lib/phone.js";

const { values } = parseArgs({
  options: {
    "service-account": { type: "string" },
    cafe: { type: "string" },
    phone: { type: "string" },
    unlink: { type: "boolean", default: false },
    yes: { type: "boolean", default: false },
  },
});

const usage =
  'Usage: npm run link-owner -- --service-account ./service-account.json --cafe <cafeId> --phone "(908) 555-1234" [--yes]\n' +
  "       npm run link-owner -- --service-account ./service-account.json --cafe <cafeId> --unlink [--yes]";

if (!values["service-account"] || !values.cafe || (!values.phone && !values.unlink)) {
  console.error(usage);
  process.exit(1);
}

const phone = values.unlink ? null : toE164(values.phone);
if (!values.unlink && !phone) {
  console.error(`"${values.phone}" isn't a phone number I can read. Use (908) 555-1234 or +44…`);
  process.exit(1);
}

const serviceAccount = JSON.parse(readFileSync(values["service-account"], "utf8"));
initializeApp({ credential: cert(serviceAccount) });
const db = getFirestore();

const ref = db.doc(`cafes/${values.cafe}`);
const snapshot = await ref.get();
if (!snapshot.exists) {
  console.error(`No café "${values.cafe}" in project ${serviceAccount.project_id}.`);
  process.exit(1);
}

const data = snapshot.data();
const clash = phone
  ? (await db.collection("cafes").where("ownerPhone", "==", phone).get()).docs.filter(
      (d) => d.id !== ref.id,
    )
  : [];

console.log(`Project: ${serviceAccount.project_id}`);
console.log(`Café:    ${data.name} (cafes/${ref.id})`);
console.log(`Owner:   ${data.ownerPhone ?? "(none)"} → ${phone ?? "(none)"}`);
if (clash.length > 0) {
  console.log(
    `Note:    ${phone} already owns ${clash.map((d) => d.data().name).join(", ")}; the app shows the first one.`,
  );
}

if (!values.yes) {
  console.log("\nDry run: nothing changed. Re-run with --yes to apply.");
  process.exit(0);
}

await ref.update({
  ownerPhone: phone,
  // Make sure the menu pointer exists, so the owner rules can compare against it.
  currentMenuVersion: data.currentMenuVersion ?? 0,
});
console.log("\n✓ Updated.");
