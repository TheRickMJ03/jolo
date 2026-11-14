"""Join drink names to menus a café is serving today.

Hard drops happen before the score: unavailable, not a drink, a read the
owner has not confirmed, a drink this person already ordered, a phrase that
hits an avoid facet. The price on the card is the menu's price.
"""
from __future__ import annotations

import re
from datetime import datetime, timezone

from recommend.profile import base_in, coerce_time, extras_in, hits_avoid

# Same line as jolo-app/lib/menu.js CHECK_BELOW. Below it, the app asks the
# owner to check the item, so we do not recommend it.
CHECK_BELOW = 0.5
HANDFUL = 8

NAME_WEIGHT = 0.30
TASTE_WEIGHT = 0.30
TREND_WEIGHT = 0.20
FRESH_WEIGHT = 0.20

_TOKEN_SKIP = {"a", "the", "and", "with", "of"}


def _tokens(text: str) -> list[str]:
    return [token for token in re.findall(r"[a-z0-9]+", text.lower()) if token not in _TOKEN_SKIP]


def name_overlap(phrase: str, item_name: str) -> float:
    wanted = _tokens(phrase)
    have = set(_tokens(item_name))
    if not wanted or not have:
        return 0.0
    return sum(1 for token in wanted if token in have) / len(wanted)


def _extra_hit(extra: str, text: str) -> bool:
    low = text.lower()
    if re.search(rf"\b{re.escape(extra)}\b", low):
        return True
    head = extra.split()[0]
    return re.search(rf"\b{re.escape(head)}\b", low) is not None


def taste_overlap(item_name: str, phrase: str, facets: dict) -> float:
    text = f"{item_name} {phrase}"
    bases = [name for name, weight in (facets.get("base") or {}).items() if weight > 0]
    extras = [name for name, weight in (facets.get("extra") or {}).items() if weight > 0]
    if not bases and not extras:
        return 0.5
    parts: list[float] = []
    if bases:
        found = base_in(text)
        parts.append(1.0 if found in bases else 0.0)
    if extras:
        present = extras_in(text)
        hit = any(_extra_hit(extra, text) for extra in extras) or bool(set(present) & set(extras))
        parts.append(1.0 if hit else 0.0)
    return sum(parts) / len(parts)


def fresh_score(updated_at, now: datetime) -> float:
    """Full credit within a day. Gone by a month."""
    updated = coerce_time(updated_at)
    if updated is None:
        return 0.0
    days = (now - updated).total_seconds() / 86400
    if days <= 1:
        return 1.0
    if days >= 30:
        return 0.0
    return max(0.0, 1 - (days - 1) / 29)


def trend_score(momentum: str | None) -> float:
    return 1.0 if momentum == "rising" else 0.4


def _first_price(item: dict) -> float | None:
    for price in item.get("prices") or []:
        if not isinstance(price, dict):
            continue
        usd = price.get("usd")
        if isinstance(usd, bool) or not isinstance(usd, (int, float)):
            continue
        return round(float(usd) * 100) / 100
    return None


def _low_confidence(item: dict) -> bool:
    confidence = item.get("confidence")
    if confidence is None:
        return False
    try:
        return float(confidence) < CHECK_BELOW
    except (TypeError, ValueError):
        return False


def _ordered(item: dict, taste: dict) -> bool:
    name = (item.get("item") or "").strip().lower()
    item_id = (item.get("id") or "").strip().lower()
    for row in taste.get("ordered") or []:
        ordered_name = (row.get("itemName") or "").strip().lower()
        ordered_id = (row.get("itemId") or "").strip().lower()
        if ordered_name and ordered_name == name:
            return True
        if ordered_id and item_id and ordered_id == item_id:
            return True
    return False


def taste_lead(taste: dict) -> str:
    niches = taste.get("niches") or []
    if not niches:
        return "This fits what you've been looking for"
    words = niches[0].removesuffix(" drinks").strip()
    return f"You keep coming back to {words}"


def plural_phrase(phrase: str) -> str:
    text = (phrase or "").strip()
    if not text:
        return "These drinks"
    text = text[0].upper() + text[1:]
    if text[-1:].lower() == "s":
        return text
    return text + "s"


def why_sentence(taste: dict, phrase: str, cafe_name: str, price_usd: float | None) -> str:
    price = f" for ${price_usd:.2f}" if isinstance(price_usd, (int, float)) else ""
    return (
        f"{taste_lead(taste)}. {plural_phrase(phrase)} are showing up in recent café writing, "
        f"and {cafe_name} has one{price}."
    )


def _recommendable(item: dict, phrase: str, taste: dict) -> bool:
    if item.get("available") is False:
        return False
    if item.get("category") != "drink":
        return False
    if _low_confidence(item):
        return False
    if _ordered(item, taste):
        return False
    avoid = (taste.get("facets") or {}).get("avoid")
    if hits_avoid(phrase, avoid) or hits_avoid(item.get("item") or "", avoid):
        return False
    if name_overlap(phrase, item.get("item") or "") <= 0:
        return False
    return True


def match_cards(candidates: list[dict], menus: list[dict], taste: dict, now: datetime | None = None) -> list[dict]:
    """The handful of cards, best score first. Place is a tie-break, not a fifth weight."""
    now = coerce_time(now, datetime.now(timezone.utc))
    facets = (taste or {}).get("facets") or {}
    places = facets.get("place") or {}
    best: dict[tuple, dict] = {}

    for candidate in candidates or []:
        phrase = (candidate.get("name") or "").strip()
        if not phrase:
            continue
        momentum = candidate.get("momentum") or "steady"
        for menu in menus or []:
            cafe_id = menu.get("cafeId")
            cafe_name = menu.get("cafeName") or "Café"
            updated = menu.get("menuUpdatedAt")
            for item in menu.get("items") or []:
                if not _recommendable(item, phrase, taste or {}):
                    continue
                price = _first_price(item)
                score = (
                    NAME_WEIGHT * name_overlap(phrase, item.get("item") or "")
                    + TASTE_WEIGHT * taste_overlap(item.get("item") or "", phrase, facets)
                    + TREND_WEIGHT * trend_score(momentum)
                    + FRESH_WEIGHT * fresh_score(updated, now)
                )
                card = {
                    "cafeId": cafe_id,
                    "itemId": item.get("id"),
                    "itemName": item.get("item"),
                    "cafeName": cafe_name,
                    "priceUsd": price,
                    "why": why_sentence(taste or {}, phrase, cafe_name, price),
                    "score": round(score, 4),
                    "phrase": phrase,
                    "tasteLead": taste_lead(taste or {}),
                    "momentum": momentum,
                }
                key = (cafe_id, item.get("id"))
                if key not in best or card["score"] > best[key]["score"]:
                    best[key] = card

    cards = list(best.values())
    cards.sort(
        key=lambda card: (
            -card["score"],
            0 if places.get(card["cafeId"], 0) > 0 else 1,
            card["cafeName"] or "",
            card["itemName"] or "",
        )
    )
    return cards[:HANDFUL]
