"""Taste, drink queries, extraction, matching, and the recommend job."""
from __future__ import annotations

import json
import os
from datetime import datetime, timedelta, timezone

from recommend.extract import drink_spans, extract_drinks
from recommend.job import (
    DEMO_TRENDS,
    FIXED_NICHES,
    MemoryStore,
    demo_cards,
    demo_events,
    demo_menus,
    niche_is_fresh,
    run_job,
)
from recommend.profile import build_profile
from recommend.queries import DRINK_TEMPLATES, build_queries
from recommend.scrape import ScrapeDeps, scrape_niche

NOW = datetime(2026, 11, 14, 15, tzinfo=timezone.utc)


def test_illustrative_taste_becomes_two_niches():
    taste = build_profile(demo_events(NOW), now=NOW)
    assert taste["niches"] == ["oat milk espresso drinks", "unsweetened oat espresso"]
    assert taste["facets"]["base"]["espresso"] > taste["facets"]["extra"]["oat milk"]
    assert taste["facets"]["avoid"]["sweet"] > 0
    assert taste["ordered"][0]["itemName"] == "Cortado"
    assert "cortado" not in " ".join(taste["niches"])


def test_order_outweighs_a_search_and_a_search_outweighs_a_glance():
    events = [
        {"type": "open", "itemName": "Matcha Latte", "createdAt": NOW},
        {"type": "search", "text": "espresso", "createdAt": NOW},
        {"type": "purchase", "itemName": "Matcha Latte", "itemId": "matcha", "createdAt": NOW},
    ]
    taste = build_profile(events, now=NOW)
    assert taste["facets"]["base"]["matcha"] > taste["facets"]["base"]["espresso"]
    glance = build_profile([{"type": "open", "itemName": "Matcha Latte", "createdAt": NOW}], now=NOW)
    searched = build_profile([{"type": "search", "text": "matcha", "createdAt": NOW}], now=NOW)
    assert searched["facets"]["base"]["matcha"] > glance["facets"]["base"]["matcha"]


def test_events_older_than_90_days_drop_out_and_an_unsave_cancels():
    stale = NOW - timedelta(days=91)
    taste = build_profile(
        [{"type": "purchase", "itemName": "Matcha Latte", "itemId": "matcha", "createdAt": stale}],
        now=NOW,
    )
    assert taste["niches"] == []
    assert taste["ordered"] == []

    mid = NOW - timedelta(days=45)
    faded = build_profile([{"type": "search", "text": "matcha", "createdAt": mid}], now=NOW)
    fresh = build_profile([{"type": "search", "text": "matcha", "createdAt": NOW}], now=NOW)
    assert faded["facets"]["base"]["matcha"] < fresh["facets"]["base"]["matcha"]

    cancelled = build_profile(
        [
            {"type": "save", "itemName": "Almond Latte", "itemId": "almond", "cafeId": "c", "createdAt": NOW},
            {"type": "unsave", "itemName": "Almond Latte", "itemId": "almond", "cafeId": "c", "createdAt": NOW},
        ],
        now=NOW,
    )
    assert "almond" not in cancelled["facets"]["extra"]


def test_drink_templates_skip_outreach():
    queries, source = build_queries("oat milk espresso drinks", outreach=True, use_llm=True)
    assert source == "template"
    assert queries == [template.format(niche="oat milk espresso drinks") for template in DRINK_TEMPLATES]
    blob = " ".join(queries).lower()
    for banned in ("forum", "association", "write for us", "guest post"):
        assert banned not in blob


def test_extract_keeps_drink_phrases_and_prefers_the_longer_rising_name():
    drinks = extract_drinks(DEMO_TRENDS["oat milk espresso drinks"])
    names = [drink["name"] for drink in drinks]
    assert "Lavender oat latte" in names
    assert "Oat latte" not in names
    lavender = next(drink for drink in drinks if drink["name"] == "Lavender oat latte")
    assert lavender["momentum"] == "rising"
    assert drink_spans("The lavender oat latte cafés are pouring") == ["lavender oat latte"]
    assert extract_drinks({"top_phrases": [{"term": "blueberry muffin", "posts": 3, "sites": 2}]}) == []


def test_demo_matches_barbaras_menu_and_drops_the_rest():
    cards, taste = demo_cards(NOW)
    assert taste["niches"][0] == "oat milk espresso drinks"
    assert len(FIXED_NICHES) == 5
    assert [card["itemName"] for card in cards] == ["Lavender Oat Latte"]
    card = cards[0]
    assert card["cafeName"] == "Barbara's"
    assert card["priceUsd"] == 5.75
    assert card["why"] == (
        "You keep coming back to oat milk espresso. Lavender oat lattes are showing up in "
        "recent café writing, and Barbara's has one for $5.75."
    )
    assert "Cortado" not in card["why"]
    assert "6.00" not in card["why"]


