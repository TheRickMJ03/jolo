"""Signals for the owner Insights hub and the customer Social tab.

Every function here is pure: plain dicts in, plain dicts out, no Firestore and
no network, so the tests can pin each rule. job.py reads the database and the
scrapers, calls these, and writes the results:

    niches/{slug}                  one drink niche: drinks found, per source
    cafes/{id}/analytics/current   owner only: other shops, asks nearby, web trends
    areas/{areaId}                 anyone signed in: drinks trending on local menus

Scraped text never becomes a price or a café. A trend only reaches a customer
when a café near them is serving a drink it matches, at the menu's price.
"""
from __future__ import annotations

import re
from collections import Counter
from datetime import datetime, timedelta, timezone

from recommend.extract import drink_spans, extract_drinks
from recommend.match import fresh_score, name_overlap, _first_price, _low_confidence
from recommend.profile import coerce_time, extras_in

AREA_ID = "union-county-nj"
AREA_NAME = "Union County"
WINDOW_DAYS = 30
TOP = 10
SOURCE_LABELS = {"blogs": "café blogs", "reddit": "Reddit", "tiktok": "TikTok", "demo": "sample data"}
# A Reddit or TikTok headline counts on its own once this many people engaged with it.
LOUD_POST = 50


def _key(name: str) -> str:
    return " ".join(str(name or "").lower().split())


def _display(name: str) -> str:
    text = " ".join(str(name or "").split())
    return text[:1].upper() + text[1:]


# Words that mean a headline fragment, not a drink: "espresso machine",
# "latte comes", "I had afternoon tea".
_NOT_A_DRINK = {
    "i", "we", "you", "my", "our", "had", "have", "has", "is", "was", "are", "comes", "came",
    "taste", "tastes", "machine", "machines", "powder", "beans", "bean", "grinder", "maker",
    "cup", "cups", "shop", "shops", "recipe", "recipes", "near", "me",
}
_DRINK_ENDINGS = (
    "cold brew", "latte", "cortado", "espresso", "americano", "cappuccino", "mocha", "matcha",
    "chai", "tea", "tonic", "spritz", "macchiato", "flat white",
)


# Every café pours these; on their own they are not a trend.
_STAPLES = {"espresso", "latte", "cappuccino", "americano", "tea", "mocha", "macchiato", "milk latte"}


def is_drink_name(name: str) -> bool:
    """Something a person could order and a trend could be about: it ends in a
    drink, has no headline words, and is more than a menu staple."""
    words = re.findall(r"[a-z']+", _key(name))
    if not words or len(words) > 5 or any(word in _NOT_A_DRINK for word in words):
        return False
    if " ".join(words) in _STAPLES:
        return False
    return any(" ".join(words).endswith(ending) for ending in _DRINK_ENDINGS)


def _mentions(name: str, title: str) -> bool:
    return re.search(rf"\b{re.escape(_key(name))}\b", title.lower()) is not None


def _drinks_from_posts(posts: list[dict]) -> list[dict]:
    """Drink names in social headlines. A loud post counts even when it is the only one."""
    loud = Counter()
    for post in posts:
        if (post.get("engagement") or 0) >= LOUD_POST:
            for span in drink_spans(post.get("title") or ""):
                loud[span] += 1
    trends = {
        "titles": [post.get("title") or "" for post in posts],
        "top_phrases": [{"term": term} for term in loud],
    }
    return extract_drinks(trends)


def merge_drinks(per_source: dict[str, tuple[list[dict], list[dict]]]) -> list[dict]:
    """{source: (drinks, posts)} -> one list with every source a drink came from.

    `mentions` counts the posts, from any source, whose title names the drink.
    `example` is the most engaged of those posts, so the owner can open it.
    """
    all_posts = [post for _drinks, posts in per_source.values() for post in posts]
    merged: dict[str, dict] = {}
    for source, (drinks, _posts) in per_source.items():
        for drink in drinks:
            key = _key(drink.get("name"))
            if not key or not is_drink_name(key):
                continue
            row = merged.setdefault(
                key,
                {"name": _display(drink["name"]), "momentum": "steady", "sources": [], "mentions": 0, "example": None},
            )
            if source not in row["sources"]:
                row["sources"].append(source)
            if drink.get("momentum") == "rising":
                row["momentum"] = "rising"
    for row in merged.values():
        hits = [post for post in all_posts if _mentions(row["name"], post.get("title") or "")]
        row["mentions"] = len(hits)
        if hits:
            best = max(hits, key=lambda post: post.get("engagement") or 0)
            row["example"] = {"title": best.get("title"), "url": best.get("url"), "source": best.get("source")}
    rows = list(merged.values())
    rows.sort(key=lambda row: (0 if row["momentum"] == "rising" else 1, -row["mentions"], row["name"]))
    return rows


