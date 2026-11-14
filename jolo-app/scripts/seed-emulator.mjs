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
const item = (id, name, category, priceCents, extra = {}) => ({
  id,
  name,
  category,
  priceCents,
  description: null,
  available: true,
  ...extra,
});

const v1 = [
  item("espresso", "Espresso", "Coffee", 300),
  item("cortado", "Cortado", "Coffee", 425),
  item("latte", "Latte", "Coffee", 350),
  item("muffin", "Muffin", "Bakery", 300),
];
const v2 = [
  ...v1.map((i) => (i.id === "cortado" ? { ...i, priceCents: 450 } : i)),
  item("croissant", "Croissant", "Bakery", 375),
];
const v3 = [
  ...v2.map((i) => (i.id === "muffin" ? { ...i, priceCents: 325 } : i)),
  item("cappuccino", "Cappuccino", "Coffee", 400, {
    description: "Equal parts espresso, milk and foam",
  }),
];

const versions = [
  {
    version: 1,
    basedOn: 0,
    items: v1,
    changes: { added: v1.map((i) => i.name), changed: [], removed: [] },
    at: 20,
  },
  {
    version: 2,
    basedOn: 1,
    items: v2,
    changes: {
      added: ["Croissant"],
      changed: [{ itemId: "cortado", name: "Cortado", field: "priceCents", from: 425, to: 450 }],
      removed: [],
    },
    at: 10,
  },
  {
    version: 3,
    basedOn: 2,
    items: v3,
    changes: {
      added: ["Cappuccino"],
      changed: [{ itemId: "muffin", name: "Muffin", field: "priceCents", from: 300, to: 325 }],
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
