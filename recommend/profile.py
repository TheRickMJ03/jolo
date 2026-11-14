"""Events from the last 90 days become facets, then one to three niche strings.

An order outweighs a search, and a search outweighs a glance. Avoid facets are
a penalty at match time, not a niche by themselves. The café on an event is
kept for matching and never goes into the web query.
"""
from __future__ import annotations

import re
from datetime import datetime, timezone

WINDOW_DAYS = 90

# Longer and more specific drinks first, so "matcha latte" is matcha and
# "oat milk latte" is espresso.
BASE_RULES = (
    ("cold brew", "cold brew"),
    ("matcha", "matcha"),
    ("chai", "tea"),
    ("cortado", "espresso"),
    ("americano", "espresso"),
    ("cappuccino", "espresso"),
    ("espresso", "espresso"),
    ("mocha", "espresso"),
    ("latte", "espresso"),
    ("tea", "tea"),
)

# Longest first so "oat milk" wins over "oat".
EXTRAS = (
    "oat milk",
    "almond milk",
    "soy milk",
    "coconut milk",
    "brown sugar",
    "unsweetened",
    "decaf",
    "lavender",
    "vanilla",
    "honey",
    "almond",
    "coconut",
    "oat",
    "soy",
    "iced",
)

# Lower sorts first when two extras share a weight. Milk beats a constraint
# word, so the first niche stays "oat milk espresso drinks".
EXTRA_RANK = {name: index for index, name in enumerate(EXTRAS)}

AVOID_PHRASES = (
    ("less sweet", "sweet"),
    ("not too sweet", "sweet"),
    ("not sweet", "sweet"),
    ("unsweetened", "sweet"),
    ("no sugar", "sweet"),
    ("sugar free", "sweet"),
    ("without sugar", "sweet"),
)

SWEET_MARKERS = (
    "brown sugar",
    "sweet",
    "sugar",
    "vanilla",
    "caramel",
    "honey",
    "mocha",
    "syrup",
    "chocolate",
)

# purchase > save > search > open. A dismiss feeds avoid, not the niche.
TYPE_WEIGHT = {
    "purchase": 5.0,
    "save": 3.0,
    "search": 2.0,
    "open": 1.0,
    "unsave": 3.0,
    "dismiss": 3.0,
}


def coerce_time(value, default=None):
    """datetime, ISO string, or Firestore-like value → aware UTC."""
    if value is None:
        return default
    if isinstance(value, datetime):
        if value.tzinfo is None:
            return value.replace(tzinfo=timezone.utc)
        return value.astimezone(timezone.utc)
    if isinstance(value, str):
        try:
            parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError:
            return default
        return coerce_time(parsed, default)
    to_date = getattr(value, "timestamp", None)
    if callable(to_date):
        try:
            return datetime.fromtimestamp(value.timestamp(), tz=timezone.utc)
        except (TypeError, ValueError, OSError):
            return default
    return default


