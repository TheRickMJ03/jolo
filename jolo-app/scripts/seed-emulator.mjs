// `npm run seed:emulator` — loads a demo café into the LOCAL Firestore emulator
// (started with `npm run emulators`): "Barbara's", owned by DEMO_OWNER_PHONE,
// with menu versions 1–3 and two weeks of insights. It refuses to run against
// anything but the emulator.
//
//   DEMO_OWNER_PHONE=+16505551234 npm run seed:emulator
import { initializeApp } from "firebase-admin/app";
import { FieldValue, Timestamp, getFirestore } from "firebase-admin/firestore";

const host = process.env.FIRESTORE_EMULATOR_HOST ?? "127.0.0.1:8080";
process.env.FIRESTORE_EMULATOR_HOST = host;
const ownerPhone = process.env.DEMO_OWNER_PHONE ?? "+16505551234";
if (!/^\+\d{8,15}$/.test(ownerPhone)) {
  console.error(`DEMO_OWNER_PHONE must be E.164, like +16505551234 (got "${ownerPhone}").`);
  process.exit(1);
}

// No credentials: with FIRESTORE_EMULATOR_HOST set, the Admin SDK talks only
// to the emulator, and a "demo-" project ID can't reach a real project.
initializeApp({ projectId: "demo-jolo" });
const db = getFirestore();

const daysAgo = (days) => Timestamp.fromDate(new Date(Date.now() - days * 86_400_000));
// Items in the menu reader's shape (docs/contracts.md §1), plus id and available.
const item = (id, name, section, category, prices, extra = {}) => ({
  id,
  section,
  item: name,
  category,
  prices: typeof prices === "number" ? [{ size: null, usd: prices }] : prices,
  add_ons: [],
  variants: [],
  tags: [],
  confidence: 1,
  available: true,
  ...extra,
});
const reprice = (items, id, usd) =>
  items.map((i) => (i.id === id ? { ...i, prices: [{ size: null, usd }] } : i));

const v1 = [
  item("espresso", "Espresso", "Coffee", "drink", 3),
  item("cortado", "Cortado", "Coffee", "drink", 4.25),
  // The reader missed the size heading here, so the sizes came back as small/large.
  item(
    "latte",
    "Latte",
    "Coffee",
    "drink",
    [
      { size: "small", usd: 3.5 },
      { size: "large", usd: 4.25 },
    ],
    { confidence: 0.7 },
  ),
  item("muffin", "Muffin", "Bakery", "food", 3),
];
const v2 = [...reprice(v1, "cortado", 4.5), item("croissant", "Croissant", "Bakery", "food", 3.75)];
const v3 = [
  ...reprice(v2, "muffin", 3.25),
  item("cappuccino", "Cappuccino", "Coffee", "drink", 4),
  // Wall decoration read as an item: the kind of thing the owner should check.
  item("fresh-daily", "Fresh Daily", "Bakery", "food", [], { confidence: 0.4 }),
  item("oat-milk", "Oat Milk", "Extras", "modifier", 0.75),
];

const versions = [
  {
    version: 1,
    basedOn: 0,
    items: v1,
    changes: { added: v1.map((i) => i.item), price_changes: [], changed: [], removed: [] },
    at: 20,
  },
  {
    version: 2,
    basedOn: 1,
    items: v2,
    changes: {
      added: ["Croissant"],
      price_changes: [{ item: "Cortado", size: null, old_usd: 4.25, new_usd: 4.5 }],
      changed: [],
      removed: [],
    },
    at: 10,
  },
  {
    version: 3,
    basedOn: 2,
    items: v3,
    changes: {
      added: ["Cappuccino", "Fresh Daily", "Oat Milk"],
      price_changes: [{ item: "Muffin", size: null, old_usd: 3, new_usd: 3.25 }],
      changed: [],
      removed: [],
    },
    at: 3,
  },
];

const cafe = db.doc("cafes/demo-barbaras");
const batch = db.batch();
batch.set(cafe, {
  name: "Barbara's",
  nameLower: "barbara's",
  address: "1 Main Street, Westfield, NJ 07090",
  municipality: "Westfield",
  phone: ownerPhone,
  ownerPhone,
  currentMenuVersion: 3,
  menuUpdatedAt: daysAgo(3),
  source: "demo",
});
for (const { at, ...version } of versions) {
  batch.set(cafe.collection("menuVersions").doc(String(version.version)), {
    ...version,
    scope: "full",
    source: "imessage",
    createdAt: daysAgo(at),
    createdBy: { phone: ownerPhone, uid: null },
  });
}
batch.set(cafe.collection("insights").doc("2026-11-02"), {
  weekStart: "2026-11-02",
  counts: { customerQuestions: 21, uniqueCustomers: 9, menuUpdates: 1 },
  topItems: [
    { name: "Latte", mentions: 6 },
    { name: "Cortado", mentions: 4 },
  ],
  summary:
    "A steady week. Most questions were about lattes and whether you open early on Saturday.",
  generatedAt: FieldValue.serverTimestamp(),
});
batch.set(cafe.collection("insights").doc("2026-11-09"), {
  weekStart: "2026-11-09",
  counts: { customerQuestions: 42, uniqueCustomers: 17, menuUpdates: 2, oatMilkRequests: 5 },
  topItems: [
    { name: "Cortado", mentions: 9 },
    { name: "Cappuccino", mentions: 7 },
  ],
  summary:
    "Questions doubled after the Cappuccino was added. Five people asked for oat milk — worth adding to the menu.",
  generatedAt: FieldValue.serverTimestamp(),
});
await batch.commit();

console.log(
  `Seeded the emulator at ${host}: "Barbara's" (cafes/demo-barbaras), owner ${ownerPhone}.`,
);
console.log(
  "Sign in to the app with that number; the code appears in the emulator UI (http://localhost:4000/auth).",
);
