import { addDoc, collection, serverTimestamp } from "@react-native-firebase/firestore";
import { db } from "@/FirebaseConfig";
import { buildEvent } from "@/lib/events";

/** Append one event for the signed-in user. The document id comes from Firestore. */
export async function writeEvent(uid, input) {
  const event = buildEvent(input);
  delete event.createdAt;
  await addDoc(collection(db, "users", uid, "events"), {
    ...event,
    createdAt: serverTimestamp(),
  });
}
