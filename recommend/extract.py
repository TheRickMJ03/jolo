"""Turn blog-finder's trend report into drink names.

A phrase is kept when it contains a drink word. Rising terms sort ahead of
phrases that are only common. A summary from the model can add names; the
phrase list is enough when the model is absent. Post titles, when the scraper
still has them, extend a short phrase into the drink a person would order.
"""
from __future__ import annotations

import re
from collections import Counter

DRINK_WORDS = (
    "cold brew",
    "latte",
    "cortado",
    "espresso",
    "americano",
    "cappuccino",
    "mocha",
    "matcha",
    "chai",
    "tea",
    "tonic",
    "spritz",
)

_PHRASES = {word for word in DRINK_WORDS if " " in word}
_SINGLES = {word for word in DRINK_WORDS if " " not in word}

# Words that sit in front of a drink in a headline and are not part of its name.
_TITLE_STOP = {
    "the", "a", "an", "why", "how", "best", "new", "this", "that", "with", "for",
    "and", "our", "your", "its", "from", "into", "over", "cafe", "cafes", "coffee",
    "shop", "are", "is", "to", "of", "on", "in", "at", "it", "pouring", "works",
    "order", "recipe", "trend", "everywhere", "taking", "what", "your",
}


def _has(needle: str, text: str) -> bool:
    return re.search(rf"\b{re.escape(needle)}\b", text.lower()) is not None


def contains_drink(text: str) -> bool:
    return any(_has(word, text) for word in DRINK_WORDS)


def drink_spans(title: str) -> list[str]:
    """The drink named in a headline, plus up to three words in front of it."""
    tokens = re.findall(r"[a-z0-9']+", title.lower())
    spans: list[str] = []
    index = 0
    while index < len(tokens):
        pair = " ".join(tokens[index : index + 2])
        if pair in _PHRASES:
            end = index + 2
        elif tokens[index] in _SINGLES:
            end = index + 1
        else:
            index += 1
            continue
        start = index
        while start > 0 and tokens[start - 1] not in _TITLE_STOP and tokens[start - 1] not in _SINGLES:
            start -= 1
        if index - start > 3:
            start = index - 3
        span = " ".join(tokens[start:end])
        if span not in spans:
            spans.append(span)
        index = end
    return spans


def _display(name: str) -> str:
    lowered = " ".join(name.lower().split())
    if not lowered:
        return lowered
    return lowered[0].upper() + lowered[1:]


def extract_drinks(trends: dict | None) -> list[dict]:
    """[{name, momentum, source}] — rising first, then longer names."""
    trends = trends or {}
    found: dict[str, dict] = {}

    def add(name: str, momentum: str, source: str) -> None:
        cleaned = " ".join((name or "").lower().split())
        if not cleaned or not contains_drink(cleaned):
            return
        current = found.get(cleaned)
        if current is None:
            found[cleaned] = {"name": _display(cleaned), "momentum": momentum, "source": source}
            return
        if momentum == "rising":
            current["momentum"] = "rising"
            current["source"] = source

    rising_terms: list[str] = []
    for row in (trends.get("momentum") or {}).get("rising") or []:
        term = (row.get("term") or "").strip()
        if contains_drink(term):
            rising_terms.append(term.lower())
            add(term, "rising", "rising")

    for row in trends.get("top_phrases") or []:
        add(row.get("term") or "", "steady", "phrase")

    for row in trends.get("top_words") or []:
        term = (row.get("term") or "").strip().lower()
        if term in _SINGLES or term in _PHRASES:
            add(term, "steady", "word")

    summary = trends.get("ai") or {}
    for key in ("emerging", "themes"):
        for row in summary.get(key) or []:
            if isinstance(row, dict):
                add(row.get("name") or "", "steady", "summary")

    counts: Counter[str] = Counter()
    for title in trends.get("titles") or []:
        for span in drink_spans(title):
            counts[span] += 1
    for span, count in counts.items():
        covered = any(term in span for term in rising_terms)
        if count < 2 and not covered:
            continue
        add(span, "rising" if covered else "steady", "title")

    for short in list(found):
        if " " not in short:
            continue
        if any(short != long and short in long for long in found):
            del found[short]

    drinks = list(found.values())
    drinks.sort(key=lambda drink: (0 if drink["momentum"] == "rising" else 1, -len(drink["name"]), drink["name"]))
    return drinks[:30]