def niche_entry(niche: str, blogs: dict | None, social: dict | None, now: datetime, blog_error: str | None = None) -> dict:
    """The niches/{slug} document for one scrape of blogs plus social platforms."""
    per_source: dict[str, tuple[list[dict], list[dict]]] = {}
    sources: dict[str, dict] = {}
    if blogs is not None:
        per_source["blogs"] = (extract_drinks(blogs), blogs.get("posts") or [])
        sources["blogs"] = {"ok": True, "error": None, "posts": len(blogs.get("titles") or [])}
    else:
        sources["blogs"] = {"ok": False, "error": blog_error or "not run", "posts": 0}
    for platform, result in (social or {}).items():
        posts = result.get("posts") or []
        sources[platform] = {"ok": bool(result.get("ok")), "error": result.get("error"), "posts": len(posts)}
        if result.get("ok"):
            per_source[platform] = (_drinks_from_posts(posts), posts)
    return {"query": niche, "scrapedAt": now, "drinks": merge_drinks(per_source), "sources": sources}


def web_trends(niche_docs: list[dict], limit: int = 12) -> list[dict]:
    """Drinks across every cached niche, merged by name."""
    merged: dict[str, dict] = {}
    for doc in niche_docs or []:
        for drink in doc.get("drinks") or []:
            key = _key(drink.get("name"))
            if not key or not is_drink_name(key):
                continue
            row = merged.get(key)
            if row is None:
                merged[key] = {
                    "name": _display(drink["name"]),
                    "momentum": drink.get("momentum") or "steady",
                    "sources": list(drink.get("sources") or ([drink["source"]] if drink.get("source") else [])),
                    "mentions": int(drink.get("mentions") or 0),
                    "example": drink.get("example"),
                }
                continue
            if drink.get("momentum") == "rising":
                row["momentum"] = "rising"
            for source in drink.get("sources") or []:
                if source not in row["sources"]:
                    row["sources"].append(source)
            row["mentions"] += int(drink.get("mentions") or 0)
            row["example"] = row["example"] or drink.get("example")
    rows = list(merged.values())
    rows.sort(key=lambda row: (0 if row["momentum"] == "rising" else 1, -row["mentions"], row["name"]))
    return rows[:limit]


def source_status(niche_docs: list[dict]) -> dict:
    """Per source: did any scrape succeed, how many posts, and when it last ran."""
    status: dict[str, dict] = {}
    for doc in niche_docs or []:
        scraped = coerce_time(doc.get("scrapedAt"))
        for source, info in (doc.get("sources") or {}).items():
            row = status.setdefault(source, {"ok": False, "posts": 0, "error": None, "scrapedAt": None})
            row["posts"] += int(info.get("posts") or 0)
            if info.get("ok"):
                row["ok"] = True
                row["error"] = None
            elif not row["ok"]:
                row["error"] = info.get("error")
            if scraped and (row["scrapedAt"] is None or scraped > row["scrapedAt"]):
                row["scrapedAt"] = scraped
    return status


# ---------------------------------------------------------------------------
# Menus across cafés
# ---------------------------------------------------------------------------


def _servable_drinks(items: list[dict]) -> dict[str, str]:
    """key -> display name, for drinks a café is selling now."""
    names = {}
    for item in items or []:
        if item.get("category") != "drink" or item.get("available") is False:
            continue
        if item.get("item"):
            names[_key(item["item"])] = item["item"]
    return names


