"""search_cafes: from a customer's words to a few cafés, with the reasons.

    1. keyword + vector search over café and menu-item documents
    2. group the hits by café; the matching items become the "why"
    3. filter in code: open now, within distance
    4. Qwen3-Reranker-0.6B orders the cafés that are left
    5. (optional) Thompson sampling nudges cafés with little feedback up, so
       they get a chance to collect some
"""

import random

from jolo_agent.places import is_open, local_now, miles_between, resolve_location


def feedback_counts(store):
    """{cafe_id: (times shown, times picked)} from the events log."""
    shown, picked = {}, {}
    for event in store.list_events("search"):
        for cafe_id in event.data.get("shown", []):
            shown[cafe_id] = shown.get(cafe_id, 0) + 1
    for event in store.list_events("pick"):
        if event.cafe_id:
            picked[event.cafe_id] = picked.get(event.cafe_id, 0) + 1
    return {cafe_id: (shown.get(cafe_id, 0), picked.get(cafe_id, 0)) for cafe_id in set(shown) | set(picked)}


def thompson_sample(shown, picked, rng):
    """One draw from Beta(1 + picks, 1 + shown-but-not-picked): a guess at the pick rate.

    A café shown twice gets wide, sometimes high draws; a café shown 200 times
    and rarely picked gets consistently low ones.
    """
    return rng.betavariate(1 + picked, 1 + max(shown - picked, 0))


class CafeSearch:
    def __init__(self, store, index, config, reranker=None, rng=None):
        self.store = store
        self.index = index
        self.settings = config["agent"]["search"]
        self.timezone = config["agent"]["timezone"]
        self.reranker = reranker
        self.rng = rng or random.Random()

    def _candidates(self, query, mode):
        """{cafe_id: {"score", "items": [matching item rows]}} from the document hits."""
        found = {}
        hits = self.index.search(query, self.settings["candidates"], mode)
        best = hits[0][1] if hits else 0.0
        for row, score in hits:
            entry = found.setdefault(row["cafe_id"], {"score": 0.0, "docs": 0, "items": []})
            if entry["docs"] < 3:               # a long menu shouldn't win on volume alone
                entry["score"] += score
                entry["docs"] += 1
            # Only strong hits are shown as the reason; a distant neighbour would mislead.
            if row["kind"] == "item" and len(entry["items"]) < 3 and score >= 0.5 * best:
                entry["items"].append(row)
        return found

    def search(self, query, near=None, open_now=False, max_miles=None, now=None,
               phone_hash=None, mode="hybrid", rerank=True, bandit=None, record=True):
        """Returns {"results": [...], "note": str or None}.

        near: a landmark, a café name or "lat,lng"; None when the customer gave no place.
        mode / rerank / bandit: for the evaluation, to switch stages off.
        """
        cafes = {cafe.cafe_id: cafe for cafe in self.store.list_cafes()}
        found = self._candidates(query, mode)
        if not found:       # "what's open near me?" names no dish: every café is a candidate
            found = {cafe_id: {"score": 0.0, "items": []} for cafe_id in cafes}

        note = None
        origin = resolve_location(near, cafes.values()) if near else None
        if near and origin is None:
            note = (f'I don\'t know where "{near}" is, so distances are left out. '
                    "Ask the customer for a landmark or a street corner.")
        now = now or local_now(self.timezone)
        limit = max_miles if max_miles is not None else self.settings["max_miles"]

        results = []
        for cafe_id, entry in found.items():
            cafe = cafes.get(cafe_id)
            if cafe is None:
                continue
            open_state = is_open(cafe.hours, now)
            if open_now and open_state is not True:
                continue
            miles = None
            if origin and cafe.lat is not None and cafe.lng is not None:
                miles = round(miles_between(origin, (cafe.lat, cafe.lng)), 1)
                if miles > limit:
                    continue
            results.append({"cafe": cafe, "score": entry["score"], "items": entry["items"],
                            "miles": miles, "open_now": open_state})
        results.sort(key=lambda r: (-r["score"], r["miles"] if r["miles"] is not None else 0.0, r["cafe"].name))

        # Rerank the best few. The reranker reads the café and why it matched.
        top = results[:self.settings["rerank_top"]]
        if top:
            best = max(result["score"] for result in top) or 1.0
            for result in top:
                result["relevance"] = result["score"] / best
            if rerank and self.reranker and len(query.split()) >= self.settings.get("rerank_min_words", 1):
                texts = [self._describe(result) for result in top]
                for result, score in zip(top, self.reranker.score(query, texts)):
                    result["relevance"] = score
            use_bandit = self.settings["bandit"]["enabled"] if bandit is None else bandit
            if use_bandit:
                counts = feedback_counts(self.store)
                for result in top:
                    shown, picked = counts.get(result["cafe"].cafe_id, (0, 0))
                    result["relevance"] += self.settings["bandit"]["weight"] * thompson_sample(shown, picked, self.rng)
            top.sort(key=lambda r: -r["relevance"])
        top = top[:self.settings["results"]]

        if record and top:
            self.store.add_event("search", phone_hash=phone_hash,
                                 data={"query": query, "shown": [result["cafe"].cafe_id for result in top]})
        return {"results": [self._public(result) for result in top], "note": note}

    @staticmethod
    def _describe(result):
        cafe = result["cafe"]
        text = ". ".join(part for part in (cafe.name, cafe.vibe, cafe.summary) if part)
        if result["items"]:
            text += ". Matching items: " + ", ".join(row["name"] for row in result["items"])
        return text

    @staticmethod
    def _public(result):
        """What the agent sees. No scores: the model would be tempted to quote them."""
        cafe = result["cafe"]
        out = {"cafe_id": cafe.cafe_id, "name": cafe.name, "vibe": cafe.vibe, "summary": cafe.summary,
               "address": cafe.address,
               "matching_items": [{"item": row["name"], "prices": row["prices"]} for row in result["items"]]}
        if result["miles"] is not None:
            out["miles"] = result["miles"]
        if result["open_now"] is not None:
            out["open_now"] = result["open_now"]
        return out
