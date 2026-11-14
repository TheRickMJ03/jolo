"""Does learning from picks help? A simulation, NOT a measurement on real users.

Usage (from the repo root, venv active, after seed_store.py and build_index.py):
    python agent_eval/simulate.py                       # 200 users, 5 rounds, 5 repeats
    python agent_eval/simulate.py --rerank              # with the reranker (slow the first time)
    python agent_eval/simulate.py --llm-queries         # the model rewords the queries (needs the model server)

What is simulated
    Every café gets a hidden "appeal" between 0.1 and 0.9: how often people who
    are shown it for a fitting query go there. The search can't see it.
    A simulated user sends one of the 50 labelled queries (agent_eval/queries.yaml),
    reads the suggestions top to bottom and picks the first one they like; the
    chance of liking a café is (its relevance grade / 3) x (appeal, plus a little
    personal taste). Searches and picks go to the events log like real ones.
    In each round every user searches once.

What is compared
    the same users and queries with the bandit off (ranking never changes) and
    on (Thompson sampling on each café's shown/picked counts, jolo_agent/search/cafes.py).

What is scored
    nDCG@5 where a café's worth is grade x appeal: the best list is relevant AND
    made of cafés people actually go to.

Because the appeal is invented and the users follow the rule above, this shows
that the feedback loop is wired up and moves the ranking the right way under
those assumptions. It says nothing about how real customers behave.

Also written: agent_eval/results/preference_pairs.jsonl, (query, picked café,
café that was shown higher but skipped) triples in the shape a reranker
fine-tune would need. They come from the simulated picks, so they are only
good for testing a training script.
"""

import argparse
import copy
import json
import math
import random
import sys
from pathlib import Path

import yaml

REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO))
sys.path.insert(0, str(REPO / "scripts"))

from menu_reader.config import load_config                                # noqa: E402
from jolo_agent.search import CafeSearch, SearchIndex, load_models        # noqa: E402
from jolo_agent.store import MemoryStore                                  # noqa: E402
from seed_store import seed                                               # noqa: E402

RESULTS = REPO / "agent_eval" / "results"


class CachedEmbedder:
    """The same 50 queries are searched thousands of times; embed each one once."""

    def __init__(self, embedder):
        self.embedder = embedder
        self.cache = {}

    def embed_documents(self, texts):
        return self.embedder.embed_documents(texts)

    def embed_query(self, text):
        if text not in self.cache:
            self.cache[text] = self.embedder.embed_query(text)
        return self.cache[text]


class CachedReranker:
    def __init__(self, reranker):
        self.reranker = reranker
        self.cache = {}

    def score(self, query, documents, **options):
        missing = [text for text in documents if (query, text) not in self.cache]
        if missing:
            for text, score in zip(missing, self.reranker.score(query, missing, **options)):
                self.cache[(query, text)] = score
        return [self.cache[(query, text)] for text in documents]


def ndcg_at_5(ranked, worth):
    """nDCG@5 with a café's worth (grade x appeal) as the gain."""
    def dcg(values):
        return sum(value / math.log2(rank + 2) for rank, value in enumerate(values))
    ideal = dcg(sorted(worth.values(), reverse=True)[:5])
    return dcg([worth.get(cafe_id, 0.0) for cafe_id in ranked[:5]]) / ideal if ideal else 0.0


def reword_queries(queries, config):
    """--llm-queries: the model rewrites each query as a customer's text message. Labels stay."""
    from langchain_core.messages import HumanMessage, SystemMessage
    from jolo_agent.agent import ChatModel
    model = ChatModel(config)
    reworded = []
    for query in queries:
        answer = model.invoke([
            SystemMessage("Rewrite the search words as one short text message a customer would send to a "
                          "café guide. Keep the meaning. Answer with the message only."),
            HumanMessage(query["query"])])
        text = answer.content.strip().strip('"') if isinstance(answer.content, str) else ""
        reworded.append({**query, "query": text or query["query"]})
    return reworded


def run(config, index, reranker, queries, appeal, users, rounds, seed_number, use_bandit, pairs=None):
    """nDCG@5 per round for one setup. Fills `pairs` with preference pairs if given."""
    store = MemoryStore()
    seed(store)
    cafes = {cafe.cafe_id: cafe for cafe in store.list_cafes()}
    search = CafeSearch(store, index, config, reranker, rng=random.Random(seed_number))
    rng = random.Random(1000 + seed_number)       # the users: the same with the bandit on and off
    taste = [{cafe_id: rng.gauss(0, 0.1) for cafe_id in cafes} for _user in range(users)]

    per_round = []
    for _round in range(rounds):
        scores = []
        for user in range(users):
            query = rng.choice(queries)
            phone_hash = f"sim-{user}"
            found = search.search(query["query"], phone_hash=phone_hash, rerank=reranker is not None,
                                  bandit=use_bandit, record=True)
            shown = [cafe["cafe_id"] for cafe in found["results"]]
            worth = {cafe_id: grade * appeal[cafe_id] for cafe_id, grade in query["relevant"].items()}
            scores.append(ndcg_at_5(shown, worth))
            for position, cafe_id in enumerate(shown):
                liking = query["relevant"].get(cafe_id, 0) / 3 * min(max(appeal[cafe_id] + taste[user][cafe_id], 0), 1)
                if rng.random() < liking:
                    store.add_event("pick", cafe_id=cafe_id, phone_hash=phone_hash, data={"query": query["query"]})
                    if pairs is not None:
                        for skipped in shown[:position]:
                            pairs.append({"query": query["query"], "picked": cafe_id, "skipped": skipped,
                                          "positive": describe(cafes[cafe_id]), "negative": describe(cafes[skipped]),
                                          "simulated": True})
                    break
        per_round.append(sum(scores) / len(scores))
    return per_round


