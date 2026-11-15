"""Add the real Princeton cafés (data/cafes_osm.yaml) to the store, next to the invented demo ones.

Usage (from the repo root, venv active):
    python scripts/import_osm_cafes.py          # 1. fetch the cafés from OpenStreetMap
    python scripts/load_real_cafes.py           # 2. put them in the store
    python scripts/load_real_cafes.py --menus data/real_menus.yaml    # 3. also add menus (optional)
    python scripts/build_index.py               # 4. rebuild search

Pushing to the app's Firestore later (once the team's schema and rules are settled):
    python scripts/load_real_cafes.py --dry-run
    set agent.store.backend: firestore in config.yaml, GOOGLE_APPLICATION_CREDENTIALS=<key.json>
    python scripts/load_real_cafes.py --really-write-to-firestore
Existing café documents are left alone; only missing ones are created, and the app's own fields are
never overwritten. Menus then come from the owners, through the normal photo flow.

Real cafés are stored with demo_data=False. A café with no menu stays at version 0 ("menu coming
soon"): it can be found by name and place, but not by drink. The owner's own photo replaces any menu
added here the moment they send it.

--menus file format (you write it; see data/real_menus.example.yaml):
    <cafe_id>:
      source: public_menu | inferred
      items:
        - {item: Cortado, category: drink, price: 4.25}      # price optional
Every item from a file like this is labelled in the store as NOT owner-provided.
"""

import argparse
import os
import sys
from pathlib import Path

import yaml

REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO))

from menu_reader.config import load_config                          # noqa: E402
from menu_reader.schema import MenuItem, Price                      # noqa: E402
from jolo_agent.store import Cafe, open_store                       # noqa: E402


def load_cafes(store, path):
    raw = yaml.safe_load(Path(path).read_text(encoding="utf-8"))["cafes"]
    added = 0
    for cafe_id, data in raw.items():
        if store.get_cafe(cafe_id) is not None:
            continue
        store.upsert_cafe(Cafe(
            cafe_id=cafe_id, name=data["name"], address=data.get("address"),
            lat=data.get("lat"), lng=data.get("lng"), hours=data.get("hours") or {},
            vibe=data.get("vibe") or None, summary=data.get("summary") or None, demo_data=False))
        added += 1
    return added


def load_menus(store, path):
    raw = yaml.safe_load(Path(path).read_text(encoding="utf-8")) or {}
    saved = 0
    for cafe_id, entry in raw.items():
        cafe = store.get_cafe(cafe_id)
        if cafe is None:
            print(f"  skipped {cafe_id}: not in the store")
            continue
        if cafe.current_version and store.get_current_menu(cafe_id).source in ("photo", "owner_text", "app"):
            print(f"  skipped {cafe_id}: the owner already sent a menu")
            continue
        source = entry["source"]
        if source not in ("public_menu", "inferred"):
            sys.exit(f"{cafe_id}: source must be public_menu or inferred, got {source!r}")
        items = []
        for row in entry["items"]:
            price = row.get("price")
            if source == "inferred":
                price = None                           # review text never becomes a price
            items.append(MenuItem(item=row["item"], category=row.get("category", "drink"),
                                  prices=[Price(size=None, usd=float(price))] if price is not None else [],
                                  confidence=0.5 if source == "inferred" else 0.9))
        store.save_menu_version(cafe_id, items, source=source, scope="full")
        saved += 1
    return saved


def main():
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    parser = argparse.ArgumentParser()
    parser.add_argument("--cafes", default="data/cafes_osm.yaml")
    parser.add_argument("--menus", help="YAML of public-menu or inferred items (see the docstring)")
    parser.add_argument("--dry-run", action="store_true", help="list the cafés that would be added; write nothing")
    parser.add_argument("--really-write-to-firestore", action="store_true",
                        help="allow writing to the real Firestore project (not the emulator)")
    args = parser.parse_args()
    config = load_config()
    backend = config["agent"]["store"]["backend"]
    if args.dry_run:
        raw = yaml.safe_load((REPO / args.cafes).read_text(encoding="utf-8"))["cafes"]
        print(f"Would add up to {len(raw)} real cafés to the {backend} store:")
        for cafe_id, data in sorted(raw.items()):
            print(f"  {cafe_id:<40} {data['name']}")
        return
    if backend == "firestore" and not os.environ.get("FIRESTORE_EMULATOR_HOST") and not args.really_write_to_firestore:
        sys.exit("This writes real cafés into the real Firestore project that the app uses.\n"
                 "Try it on the emulator first (set FIRESTORE_EMULATOR_HOST), or pass --really-write-to-firestore.\n"
                 "Use --dry-run to see what would be written.")
    store = open_store(config)
    print(f"Added {load_cafes(store, REPO / args.cafes)} real cafés.")
    if args.menus:
        print(f"Saved {load_menus(store, REPO / args.menus)} menus (labelled as not owner-provided).")
    real = [c for c in store.list_cafes() if not c.demo_data]
    without = [c.name for c in real if not c.current_version]
    print(f"Real cafés in the store: {len(real)}; menu coming soon: {len(without)}.")


if __name__ == "__main__":
    main()
