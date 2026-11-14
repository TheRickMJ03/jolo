"""Café search: index, retrieval models and the search_cafes logic."""

from menu_reader.config import REPO
from jolo_agent.search.cafes import CafeSearch
from jolo_agent.search.index import SearchIndex, cafe_docs, store_docs
from jolo_agent.search.models import load_models

__all__ = ["CafeSearch", "SearchIndex", "cafe_docs", "store_docs", "load_models", "open_search"]


def open_search(store, config):
    """(CafeSearch, notes). Builds the index from the store when it is empty."""
    embedder, reranker, notes = load_models(config)
    index = SearchIndex(REPO / config["agent"]["search"]["index_dir"], embedder)
    if not index.rows:
        index.rebuild(store_docs(store))
        notes.append(f"built the search index: {len(index.rows)} documents")
    elif embedder and not index.has_vectors:
        notes.append("the index has no vectors yet: run scripts/build_index.py (keyword search until then)")
    return CafeSearch(store, index, config, reranker), notes
