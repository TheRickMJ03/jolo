#!/bin/sh
set -e
cd /app

# First start (empty volume): fill the store and build the search index.
# Not with Firestore: that is the shared database, and the demo cafés must never be written to it.
if [ "$JOLO_STORE_BACKEND" = "firestore" ]; then
  echo "Store: Firestore. Skipping the local seed; the index is rebuilt from Firestore."
  if [ ! -d data/index ]; then python scripts/build_index.py || echo "Index build failed; search will be limited."; fi
elif [ ! -f data/store.json ]; then
  echo "First start: seeding the store..."
  if [ -n "$JOLO_OWNERS" ]; then
    set --; for o in $(echo "$JOLO_OWNERS" | tr ',' ' '); do set -- "$@" --owner "$o"; done
    python scripts/seed_store.py "$@"
  else
    python scripts/seed_store.py
  fi
  # The real Princeton cafés (no menus yet: owners add them). Skipped if the file is absent.
  if [ -f data/cafes_osm.yaml ]; then
    python scripts/load_real_cafes.py || echo "Could not load the real cafés."
  fi
fi
if [ "$JOLO_STORE_BACKEND" != "firestore" ] && [ ! -d data/index ]; then
  echo "Building the search index (downloads ~1.2 GB of models the first time)..."
  python scripts/build_index.py || echo "Index build failed; search will be limited."
fi

exec python -m uvicorn api.app:create_app --factory --host 0.0.0.0 --port 8080
