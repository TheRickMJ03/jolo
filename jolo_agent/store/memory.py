"""The store as one JSON file (or only in memory). For tests and for working
before Firebase access arrives. One process at a time."""

import copy
import json
import os
from pathlib import Path

from jolo_agent.store.base import Store


class MemoryStore(Store):
    def __init__(self, path=None):
        """path: the JSON file to load and keep up to date, or None for memory only."""
        super().__init__()
        self.path = Path(path) if path else None
        self.data = {}        # collection -> {doc id: document}
        if self.path and self.path.exists():
            self.data = json.loads(self.path.read_text(encoding="utf-8"))

    def _write(self):
        if not self.path:
            return
        self.path.parent.mkdir(parents=True, exist_ok=True)
        temporary = self.path.with_suffix(".tmp")
        temporary.write_text(json.dumps(self.data, ensure_ascii=False), encoding="utf-8")
        os.replace(temporary, self.path)      # never leaves a half-written file behind

    def _get(self, collection, doc_id):
        with self._lock:
            return copy.deepcopy(self.data.get(collection, {}).get(doc_id))

    def _set(self, collection, doc_id, data):
        with self._lock:
            self.data.setdefault(collection, {})[doc_id] = copy.deepcopy(data)
            self._write()

    def _delete(self, collection, doc_id):
        with self._lock:
            if self.data.get(collection, {}).pop(doc_id, None) is not None:
                self._write()

    def _list(self, collection):
        with self._lock:
            return copy.deepcopy(list(self.data.get(collection, {}).values()))
