"""The search index: one document per café and one per menu item, in LanceDB.

Two ways of finding documents, combined:
    BM25                    the words match ("cortado")
    Qwen3-Embedding-0.6B    the meaning matches ("somewhere calm to work")

Firestore stays the source of truth. This index can always be thrown away and
rebuilt from the store (scripts/build_index.py).
"""

import lancedb
from rank_bm25 import BM25Okapi

from menu_reader.compare import _key
from jolo_agent.menu_ops import format_prices

TABLE = "docs"
RRF_K = 60      # reciprocal rank fusion: score = sum of 1 / (60 + rank)


def cafe_docs(cafe, items):
    """The documents for one café: the café itself, then each menu item."""
    about = ". ".join(part for part in (cafe.name, cafe.vibe, cafe.summary) if part)
    docs = [{"id": f"{cafe.cafe_id}#cafe", "cafe_id": cafe.cafe_id, "kind": "cafe",
             "name": cafe.name, "text": about, "prices": ""}]
    for number, item in enumerate(items):
        section = f" ({item.section})" if item.section else ""
        variants = f". Flavors: {', '.join(item.variants)}" if item.variants else ""
        docs.append({"id": f"{cafe.cafe_id}#item{number}", "cafe_id": cafe.cafe_id, "kind": "item",
                     "name": item.item, "text": f"{item.item}{section}, {item.category} at {cafe.name}{variants}",
                     "prices": format_prices(item) if item.prices else ""})
    return docs


def store_docs(store):
    docs = []
    for cafe in store.list_cafes():
        version = store.get_current_menu(cafe.cafe_id)
        docs.extend(cafe_docs(cafe, version.items if version else []))
    return docs


def tokens(text):
    return _key(text).split()


class SearchIndex:
    def __init__(self, index_dir, embedder=None):
        """embedder: has embed_documents(texts) and embed_query(text), or None for keyword search only."""
        self.db = lancedb.connect(str(index_dir))
        self.embedder = embedder
        self.rows = []
        self.table = None
        self._bm25 = None
        if TABLE in self._table_names():
            self.table = self.db.open_table(TABLE)
            self._set_rows(self.table.to_arrow().to_pylist())

    def _table_names(self):
        listed = self.db.list_tables()
        return list(getattr(listed, "tables", listed))      # newer LanceDB returns an object, older a list

    def _set_rows(self, rows):
        self.rows = rows
        self._by_id = {row["id"]: row for row in rows}
        self._bm25 = BM25Okapi([tokens(row["text"]) for row in rows]) if rows else None

    @property
    def has_vectors(self):
        return bool(self.rows) and self.rows[0].get("vector") is not None

    def _write(self, rows):
        """Replace the table. Rows without a vector are embedded; with no embedder, vectors are dropped."""
        if self.embedder:
            missing = [row for row in rows if row.get("vector") is None]
            if missing:
                for row, vector in zip(missing, self.embedder.embed_documents([row["text"] for row in missing])):
                    row["vector"] = vector
        else:
            for row in rows:
                row.pop("vector", None)
        if rows:
            self.table = self.db.create_table(TABLE, data=rows, mode="overwrite")
        elif TABLE in self._table_names():
            self.db.drop_table(TABLE)
            self.table = None
        self._set_rows(rows)

    def rebuild(self, docs):
        """Index exactly these documents. A document whose text didn't change keeps its vector."""
        old = {row["id"]: row for row in self.rows}
        rows = []
        for doc in docs:
            row = dict(doc)
            before = old.get(doc["id"])
            if before and before["text"] == doc["text"] and before.get("vector") is not None:
                row["vector"] = before["vector"]
            rows.append(row)
        self._write(rows)
        return len(rows)

    def reindex_cafe(self, cafe_id, docs):
        """Replace one café's documents, after its menu changed."""
        return self.rebuild([row for row in self.rows if row["cafe_id"] != cafe_id] + list(docs))

    def search(self, query, limit=50, mode="hybrid"):
        """[(row, score)], best first. mode: hybrid | bm25 | vector."""
        if not self.rows:
            return []
        rankings = []
        if mode in ("hybrid", "bm25"):
            scores = self._bm25.get_scores(tokens(query))
            order = sorted((index for index, score in enumerate(scores) if score > 0),
                           key=lambda index: -scores[index])
            rankings.append([self.rows[index]["id"] for index in order[:limit]])
        if mode in ("hybrid", "vector") and self.embedder and self.has_vectors:
            hits = self.table.search(self.embedder.embed_query(query)).limit(limit).to_list()
            rankings.append([hit["id"] for hit in hits])
        fused = {}
        for ranking in rankings:
            for rank, doc_id in enumerate(ranking):
                fused[doc_id] = fused.get(doc_id, 0.0) + 1.0 / (RRF_K + rank + 1)
        best = sorted(fused.items(), key=lambda pair: -pair[1])[:limit]
        return [(self._by_id[doc_id], score) for doc_id, score in best]