def recent_additions(versions: list[dict], now: datetime, days: int = WINDOW_DAYS) -> list[tuple[str, str, datetime]]:
    """(key, name, when) for drinks a café added in the window.

    A café's first menu is not "adding" anything, so version 1 is skipped.
    """
    since = now - timedelta(days=days)
    ordered = sorted(versions or [], key=lambda version: version.get("version") or 0)
    added = []
    previous: dict[str, str] | None = None
    for version in ordered:
        names = _servable_drinks(version.get("items") or [])
        created = coerce_time(version.get("createdAt"))
        if previous is not None and created and created >= since:
            for key, name in names.items():
                if key not in previous:
                    added.append((key, name, created))
        previous = names
    return added


def other_shops(cafes: list[dict], exclude: str | None, now: datetime, days: int = WINDOW_DAYS, limit: int = TOP) -> list[dict]:
    """Drinks other cafés added recently, or that several of them serve.

    cafes: [{cafeId, cafeName, items, versions}]. `exclude` is the owner's café.
    """
    rows: dict[str, dict] = {}

    def row(key: str, name: str) -> dict:
        return rows.setdefault(key, {"name": _display(name), "added": set(), "served": set(), "cafes": [], "latest": None})

    for cafe in cafes or []:
        cafe_id = cafe.get("cafeId")
        if not cafe_id or cafe_id == exclude:
            continue
        for key, name in _servable_drinks(cafe.get("items") or []).items():
            entry = row(key, name)
            entry["served"].add(cafe_id)
            if cafe.get("cafeName") and cafe["cafeName"] not in entry["cafes"]:
                entry["cafes"].append(cafe["cafeName"])
        for key, name, created in recent_additions(cafe.get("versions") or [], now, days):
            entry = row(key, name)
            entry["added"].add(cafe_id)
            if entry["latest"] is None or created > entry["latest"]:
                entry["latest"] = created

    out = [
        {
            "name": entry["name"],
            "addedAt": len(entry["added"]),
            "servedAt": len(entry["served"]),
            "cafes": entry["cafes"][:3],
            "latest": entry["latest"],
        }
        for entry in rows.values()
        if entry["added"] or len(entry["served"]) >= 2
    ]
    out.sort(key=lambda row: (-row["addedAt"], -row["servedAt"], row["name"]))
    return out[:limit]


# ---------------------------------------------------------------------------
# What people ask JOLO
# ---------------------------------------------------------------------------


# "oat" and "oat milk" are the same ask.
EXTRA_ALIASES = {"oat": "oat milk", "almond": "almond milk", "soy": "soy milk", "coconut": "coconut milk"}


def _search_terms(text: str) -> set[str]:
    terms = {_display(span) for span in drink_spans(text)}
    terms.update(
        _display(EXTRA_ALIASES.get(extra, extra)) for extra in extras_in(text) if extra != "unsweetened"
    )
    return terms


def asks_nearby(events: list[dict], cafes_by_id: dict[str, dict], area: str | None, now: datetime,
                days: int = WINDOW_DAYS, limit: int = 8) -> dict:
    """The drinks and extras people searched for, and drinks they opened, saved or
    ordered at cafés in `area` (a municipality). Falls back to the whole county
    when the town has nothing yet. Counts only, never who asked.
    """
    since = now - timedelta(days=days)
    recent = [event for event in events or [] if (coerce_time(event.get("createdAt")) or now) >= since]

    def count(in_area) -> Counter:
        terms: Counter = Counter()
        for event in recent:
            kind = event.get("type")
            if kind == "search":
                for term in _search_terms(event.get("text") or ""):
                    terms[term] += 1
            elif kind in ("open", "save", "purchase") and event.get("itemName"):
                cafe = cafes_by_id.get(event.get("cafeId") or "") or {}
                if in_area(cafe):
                    terms[_display(event["itemName"])] += 1
        return terms

    scope = area
    terms = count(lambda cafe: bool(area) and cafe.get("municipality") == area) if area else Counter()
    if not terms:
        scope = AREA_NAME
        terms = count(lambda cafe: True)
    rows = [{"term": term, "count": n} for term, n in terms.most_common(limit)]
    return {"scope": scope, "terms": rows, "searches": sum(1 for e in recent if e.get("type") == "search")}


# ---------------------------------------------------------------------------
# The two documents
# ---------------------------------------------------------------------------


