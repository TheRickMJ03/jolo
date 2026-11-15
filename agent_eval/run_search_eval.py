"""Score café search on agent_eval/queries.yaml.

Usage (from the repo root, venv active, after seed_store.py and build_index.py):
    python agent_eval/run_search_eval.py
    python agent_eval/run_search_eval.py --no-rerank     # skip the slow setup

Needs no model server: search runs on the CPU. Setups compared:
    keyword only (BM25) · vectors only · keyword + vectors · keyword + vectors + reranker

Metrics, per setup, averaged over the queries:
    nDCG@5     how good the 5 cafés handed to the agent are, and their order
    Recall@20  first-stage retrieval: the share of relevant cafés (grade >= 2)
               that have at least one document among the top 20 document hits.
               (Counted on documents, because with 22 cafés "the top 20 cafés"
               would be nearly all of them.)

Results are printed and saved to agent_eval/results/search.json.
"""

import argparse
import json
import sys
import time
from pathlib import Path

import yaml

REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO))

from menu_reader.config import load_config                                # noqa: E402
from agent_eval.metrics import ndcg_at, recall                            # noqa: E402
from jolo_agent.search import CafeSearch, SearchIndex, load_models        # noqa: E402
from jolo_agent.store import open_store                                   # noqa: E402

SETUPS = [("keyword (BM25)", "bm25", False), ("vectors", "vector", False),
          ("keyword + vectors", "hybrid", False), ("keyword + vectors + reranker", "hybrid", True)]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--no-rerank", action="store_true", help="skip the reranker setup")
    parser.add_argument("--rerank-top", type=int, help="how many cafés the reranker scores (config: agent.search.rerank_top)")
    parser.add_argument("--device", choices=["cpu", "cuda", "auto"], help="where the retrieval models run (config: agent.search.device)")
    parser.add_argument("--rerank-min-words", type=int, help="skip the reranker for shorter queries (config: agent.search.rerank_min_words)")
    args = parser.parse_args()
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

    config = load_config()
    for value, key in ((args.rerank_top, "rerank_top"), (args.device, "device"), (args.rerank_min_words, "rerank_min_words")):
        if value is not None:
            config["agent"]["search"][key] = value      # measure a setting without editing config.yaml
    store = open_store(config)
    embedder, reranker, notes = load_models(config)
    index = SearchIndex(REPO / config["agent"]["search"]["index_dir"], embedder)
    if not index.rows:
        sys.exit("The index is empty. Run scripts/seed_store.py, then scripts/build_index.py.")
    for note in notes:
        print("Note:", note)
    search = CafeSearch(store, index, config, reranker)
    queries = yaml.safe_load((REPO / "agent_eval" / "queries.yaml").read_text(encoding="utf-8"))["queries"]
    known = {cafe.cafe_id for cafe in store.list_cafes()}
    for query in queries:
        unknown = set(query["relevant"]) - known
        if unknown:
            sys.exit(f"{query['id']} names cafés that are not in the store: {sorted(unknown)}")

    rows = []
    for name, mode, rerank in SETUPS:
        if mode != "bm25" and not index.has_vectors:
            print(f"Skipping '{name}': the index has no vectors.")
            continue
        if rerank and (args.no_rerank or reranker is None):
            continue
        ndcgs, recalls, per_query = [], [], {}
        start = time.perf_counter()
        for query in queries:
            # No time or place filter, no bandit, nothing logged: only the ranking is measured.
            results = search.search(query["query"], mode=mode, rerank=rerank, bandit=False, record=False)
            ranked = [cafe["cafe_id"] for cafe in results["results"]]
            first_stage = [row["cafe_id"] for row, _score in index.search(query["query"], 20, mode)]
            per_query[query["id"]] = round(ndcg_at(ranked, query["relevant"]), 3)
            ndcgs.append(per_query[query["id"]])
            recalls.append(recall(first_stage, query["relevant"]))
        seconds = (time.perf_counter() - start) / len(queries)
        rows.append({"setup": name, "ndcg_at_5": round(sum(ndcgs) / len(ndcgs), 3),
                     "recall_at_20": round(sum(recalls) / len(recalls), 3),
                     "seconds_per_query": round(seconds, 2), "per_query_ndcg": per_query})

    settings = config["agent"]["search"]
    print(f"\n{len(queries)} queries, {len(known)} cafés, {len(index.rows)} documents. "
          f"device={settings.get('device', 'cpu')}, rerank_top={settings['rerank_top']}, "
          f"rerank_min_words={settings.get('rerank_min_words', 1)}\n")
    print(f"{'Setup':<32}{'nDCG@5':>8}{'Recall@20':>11}{'s/query':>9}")
    for row in rows:
        print(f"{row['setup']:<32}{row['ndcg_at_5']:>8.3f}{row['recall_at_20']:>11.3f}{row['seconds_per_query']:>9.2f}")
    if rows:
        worst = sorted(rows[-1]["per_query_ndcg"].items(), key=lambda pair: pair[1])[:5]
        texts = {query["id"]: query["query"] for query in queries}
        print(f"\nWeakest queries for '{rows[-1]['setup']}': "
              + ", ".join(f"{texts[query_id]} ({score})" for query_id, score in worst))

    out = REPO / "agent_eval" / "results" / "search.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps({"queries": len(queries), "setups": rows,
                               "settings": {key: settings.get(key) for key in ("device", "rerank_top", "rerank_min_words")}},
                              indent=2), encoding="utf-8")
    print(f"\nSaved to {out.relative_to(REPO)}")


if __name__ == "__main__":
    main()
