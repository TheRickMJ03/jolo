"""Fill the store with the 22 cafés so there is something to search and update.

Usage (from the repo root, venv active):
    python scripts/seed_store.py                          # add cafés that are not in the store yet
    python scripts/seed_store.py --reset                  # memory backend only: start from an empty file
    python scripts/seed_store.py --owner +16095550100=barbaras   # make this phone the owner of a café

Menus come from eval/ground_truth.csv (hand-labelled, not fully double-checked).
Names, addresses, hours and vibes come from data/cafes.yaml and are INVENTED
demo data; see the note at the top of that file.
"""

import argparse
import os
import sys
from pathlib import Path

import pandas as pd
import yaml

REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO))

from menu_reader.config import load_config            # noqa: E402
from menu_reader.schema import MenuItem, Price        # noqa: E402
from jolo_agent.store import Cafe, User, hash_handle, open_store, to_e164   # noqa: E402


def menus_from_ground_truth():
    """{cafe_id: [MenuItem, ...]} with one item per name and one price per row."""
    photos = pd.read_csv(REPO / "eval" / "photos.csv", dtype=str)
    truth = pd.read_csv(REPO / "eval" / "ground_truth.csv", dtype={"size": str, "item": str})
    cafe_of = dict(zip(photos.photo_id, photos.cafe_name))

    menus = {}
    for row in truth.itertuples():
        items = menus.setdefault(cafe_of[row.photo_id], {})
        key = (row.item, row.category)
        if key not in items:
            # Hand-labelled, so the reader's doubt doesn't apply: confidence 1.0.
            items[key] = MenuItem(item=row.item, category=row.category, confidence=1.0)
        if pd.notna(row.price):
            size = row.size if pd.notna(row.size) else None
            items[key].prices.append(Price(size=size, usd=float(row.price)))
    return {cafe_id: list(items.values()) for cafe_id, items in menus.items()}


def seed(store, owners=()):
    """Add missing cafés and their menus; returns the ids that were added."""
    details = yaml.safe_load((REPO / "data" / "cafes.yaml").read_text(encoding="utf-8"))["cafes"]
    added = []
    for cafe_id, items in sorted(menus_from_ground_truth().items()):
        if store.get_cafe(cafe_id) is not None:
            continue
        store.upsert_cafe(Cafe(cafe_id=cafe_id, demo_data=True, **details[cafe_id]))
        store.save_menu_version(cafe_id, items, source="seed", scope="full")
        added.append(cafe_id)

    for phone, cafe_id in owners:
        cafe = store.get_cafe(cafe_id)
        if cafe is None:
            sys.exit(f"No café {cafe_id!r}. Choose from: {', '.join(c.cafe_id for c in store.list_cafes())}")
        phone_hash = hash_handle(phone)
        cafe.owner_phone_hash = phone_hash
        cafe.owner_phone = to_e164(phone) or phone      # what the app's ownerPhone holds
        store.upsert_cafe(cafe)
        store.upsert_user(User(phone_hash=phone_hash, role="owner", cafe_id=cafe_id))
    return added


def main():
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    parser = argparse.ArgumentParser()
    parser.add_argument("--reset", action="store_true", help="memory backend: delete the store file first")
    parser.add_argument("--owner", action="append", default=[], metavar="PHONE=CAFE_ID",
                        help="register a phone number as the owner of a café (repeatable)")
    parser.add_argument("--really-write-to-firestore", action="store_true",
                        help="allow seeding the invented demo cafés into a real Firestore project (not the emulator)")
    args = parser.parse_args()

    config = load_config()
    settings = config["agent"]["store"]
    if (settings["backend"] == "firestore" and not os.environ.get("FIRESTORE_EMULATOR_HOST")
            and not args.really_write_to_firestore):
        sys.exit("This would write the 22 invented demo cafés into the real Firestore project that the app uses.\n"
                 "Use the emulator (set FIRESTORE_EMULATOR_HOST), or pass --really-write-to-firestore if you mean it.\n"
                 "To only link an owner to a café that already exists, you don't need this script: set the café's ownerPhone.")
    if args.reset:
        if settings["backend"] != "memory":
            sys.exit("--reset only works with the memory backend. Delete Firestore data in the Firebase console.")
        (REPO / settings["path"]).unlink(missing_ok=True)

    owners = []
    for pair in args.owner:
        if "=" not in pair:
            sys.exit(f"--owner needs PHONE=CAFE_ID, got {pair!r}")
        owners.append(tuple(pair.split("=", 1)))

    store = open_store(config)
    added = seed(store, owners)
    cafes = store.list_cafes()
    items = sum(len(store.get_current_menu(cafe.cafe_id).items) for cafe in cafes)
    print(f"Store ({settings['backend']}): {len(cafes)} cafés, {items} menu items. Added now: {len(added)}.")
    for phone, cafe_id in owners:
        print(f"Owner of {cafe_id}: {phone}")
    print("Addresses, hours and vibes are invented demo data (data/cafes.yaml).")


if __name__ == "__main__":
    main()