def describe(cafe):
    return ". ".join(part for part in (cafe.name, cafe.vibe, cafe.summary) if part)


def chart(rounds, off, on, title, path):
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    figure, axes = plt.subplots(figsize=(7, 4.2))
    xs = list(range(1, rounds + 1))
    for runs, label, colour in ((off, "bandit off", "#888888"), (on, "bandit on (Thompson sampling)", "#1f77b4")):
        mean = [sum(run[r] for run in runs) / len(runs) for r in range(rounds)]
        axes.plot(xs, mean, marker="o", label=label, color=colour)
        axes.fill_between(xs, [min(run[r] for run in runs) for r in range(rounds)],
                          [max(run[r] for run in runs) for r in range(rounds)], color=colour, alpha=0.15)
    axes.set_xticks(xs)
    axes.set_xlabel("round (every simulated user searches once per round)")
    axes.set_ylabel("nDCG@5 (worth = relevance x hidden appeal)")
    axes.set_title(title, fontsize=10)
    axes.legend(loc="lower right")
    axes.grid(alpha=0.3)
    figure.tight_layout()
    figure.savefig(path, dpi=150)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--users", type=int, default=200)
    parser.add_argument("--rounds", type=int, default=5)
    parser.add_argument("--repeats", type=int, default=5, help="runs with different random users; the chart shows the mean and the range")
    parser.add_argument("--weight", type=float, help="bandit weight (default: agent.search.bandit.weight in config.yaml)")
    parser.add_argument("--rerank", action="store_true", help="use the reranker, as the live search does")
    parser.add_argument("--llm-queries", action="store_true", help="let the model reword the queries (needs the model server)")
    args = parser.parse_args()
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

    config = copy.deepcopy(load_config())
    settings = config["agent"]["search"]
    if args.weight is not None:
        settings["bandit"]["weight"] = args.weight
    if not args.rerank:
        settings["use_reranker"] = False
    embedder, reranker, _notes = load_models(config)
    index = SearchIndex(REPO / settings["index_dir"], CachedEmbedder(embedder) if embedder else None)
    if not index.rows:
        sys.exit("The index is empty. Run scripts/seed_store.py, then scripts/build_index.py.")
    reranker = CachedReranker(reranker) if reranker else None
    queries = yaml.safe_load((REPO / "agent_eval" / "queries.yaml").read_text(encoding="utf-8"))["queries"]
    if args.llm_queries:
        queries = reword_queries(queries, config)

    cafe_ids = sorted({row["cafe_id"] for row in index.rows})
    appeal_rng = random.Random(7)
    appeal = {cafe_id: appeal_rng.uniform(0.1, 0.9) for cafe_id in cafe_ids}

    off, on, pairs = [], [], []
    for repeat in range(args.repeats):
        off.append(run(config, index, reranker, queries, appeal, args.users, args.rounds, repeat, False))
        on.append(run(config, index, reranker, queries, appeal, args.users, args.rounds, repeat, True,
                      pairs if repeat == 0 else None))
        print(f"repeat {repeat + 1}/{args.repeats} done")

    def mean(runs, r):
        return sum(run[r] for run in runs) / len(runs)

    print(f"\nSIMULATED: {args.users} users x {args.rounds} rounds, {args.repeats} repeats, "
          f"bandit weight {settings['bandit']['weight']}, reranker {'on' if reranker else 'off'}\n")
    print(f"{'round':<8}{'bandit off':>12}{'bandit on':>12}{'difference':>12}")
    for r in range(args.rounds):
        print(f"{r + 1:<8}{mean(off, r):>12.3f}{mean(on, r):>12.3f}{mean(on, r) - mean(off, r):>+12.3f}")
    wins = sum(run_on[-1] > run_off[-1] for run_on, run_off in zip(on, off))
    print(f"\nLast round: the bandit was ahead in {wins} of {args.repeats} repeats.")

    RESULTS.mkdir(parents=True, exist_ok=True)
    suffix = ("_rerank" if reranker else "") + (f"_w{args.weight}" if args.weight is not None else "")
    title = (f"SIMULATED users ({args.users} per round, {args.repeats} repeats, invented café appeal)\n"
             f"reranker {'on' if reranker else 'off'}, bandit weight {settings['bandit']['weight']}; "
             "line = mean, band = range")
    chart(args.rounds, off, on, title, RESULTS / f"simulated_feedback{suffix}.png")
    (RESULTS / f"simulated_feedback{suffix}.json").write_text(json.dumps({
        "simulated": True, "users": args.users, "rounds": args.rounds, "repeats": args.repeats,
        "bandit_weight": settings["bandit"]["weight"], "reranker": reranker is not None,
        "llm_queries": args.llm_queries, "appeal": appeal, "ndcg_at_5_bandit_off": off, "ndcg_at_5_bandit_on": on,
    }, indent=2), encoding="utf-8")
    with (RESULTS / f"preference_pairs{suffix}.jsonl").open("w", encoding="utf-8") as file:
        for pair in pairs:
            file.write(json.dumps(pair, ensure_ascii=False) + "\n")
    print(f"Chart: agent_eval/results/simulated_feedback{suffix}.png")
    print(f"{len(pairs)} simulated preference pairs: agent_eval/results/preference_pairs{suffix}.jsonl")


if __name__ == "__main__":
    main()
