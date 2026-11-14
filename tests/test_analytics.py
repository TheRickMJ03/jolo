"""Owner signals, area trends, and the Reddit/TikTok wrapper. No network."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

from recommend.analytics import (
    AREA_ID,
    AREA_NAME,
    area_trending,
    asks_nearby,
    is_drink_name,
    merge_drinks,
    niche_entry,
    other_shops,
    owner_signals,
    recent_additions,
    source_status,
    web_trends,
)
from recommend.job import MemoryStore, demo_niche_docs, refresh_niche, run_analytics, run_forever
from recommend.social import SocialDeps, engagement_count, scrape_social, slim_post

NOW = datetime(2026, 11, 14, 12, tzinfo=timezone.utc)


def ago(days: float) -> datetime:
    return NOW - timedelta(days=days)


def drink(item_id, name, usd=5.0, **extra):
    return {
        "id": item_id,
        "item": name,
        "category": extra.pop("category", "drink"),
        "prices": [{"size": None, "usd": usd}],
        "confidence": extra.pop("confidence", 1),
        "available": extra.pop("available", True),
        **extra,
    }


def cafe(cafe_id, name, versions, municipality="Westfield", updated_days=1, owner=None):
    current = versions[-1]
    return {
        "cafeId": cafe_id,
        "cafeName": name,
        "municipality": municipality,
        "ownerPhone": owner,
        "menuUpdatedAt": ago(updated_days),
        "items": current["items"],
        "versions": versions,
    }


def version(number, days, items):
    return {"version": number, "createdAt": ago(days), "items": items}


BASE = [drink("cortado", "Cortado"), drink("latte", "Latte")]


# ---------------------------------------------------------------------------
# Social wrapper
# ---------------------------------------------------------------------------


def test_engagement_count_reads_reddit_abbreviations():
    assert engagement_count("1.8K") == 1800
    assert engagement_count("212") == 212
    assert engagement_count(42) == 42
    assert engagement_count(None) == 0
    assert engagement_count("n/a") == 0


def test_slim_post_drops_author_media_and_raw():
    post = {
        "platform": "reddit",
        "author": "someone",
        "text": "Lavender oat latte is everywhere",
        "url": "https://www.reddit.com/r/coffee/comments/1/x/",
        "engagement": {"upvotes": "1.2K", "comments": "88"},
        "media": "https://img",
        "raw": {"secret": True},
    }
    assert slim_post(post, "reddit") == {
        "title": "Lavender oat latte is everywhere",
        "url": "https://www.reddit.com/r/coffee/comments/1/x/",
        "source": "reddit",
        "engagement": 1288,
    }
    assert slim_post({"text": "  "}, "reddit") is None


def test_scrape_social_reports_a_failing_platform_without_raising():
    async def reddit(niche):
        return [{"text": f"Best {niche} in town", "url": "u", "engagement": {"upvotes": "10"}}]

    async def tiktok(niche):
        raise RuntimeError("blocked")

    result = scrape_social("matcha", deps=SocialDeps(search={"reddit": reddit, "tiktok": tiktok}))
    assert result["reddit"]["ok"] is True
    assert result["reddit"]["posts"][0]["title"] == "Best matcha in town"
    assert result["tiktok"] == {"ok": False, "error": "blocked", "posts": []}


def test_scrape_social_lists_skipped_platforms():
    result = scrape_social("matcha", deps=SocialDeps(skipped={"tiktok": "off: no SCRAPFLY_KEY"}))
    assert result == {"tiktok": {"ok": False, "error": "off: no SCRAPFLY_KEY", "posts": []}}


# ---------------------------------------------------------------------------
# Niches and web trends
# ---------------------------------------------------------------------------


def test_niche_entry_merges_blogs_and_reddit_with_sources_and_an_example():
    blogs = {
        "momentum": {"rising": [{"term": "oat latte"}]},
        "titles": ["Oat latte season", "Why the oat latte works"],
        "posts": [{"title": "Oat latte season", "url": "https://blog/1", "source": "blogs"}],
    }
    social = {
        "reddit": {
            "ok": True,
            "error": None,
            "posts": [
                {"title": "Tried an iced matcha today", "url": "https://r/1", "source": "reddit", "engagement": 900},
                {"title": "Oat latte at home", "url": "https://r/2", "source": "reddit", "engagement": 3},
            ],
        },
        "tiktok": {"ok": False, "error": "off: no SCRAPFLY_KEY", "posts": []},
    }
    entry = niche_entry("oat milk espresso drinks", blogs, social, NOW)
    names = {row["name"]: row for row in entry["drinks"]}
    assert names["Oat latte"]["momentum"] == "rising"
    assert names["Oat latte"]["sources"] == ["blogs"]
    assert names["Oat latte"]["mentions"] == 2
    # One loud Reddit post is enough to count.
    assert names["Iced matcha"]["sources"] == ["reddit"]
    assert names["Iced matcha"]["example"] == {"title": "Tried an iced matcha today", "url": "https://r/1", "source": "reddit"}
    assert entry["sources"]["tiktok"] == {"ok": False, "error": "off: no SCRAPFLY_KEY", "posts": 0}
    assert entry["sources"]["blogs"]["ok"] is True


def test_niche_entry_records_a_blog_failure():
    entry = niche_entry("matcha drinks", None, {}, NOW, blog_error="ddg timed out")
    assert entry["sources"]["blogs"] == {"ok": False, "error": "ddg timed out", "posts": 0}
    assert entry["drinks"] == []


def test_is_drink_name_drops_headline_fragments():
    for good in ("Cold brew", "Matcha", "Oat milk shaken espresso", "Iced matcha latte"):
        assert is_drink_name(good), good
    for bad in ("Espresso machine", "Latte comes", "I had afternoon tea", "Latte taste", "Espresso powder", "Espresso", "Milk latte"):
        assert not is_drink_name(bad), bad


def test_web_trends_cleans_old_cached_niches_too():
    docs = [{"drinks": [{"name": "Espresso machine"}, {"name": "Cold brew", "sources": ["blogs"]}]}]
    assert [row["name"] for row in web_trends(docs)] == ["Cold brew"]


def test_merge_drinks_puts_rising_first():
    rows = merge_drinks(
        {
            "blogs": ([{"name": "Cold brew", "momentum": "steady"}], []),
            "reddit": ([{"name": "Iced matcha", "momentum": "rising"}], []),
        }
    )
    assert [row["name"] for row in rows] == ["Iced matcha", "Cold brew"]


def test_web_trends_merges_the_same_drink_across_niches():
    docs = [
        {"drinks": [{"name": "Oat latte", "momentum": "steady", "sources": ["blogs"], "mentions": 2}]},
        {"drinks": [{"name": "oat latte", "momentum": "rising", "sources": ["reddit"], "mentions": 3}]},
    ]
    [row] = web_trends(docs)
    assert row["momentum"] == "rising"
    assert row["sources"] == ["blogs", "reddit"]
    assert row["mentions"] == 5


def test_source_status_is_ok_when_any_niche_worked():
    docs = [
        {"scrapedAt": ago(2), "sources": {"reddit": {"ok": False, "error": "camofox down", "posts": 0}}},
        {"scrapedAt": ago(1), "sources": {"reddit": {"ok": True, "error": None, "posts": 12}}},
    ]
    status = source_status(docs)["reddit"]
    assert status["ok"] is True and status["error"] is None and status["posts"] == 12
    assert status["scrapedAt"] == ago(1)


# ---------------------------------------------------------------------------
# Other shops
# ---------------------------------------------------------------------------


def test_recent_additions_skips_the_first_menu_and_old_changes():
    versions = [
        version(1, 60, BASE),
        version(2, 45, BASE + [drink("mocha", "Mocha")]),
        version(3, 5, BASE + [drink("mocha", "Mocha"), drink("matcha", "Iced Matcha")]),
    ]
    assert [(key, when) for key, _name, when in recent_additions(versions, NOW)] == [("iced matcha", ago(5))]


def test_other_shops_counts_cafes_that_added_or_serve_a_drink_but_not_the_owner():
    cafes = [
        cafe("mine", "Mine", [version(1, 50, BASE), version(2, 3, BASE + [drink("m", "Iced Matcha")])]),
        cafe("a", "Ayala", [version(1, 50, BASE), version(2, 4, BASE + [drink("m", "Iced Matcha")])]),
        cafe("b", "Black Drop", [version(1, 50, BASE), version(2, 2, BASE + [drink("m", "iced matcha")])]),
        cafe("c", "& Grain", [version(1, 50, [drink("cb", "Cold Brew")])]),
    ]
    rows = {row["name"]: row for row in other_shops(cafes, "mine", NOW)}
    assert rows["Iced Matcha"]["addedAt"] == 2
    assert rows["Iced Matcha"]["servedAt"] == 2
    assert rows["Iced Matcha"]["latest"] == ago(2)
    assert rows["Cortado"]["addedAt"] == 0 and rows["Cortado"]["servedAt"] == 2
    # Served at one café and never added: not a signal.
    assert "Cold Brew" not in rows
    assert list(rows)[0] == "Iced Matcha"


def test_other_shops_ignores_sold_out_and_food():
    cafes = [
        cafe("a", "A", [version(1, 50, []), version(2, 3, [drink("x", "Mocha", available=False), drink("y", "Scone", category="food")])]),
    ]
    assert other_shops(cafes, None, NOW) == []


# ---------------------------------------------------------------------------
# Asks nearby
# ---------------------------------------------------------------------------


EVENTS = [
    {"uid": "u1", "type": "search", "text": "oat milk latte", "createdAt": ago(2)},
    {"uid": "u2", "type": "search", "text": "iced oat latte", "createdAt": ago(3)},
    {"uid": "u2", "type": "open", "cafeId": "a", "itemId": "m", "itemName": "Iced Matcha", "createdAt": ago(1)},
    {"uid": "u3", "type": "save", "cafeId": "far", "itemId": "x", "itemName": "Mocha", "createdAt": ago(1)},
    {"uid": "u3", "type": "search", "text": "cold brew", "createdAt": ago(90)},
]
CAFES_BY_ID = {"a": {"municipality": "Westfield"}, "far": {"municipality": "Rahway"}}


def test_asks_nearby_counts_search_terms_and_drinks_at_cafes_in_town():
    result = asks_nearby(EVENTS, CAFES_BY_ID, "Westfield", NOW)
    terms = {row["term"]: row["count"] for row in result["terms"]}
    assert result["scope"] == "Westfield"
    assert terms["Oat milk"] == 2
    assert terms["Oat milk latte"] == 1
    assert terms["Iced Matcha"] == 1
    assert "Mocha" not in terms, "a save at a café in another town"
    assert "Cold brew" not in terms, "older than 30 days"
    assert result["searches"] == 2


def test_asks_nearby_falls_back_to_the_county():
    result = asks_nearby(EVENTS[3:4], CAFES_BY_ID, "Summit", NOW)
    assert result["scope"] == AREA_NAME
    assert result["terms"] == [{"term": "Mocha", "count": 1}]


# ---------------------------------------------------------------------------
# Owner signals and area trends
# ---------------------------------------------------------------------------


WEB = [{"name": "Iced matcha", "momentum": "rising", "sources": ["reddit"], "mentions": 4}]


def test_area_trending_needs_a_signal_and_uses_the_menu_price():
    cafes = [
        cafe("a", "Ayala", [version(1, 50, BASE), version(2, 3, BASE + [drink("m", "Iced Matcha Latte", 6.25)])]),
        cafe("stale", "Stale", [version(1, 50, [drink("m2", "Iced Matcha")])], updated_days=45),
    ]
    cards = area_trending(cafes, EVENTS, WEB, NOW)
    assert [card["itemName"] for card in cards] == ["Iced Matcha Latte"]
    card = cards[0]
    assert card["priceUsd"] == 6.25
    assert [signal["kind"] for signal in card["signals"]] == ["web", "new", "asks"]
    assert card["why"] == "Rising on Reddit · New at Ayala · 1 person asked about it"
    assert card["location"] is None


def test_area_cards_carry_the_cafe_location():
    row = cafe("a", "Ayala", [version(1, 50, BASE), version(2, 3, BASE + [drink("m", "Iced Matcha")])])
    row["location"] = {"lat": 40.69, "lng": -74.26}
    [card] = area_trending([row], [], WEB, NOW)
    assert card["location"] == {"lat": 40.69, "lng": -74.26}


def test_area_trending_skips_unconfirmed_reads():
    cafes = [cafe("a", "A", [version(1, 50, []), version(2, 3, [drink("m", "Iced Matcha", confidence=0.3)])])]
    assert area_trending(cafes, [], WEB, NOW) == []


def test_owner_signals_shape():
    cafes = [
        cafe("mine", "Mine", [version(1, 50, BASE)], owner="+19085550000"),
        cafe("a", "Ayala", [version(1, 50, BASE), version(2, 3, BASE + [drink("m", "Iced Matcha")])]),
    ]
    docs = [{"scrapedAt": ago(1), "drinks": WEB, "sources": {"reddit": {"ok": True, "posts": 9}}}]
    signals = owner_signals(cafes[0], cafes, EVENTS, docs, NOW)
    assert signals["area"] == "Westfield"
    assert signals["otherShops"][0]["name"] == "Iced Matcha"
    assert signals["nearby"]["scope"] == "Westfield"
    assert signals["web"][0]["name"] == "Iced matcha"
    assert signals["sources"]["reddit"]["ok"] is True


# ---------------------------------------------------------------------------
# The job
# ---------------------------------------------------------------------------


def test_refresh_niche_reuses_a_fresh_scrape():
    store = MemoryStore(niches={"matcha-drinks": {"scrapedAt": ago(1), "drinks": [], "sources": {"blogs": {}}}})
    calls = []
    refresh_niche(store, "matcha drinks", NOW, scrape_blogs=lambda niche: calls.append(niche))
    assert calls == []


def test_refresh_niche_keeps_reddit_when_blogs_fail():
    def blogs(niche):
        raise RuntimeError("ddg timed out")

    def social(niche):
        return {"reddit": {"ok": True, "posts": [{"title": "Iced matcha everywhere", "url": "u", "source": "reddit", "engagement": 80}]}}

    store = MemoryStore()
    document = refresh_niche(store, "matcha drinks", NOW, scrape_blogs=blogs, scrape_social=social)
    assert store.niches["matcha-drinks"] is document
    assert document["sources"]["blogs"]["ok"] is False
    assert [row["name"] for row in document["drinks"]] == ["Iced matcha"]


def test_run_analytics_writes_the_area_owners_and_people():
    menus = [
        cafe("mine", "Mine", [version(1, 50, BASE)], owner="+19085550000"),
        cafe("a", "Ayala", [version(1, 50, BASE), version(2, 3, BASE + [drink("m", "Iced Matcha Latte")])]),
    ]
    events = {"u1": [e for e in EVENTS if e["uid"] == "u1"], "u2": [e for e in EVENTS if e["uid"] == "u2"]}
    store = MemoryStore(events=events, menus=menus)
    for document in demo_niche_docs(NOW):
        store.put_niche(document["slug"], document)

    summary = run_analytics(store, now=NOW)

    assert summary == {"niches": 5, "cafes": 2, "owners": 1, "people": 2}
    assert set(store.owner_analytics) == {"mine"}
    assert store.owner_analytics["mine"]["sources"] == {
        "demo": {"ok": True, "posts": 4, "error": None, "scrapedAt": NOW}
    }
    trending = store.areas[AREA_ID]["trending"]
    assert trending and trending[0]["itemName"] == "Iced Matcha Latte"
    assert set(store.recommendations) == {"u1", "u2"}


def test_run_forever_keeps_going_after_a_failed_run():
    results = iter([RuntimeError("ddg down"), "ok"])
    sleeps, logs = [], []

    def once():
        result = next(results)
        if isinstance(result, Exception):
            raise result
        return result

    failures = run_forever(once, 24, sleep=sleeps.append, log=logs.append, max_runs=2)
    assert failures == 1
    assert sleeps == [24 * 3600]
    assert "run failed" in logs[0] and "ddg down" in logs[0]
    assert logs[1].endswith("ok")