def test_a_fresher_menu_outranks_an_older_one():
    from recommend.match import match_cards

    taste = build_profile(demo_events(NOW), now=NOW)
    item = {
        "id": "lavender-oat-latte",
        "item": "Lavender Oat Latte",
        "category": "drink",
        "prices": [{"size": None, "usd": 5.75}],
        "confidence": 1,
        "available": True,
    }
    menus = [
        {"cafeId": "old", "cafeName": "Old", "menuUpdatedAt": NOW - timedelta(days=20), "items": [item]},
        {"cafeId": "new", "cafeName": "New", "menuUpdatedAt": NOW, "items": [dict(item)]},
    ]
    cards = match_cards(
        [{"name": "Lavender oat latte", "momentum": "rising"}],
        menus,
        taste,
        now=NOW,
    )
    assert [card["cafeId"] for card in cards] == ["new", "old"]
    assert cards[0]["score"] > cards[1]["score"]


def test_scrape_passes_drink_queries_and_keeps_titles_only():
    seen = {}

    class Site:
        def __init__(self, key, score, error=None):
            self.key = key
            self.score = score
            self.error = error
            self.last_post = "2026-11-10"
            self.homepage = f"https://{key}"
            self.feed_url = None
            self.pages = []

    def collect(niche, queries):
        seen["niche"] = niche
        seen["queries"] = queries
        return [Site("low.example", 2), Site("broken.example", 9, error="nope"), Site("good.example", 6)]

    def launch(job_dir, niche, sites):
        seen["sites"] = [site.key for site in sites]
        payload = {
            "trends": {"top_phrases": [{"term": "oat latte", "posts": 2, "sites": 1}], "momentum": None, "ai": None},
            "sites": [
                {
                    "posts": [
                        {"title": "Lavender oat latte", "text": "<p>full html of the post</p>"},
                        {"title": "Lavender oat latte", "text": "more html"},
                    ]
                }
            ],
        }
        with open(os.path.join(job_dir, "scraped.json"), "w", encoding="utf-8") as handle:
            json.dump(payload, handle)

        class Process:
            def wait(self):
                return 0

        return Process()

    deps = ScrapeDeps(
        collect=collect,
        analyze_site=lambda site, terms: site,
        niche_terms=lambda niche: niche.split(),
        posted_within=lambda sites, since_days: sites,
        launch=launch,
    )
    trends = scrape_niche("oat milk espresso drinks", deps=deps)
    assert seen["queries"][0] == "oat milk espresso drinks"
    assert "forum" not in " ".join(seen["queries"])
    assert seen["sites"] == ["good.example"]
    assert trends["titles"] == ["Lavender oat latte", "Lavender oat latte"]
    assert "html" not in json.dumps(trends["titles"])


def test_job_reuses_a_fresh_niche_and_rescrapes_a_stale_one():
    calls = []

    def scrape(niche):
        calls.append(niche)
        return DEMO_TRENDS.get(niche) or {"top_phrases": [], "momentum": None, "ai": None}

    store = MemoryStore(
        events={"u1": demo_events(NOW)},
        menus=demo_menus(NOW),
        niches={
            "oat-milk-espresso-drinks": {
                "slug": "oat-milk-espresso-drinks",
                "query": "oat milk espresso drinks",
                "scrapedAt": NOW - timedelta(days=3),
                "drinks": [{"name": "Lavender oat latte", "momentum": "rising", "source": "title"}],
            },
            "unsweetened-oat-espresso": {
                "slug": "unsweetened-oat-espresso",
                "query": "unsweetened oat espresso",
                "scrapedAt": NOW - timedelta(days=8),
                "drinks": [{"name": "Cappuccino", "momentum": "rising", "source": "phrase"}],
            },
        },
    )
    result = run_job(store, "u1", scrape=scrape, now=NOW)
    assert calls == ["unsweetened oat espresso"]
    assert result["cards"][0]["itemName"] == "Lavender Oat Latte"
    assert result["cards"][0]["priceUsd"] == 5.75
    assert all(card["itemName"] != "Cortado" for card in result["cards"])
    stored = store.niches["unsweetened-oat-espresso"]
    assert "titles" not in stored
    assert "text" not in json.dumps(stored["drinks"])
    assert stored["drinks"]
    assert niche_is_fresh({"scrapedAt": NOW - timedelta(days=3)}, NOW)
    assert not niche_is_fresh({"scrapedAt": NOW - timedelta(days=7)}, NOW)


def test_job_without_a_scrape_does_not_reuse_a_stale_niche():
    store = MemoryStore(
        events={"u1": demo_events(NOW)},
        menus=demo_menus(NOW),
        niches={
            "oat-milk-espresso-drinks": {
                "scrapedAt": NOW - timedelta(days=1),
                "drinks": [{"name": "Lavender oat latte", "momentum": "rising"}],
            },
            "unsweetened-oat-espresso": {
                "scrapedAt": NOW - timedelta(days=8),
                "drinks": [{"name": "Cappuccino", "momentum": "rising"}],
            },
        },
    )
    result = run_job(store, "u1", scrape=None, now=NOW)
    assert [card["itemName"] for card in result["cards"]] == ["Lavender Oat Latte"]
