"""Write the real Princeton cafés (data/cafes_osm.yaml) into the app's Firestore `cafes` collection,
in the same shape Isaiah's OpenStreetMap import uses (jolo-app/scripts/seed-cafes.mjs).

Usage (from the repo root, venv active):
    python scripts/push_cafes_firestore.py                 # dry run: lists what would be created / skipped
    FIRESTORE_EMULATOR_HOST=localhost:8080 python scripts/push_cafes_firestore.py --write     # emulator
    GOOGLE_APPLICATION_CREDENTIALS=key.json python scripts/push_cafes_firestore.py --write --really-write-to-firestore

Document id = "osm-" + osmId with "/" -> "-"  (node/123 -> osm-node-123), as in the app's import.
A café is skipped when a document with that id, or with the same osmId, already exists, so running it
twice (or after the app's import) never duplicates. Existing documents are never modified.
Counters (ratingSum, ...) start at 0, createdAt/importedAt are set by the server, ownerPhone is never set.
Menus are not written: owners add them, which creates menuVersions and sets currentMenuVersion.
"""

import argparse
import os
import sys
from pathlib import Path

import yaml

REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO))

from jolo_agent.store.firestore import hours_to_app      # noqa: E402

PROJECT = "jolo-ec76d"
COUNTERS = {"ratingSum": 0, "ratingCount": 0, "postCount": 0, "favoriteCount": 0}


def doc_id(osm_id):
    return "osm-" + osm_id.replace("/", "-")


def build_doc(cafe):
    """The app-shaped document (plain Python values; the writer swaps in GeoPoint and server timestamps)."""
    osm = cafe["osm"]
    brand = osm.get("brand")
    return {
        "source": "osm", "osmId": osm["id"],
        "name": cafe["name"], "nameLower": cafe["name"].lower(),
        "brand": brand, "isChain": bool(brand),
        "address": cafe.get("address") or None,
        "municipality": osm.get("municipality") or "Princeton",
        "lat": cafe["lat"], "lng": cafe["lng"],
        "hours": hours_to_app(cafe.get("hours") or {}),
        "hoursRaw": osm.get("opening_hours"),
        "website": osm.get("website"), "phone": osm.get("phone"),
        "amenities": {"wifi": osm.get("wifi"), "outdoorSeating": osm.get("outdoor_seating"),
                      "driveThrough": osm.get("drive_through")},
        **({"vibe": cafe["vibe"]} if cafe.get("vibe") else {}),
        **({"summary": cafe["summary"]} if cafe.get("summary") else {}),
    }


def main():
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    parser = argparse.ArgumentParser()
    parser.add_argument("--file", default="data/cafes_osm.yaml")
    parser.add_argument("--write", action="store_true", help="actually write (default: dry run, but it still reads Firestore)")
    parser.add_argument("--really-write-to-firestore", action="store_true", help="needed to write to the real project")
    args = parser.parse_args()

    emulator = bool(os.environ.get("FIRESTORE_EMULATOR_HOST"))
    if args.write and not emulator and not args.really_write_to_firestore:
        sys.exit("--write on the real project needs --really-write-to-firestore. Try the emulator first "
                 "(FIRESTORE_EMULATOR_HOST=localhost:8080).")

    from google.cloud import firestore
    db = firestore.Client(project=os.environ.get("GOOGLE_CLOUD_PROJECT", PROJECT))
    cafes = yaml.safe_load((REPO / args.file).read_text(encoding="utf-8"))["cafes"]
    print(f"Target: {'EMULATOR ' + os.environ['FIRESTORE_EMULATOR_HOST'] if emulator else 'REAL project ' + db.project}")

    created = skipped = 0
    for cafe in cafes.values():
        doc = build_doc(cafe)
        ref = db.collection("cafes").document(doc_id(doc["osmId"]))
        same_osm = list(db.collection("cafes").where("osmId", "==", doc["osmId"]).limit(1).stream())
        if ref.get().exists or same_osm:
            skipped += 1
            print(f"  skip   {doc['name']} (already there)")
            continue
        created += 1
        print(f"  {'create' if args.write else 'would create'} {ref.id}  {doc['name']}")
        if args.write:
            data = {k: v for k, v in doc.items() if k not in ("lat", "lng")}
            data["location"] = firestore.GeoPoint(doc["lat"], doc["lng"])
            data.update(COUNTERS)
            data["createdAt"] = firestore.SERVER_TIMESTAMP
            data["importedAt"] = firestore.SERVER_TIMESTAMP
            data["currentMenuVersion"] = 0
            ref.set(data)
    print(f"{'Created' if args.write else 'Would create'} {created}, skipped {skipped}.")
    if not args.write:
        print("Dry run: nothing written. Add --write.")


if __name__ == "__main__":
    main()