def slugify(text: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")
    return slug or "niche"


def _has(needle: str, text: str) -> bool:
    return re.search(rf"\b{re.escape(needle)}\b", text) is not None


def base_in(text: str) -> str | None:
    low = text.lower()
    for needle, base in BASE_RULES:
        if _has(needle, low):
            return base
    return None


def extras_in(text: str) -> list[str]:
    low = text.lower()
    found: list[str] = []
    for extra in EXTRAS:
        if not _has(extra, low):
            continue
        if any(_has(extra, earlier) for earlier in found):
            continue
        found.append(extra)
    return found


def hits_avoid(text: str, avoid: dict | None) -> bool:
    """True when the phrase or the drink name fights an avoid facet."""
    if not text or not avoid:
        return False
    low = text.lower()
    for facet, weight in avoid.items():
        if weight <= 0:
            continue
        if _has(str(facet), low):
            return True
        if facet == "sweet" and any(_has(marker, low) for marker in SWEET_MARKERS):
            return True
    return False


def _decay(created_at, now: datetime) -> float:
    if created_at is None:
        return 1.0
    age_days = (now - created_at).total_seconds() / 86400
    if age_days <= 0:
        return 1.0
    if age_days >= WINDOW_DAYS:
        return 0.0
    return 1 - age_days / WINDOW_DAYS


def _bump(bucket: dict, key: str, amount: float) -> None:
    bucket[key] = bucket.get(key, 0.0) + amount


def _event_text(event: dict) -> str:
    parts = [event.get("text") or "", event.get("itemName") or ""]
    return " ".join(part for part in parts if part)


def _avoids_in(text: str) -> list[str]:
    low = text.lower()
    found = []
    for phrase, facet in AVOID_PHRASES:
        if _has(phrase, low) and facet not in found:
            found.append(facet)
    return found


def niche_strings(bases: dict, extras: dict, avoids: dict) -> list[str]:
    ranked_bases = [name for name, _weight in sorted(bases.items(), key=lambda item: -item[1]) if bases[name] > 0]
    ranked_extras = [
        name
        for name, _weight in sorted(
            extras.items(),
            key=lambda item: (-item[1], EXTRA_RANK.get(item[0], 100)),
        )
        if extras[name] > 0
    ]
    if not ranked_bases:
        return []

    top_extra = ranked_extras[0] if ranked_extras else None
    sweet = avoids.get("sweet", 0) > 0
    niches: list[str] = []

    def add(text: str) -> None:
        if text and text not in niches and len(niches) < 3:
            niches.append(text)

    first = ranked_bases[0]
    add(f"{top_extra} {first} drinks" if top_extra else f"{first} drinks")
    if sweet:
        short = top_extra.split()[0] if top_extra else ""
        add(" ".join(part for part in ("unsweetened", short, first) if part))
    for base in ranked_bases[1:]:
        add(f"{top_extra} {base} drinks" if top_extra else f"{base} drinks")
    return niches


def build_profile(events: list[dict], now: datetime | None = None) -> dict:
    """Facets, the drinks already ordered, and at most three niche strings."""
    now = coerce_time(now, datetime.now(timezone.utc))
    bases: dict[str, float] = {}
    extras: dict[str, float] = {}
    avoids: dict[str, float] = {}
    places: dict[str, float] = {}
    ordered: list[dict] = []

    ordered_events = sorted(
        events or [],
        key=lambda event: coerce_time(event.get("createdAt"), now) or now,
    )
    for event in ordered_events:
        kind = event.get("type")
        weight = TYPE_WEIGHT.get(kind)
        if weight is None:
            continue
        created = coerce_time(event.get("createdAt"), now)
        factor = _decay(created, now)
        # Outside the 90-day window the event, including an old order, drops out.
        if factor <= 0:
            continue
        amount = weight * factor
        text = _event_text(event)
        base = base_in(text)
        extra_names = extras_in(text)
        avoid_names = _avoids_in(text)

        if kind == "dismiss":
            for extra in extra_names:
                _bump(avoids, extra, amount)
            for facet in avoid_names:
                _bump(avoids, facet, amount)
            if any(marker in text.lower() for marker in ("brown sugar", "vanilla", "honey", "mocha", "caramel")):
                _bump(avoids, "sweet", amount)
        elif kind == "unsave":
            if base:
                _bump(bases, base, -amount)
            for extra in extra_names:
                _bump(extras, extra, -amount)
        else:
            if base:
                _bump(bases, base, amount)
            for extra in extra_names:
                # "unsweetened" is the avoid constraint, not a flavour to search for.
                if extra == "unsweetened":
                    continue
                _bump(extras, extra, amount)
            for facet in avoid_names:
                _bump(avoids, facet, amount)

        if kind == "purchase" and (event.get("itemName") or event.get("itemId")):
            ordered.append(
                {
                    "cafeId": event.get("cafeId"),
                    "itemId": event.get("itemId"),
                    "itemName": event.get("itemName"),
                }
            )

        cafe_id = event.get("cafeId")
        if cafe_id and kind in ("purchase", "save", "search", "open"):
            _bump(places, cafe_id, amount)

    bases = {key: value for key, value in bases.items() if value > 0}
    extras = {key: value for key, value in extras.items() if value > 0}
    avoids = {key: value for key, value in avoids.items() if value > 0}
    places = {key: value for key, value in places.items() if value > 0}

    return {
        "facets": {"base": bases, "extra": extras, "avoid": avoids, "place": places},
        "ordered": ordered,
        "niches": niche_strings(bases, extras, avoids),
        "updatedAt": now,
    }
