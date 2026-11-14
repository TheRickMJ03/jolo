"""Rebuild the search index from the store.

Usage (from the repo root, venv active):
    python scripts/build_index.py

Run it after seeding the store, and whenever the store was edited from
outside the agent (Isaiah's app writes to Firestore directly). The agent
itself re-indexes a café each time it saves a menu version.

The first run downloads Qwen3-Embedding-0.6B (about 1.2 GB) to models/hf.
Documents whose text didn't change keep their vectors, so later runs are quick.
"""

import sys
import time
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO))

from menu_reader.config import load_config                                   # noqa: E402
from jolo_agent.search import SearchIndex, load_models, store_docs           # noqa: E402
from jolo_agent.store import open_store                                      # noqa: E402


def main():
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    config = load_config()
    store = open_store(config)
    embedder, _reranker, notes = load_models(config)
    for note in notes:
        print("Note:", note)

    docs = store_docs(store)
    if not docs:
        sys.exit("The store is empty. Run scripts/seed_store.py first.")
    index = SearchIndex(REPO / config["agent"]["search"]["index_dir"], embedder)
    start = time.perf_counter()
    count = index.rebuild(docs)
    cafes = sum(1 for doc in docs if doc["kind"] == "cafe")
    print(f"Indexed {count} documents ({cafes} cafés, {count - cafes} menu items) "
          f"in {time.perf_counter() - start:.1f} s. Vectors: {'yes' if index.has_vectors else 'no, keyword search only'}.")


if __name__ == "__main__":
    main()