def owner_signals(cafe: dict, cafes: list[dict], events: list[dict], niche_docs: list[dict], now: datetime) -> dict:
    """cafes/{id}/analytics/current. The app joins these with the live menu."""
    by_id = {row.get("cafeId"): row for row in cafes or []}
    return {
        "generatedAt": now,
        "area": cafe.get("municipality") or AREA_NAME,
        "otherShops": other_shops(cafes, cafe.get("cafeId"), now),
        "nearby": asks_nearby(events, by_id, cafe.get("municipality"), now),
        "web": web_trends(niche_docs),
        "sources": source_status(niche_docs),
    }


def _web_match(item_name: str, web: list[dict]) -> dict | None:
    best, best_score = None, 0.0
    for drink in web or []:
        score = name_overlap(drink.get("name") or "", item_name)
        if score > best_score:
            best, best_score = drink, score
    return best if best_score >= 0.6 else None


def _sources_label(sources: list[str]) -> str:
    labels = [SOURCE_LABELS.get(source, source) for source in sources or []]
    return " and ".join(labels[:2]) if labels else "the web"


def area_trending(cafes: list[dict], events: list[dict], web: list[dict], now: datetime,
                  days: int = WINDOW_DAYS, limit: int = TOP, per_cafe: int = 3) -> list[dict]:
    """Drinks on local menus that something says are worth trying, best first.

    Signals: the drink matches a web trend, the café added it recently, or
    people on JOLO asked about it. A drink needs at least one. Prices come from
    the menu.
    """
    since = now - timedelta(days=days)
    recent = [event for event in events or [] if (coerce_time(event.get("createdAt")) or now) >= since]
    cards = []
    for cafe in cafes or []:
        updated = cafe.get("menuUpdatedAt")
        if fresh_score(updated, now) <= 0:
            continue
        new_keys = {key for key, _name, _when in recent_additions(cafe.get("versions") or [], now, days)}
        for item in cafe.get("items") or []:
            name = item.get("item") or ""
            if item.get("category") != "drink" or item.get("available") is False or _low_confidence(item):
                continue
            if not name or not item.get("id"):
                continue
            signals, score = [], 0.0
            match = _web_match(name, web)
            if match:
                rising = match.get("momentum") == "rising"
                verb = "Rising" if rising else "Talked about"
                signals.append({"kind": "web", "label": f"{verb} on {_sources_label(match.get('sources'))}"})
                score += 0.4 * (1.0 if rising else 0.6)
            if _key(name) in new_keys:
                signals.append({"kind": "new", "label": f"New at {cafe.get('cafeName') or 'this café'}"})
                score += 0.3
            askers = {
                event.get("uid") or index
                for index, event in enumerate(recent)
                if (event.get("cafeId") == cafe.get("cafeId") and event.get("itemId") == item.get("id"))
                or (event.get("type") == "search" and name_overlap(event.get("text") or "", name) >= 0.75)
            }
            asked = len(askers)
            if asked:
                signals.append({"kind": "asks", "label": f"{asked} {'person' if asked == 1 else 'people'} asked about it"})
                score += 0.3 * min(1.0, asked / 5)
            if not signals:
                continue
            score += 0.1 * fresh_score(updated, now)
            cards.append(
                {
                    "cafeId": cafe.get("cafeId"),
                    "itemId": item.get("id"),
                    "itemName": name,
                    "cafeName": cafe.get("cafeName") or "Café",
                    "priceUsd": _first_price(item),
                    "prices": item.get("prices") or [],
                    "signals": signals,
                    "why": " · ".join(signal["label"] for signal in signals),
                    "score": round(score, 4),
                }
            )
    cards.sort(key=lambda card: (-card["score"], card["cafeName"], card["itemName"]))
    out, per = [], Counter()
    for card in cards:
        if per[card["cafeId"]] >= per_cafe:
            continue
        per[card["cafeId"]] += 1
        out.append(card)
    return out[:limit]


def area_doc(cafes: list[dict], events: list[dict], niche_docs: list[dict], now: datetime) -> dict:
    web = web_trends(niche_docs)
    return {
        "name": AREA_NAME,
        "generatedAt": now,
        "trending": area_trending(cafes, events, web, now),
        "sources": source_status(niche_docs),
    }


def utc_now() -> datetime:
    return datetime.now(timezone.utc)
