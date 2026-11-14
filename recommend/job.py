"""Read a person's events, fill the shared niche cache, write their cards.
With --analytics, also write the owner Insights signals and the area trends.

A niche younger than seven days is reused and only rematched against menus.
Scraped pages never land in Firestore: the niche document stores drink names
and, per source, a headline and link as the example.

    python -m recommend.job --demo
    python -m recommend.job --uid USER_ID --scrape
    python -m recommend.job --analytics --demo-trends   # no network: sample trends
    python -m recommend.job --analytics --scrape         # blogs + Reddit, live
"""
from __future__ import annotations

import argparse
import os
from datetime import datetime, timedelta, timezone

from recommend.analytics import AREA_ID, area_doc, is_drink_name, niche_entry, owner_signals
from recommend.extract import extract_drinks
from recommend.match import match_cards
from recommend.profile import build_profile, coerce_time, slugify
from recommend.scrape import scrape_niche

NICHE_TTL = timedelta(days=7)
EVENT_WINDOW = timedelta(days=90)

# The offline pass. Prices below come from the menu fixture, not from a scrape.
FIXED_NICHES = (
    "oat milk espresso drinks",
    "unsweetened oat espresso",
    "lavender latte",
    "matcha drinks",
    "cold brew",
)

DEMO_TRENDS = {
    "oat milk espresso drinks": {
        "top_phrases": [
            {"term": "oat latte", "posts": 6, "sites": 3},
            {"term": "brown sugar", "posts": 4, "sites": 2},
        ],
        "top_words": [{"term": "latte", "posts": 8, "sites": 3}],
        "momentum": {"rising": [{"term": "oat latte", "recent_pct": 18, "earlier_pct": 4}], "fading": []},
        "ai": {"emerging": [{"name": "Lavender oat latte", "detail": "Showing up in café roundups."}]},
        "titles": [
            "The lavender oat latte cafés are pouring",
            "Why the lavender oat latte works with breakfast",
            "Brown sugar oat latte recipe",
            "Brown sugar oat latte trend",
        ],
    },
    "unsweetened oat espresso": {
        "top_phrases": [{"term": "oat cortado", "posts": 3, "sites": 2}],
        "top_words": [],
        "momentum": None,
        "ai": None,
        "titles": [],
    },
    "lavender latte": {
        "top_phrases": [{"term": "lavender latte", "posts": 4, "sites": 2}],
        "top_words": [],
        "momentum": {"rising": [{"term": "lavender latte", "recent_pct": 12, "earlier_pct": 2}], "fading": []},
        "ai": None,
        "titles": [],
    },
    "matcha drinks": {
        "top_phrases": [{"term": "iced matcha", "posts": 5, "sites": 3}],
        "top_words": [{"term": "matcha", "posts": 5, "sites": 3}],
        "momentum": None,
        "ai": None,
        "titles": [],
    },
    "cold brew": {
        "top_phrases": [{"term": "cold brew", "posts": 4, "sites": 2}],
        "top_words": [{"term": "cold brew", "posts": 4, "sites": 2}],
        "momentum": None,
        "ai": None,
        "titles": [],
    },
}


def niche_is_fresh(document: dict | None, now: datetime, ttl: timedelta = NICHE_TTL) -> bool:
    if not document:
        return False
    scraped = coerce_time(document.get("scrapedAt"))
    if scraped is None:
        return False
    return now - scraped < ttl


class MemoryStore:
    """In-memory stand-in for the Firestore paths the job reads and writes."""

    def __init__(self, events=None, menus=None, niches=None):
        self.events = events or {}
        self.menus = menus or []
        self.niches = dict(niches or {})
        self.tastes = {}
        self.recommendations = {}
        self.owner_analytics = {}
        self.areas = {}

    def list_events(self, uid: str, since: datetime | None = None) -> list[dict]:
        rows = []
        for event in self.events.get(uid, []):
            created = coerce_time(event.get("createdAt"))
            if since and created and created < since:
                continue
            rows.append(event)
        return rows

    def get_niche(self, slug: str) -> dict | None:
        return self.niches.get(slug)

    def put_niche(self, slug: str, document: dict) -> None:
        self.niches[slug] = document

    def put_taste(self, uid: str, document: dict) -> None:
        self.tastes[uid] = document

    def put_recommendations(self, uid: str, document: dict) -> None:
        self.recommendations[uid] = document

    def list_menus(self) -> list[dict]:
        return list(self.menus)

    def list_all_events(self, since: datetime | None = None) -> list[dict]:
        rows = []
        for uid in self.events:
            for event in self.list_events(uid, since):
                rows.append({**event, "uid": uid})
        return rows

    def list_cafes(self) -> list[dict]:
        """Every café with a menu, its current items and its version history."""
        return [
            {
                "versions": menu.get("versions") or [],
                **menu,
            }
            for menu in self.menus
        ]

    def list_niche_docs(self) -> list[dict]:
        return list(self.niches.values())

    def put_owner_analytics(self, cafe_id: str, document: dict) -> None:
        self.owner_analytics[cafe_id] = document

    def put_area(self, area_id: str, document: dict) -> None:
        self.areas[area_id] = document


class FirestoreStore:
    """Admin SDK against a real project, or an anonymous client against the emulator."""

    def __init__(self, project_id: str | None = None):
        project = project_id or os.environ.get("FIRESTORE_PROJECT_ID", "jolo-ec76d")
        if os.environ.get("FIRESTORE_EMULATOR_HOST"):
            # The emulator needs no credentials, and with the host set the
            # client can only ever reach the emulator.
            from google.auth.credentials import AnonymousCredentials
            from google.cloud import firestore as cloud_firestore

            self.db = cloud_firestore.Client(project=project, credentials=AnonymousCredentials())
            return

        import firebase_admin
        from firebase_admin import firestore

        if not firebase_admin._apps:
            firebase_admin.initialize_app(options={"projectId": project})
        self.db = firestore.client()

    def list_events(self, uid: str, since: datetime | None = None) -> list[dict]:
        rows = []
        for snapshot in self.db.collection("users").document(uid).collection("events").stream():
            data = snapshot.to_dict() or {}
            created = coerce_time(data.get("createdAt"))
            if since and created and created < since:
                continue
            rows.append(data)
        return rows

    def get_niche(self, slug: str) -> dict | None:
        snapshot = self.db.collection("niches").document(slug).get()
        if not snapshot.exists:
            return None
        return snapshot.to_dict() or {}

    def put_niche(self, slug: str, document: dict) -> None:
        self.db.collection("niches").document(slug).set(document)

    def put_taste(self, uid: str, document: dict) -> None:
        self.db.collection("users").document(uid).collection("taste").document("current").set(document)

    def put_recommendations(self, uid: str, document: dict) -> None:
        self.db.collection("users").document(uid).collection("recommendations").document("current").set(document)

    def list_menus(self) -> list[dict]:
        menus = []
        for cafe in self.db.collection("cafes").stream():
            data = cafe.to_dict() or {}
            version = data.get("currentMenuVersion") or 0
            if version <= 0:
                continue
            snapshot = cafe.reference.collection("menuVersions").document(str(version)).get()
            if not snapshot.exists:
                continue
            body = snapshot.to_dict() or {}
            menus.append(
                {
                    "cafeId": cafe.id,
                    "cafeName": data.get("name") or "Café",
                    "menuUpdatedAt": data.get("menuUpdatedAt"),
                    "items": body.get("items") or [],
                }
            )
        return menus

    def list_all_events(self, since: datetime | None = None) -> list[dict]:
        """Every customer's events, tagged with the uid from the document path."""
        rows = []
        for snapshot in self.db.collection_group("events").stream():
            parent = snapshot.reference.parent.parent
            if parent is None or snapshot.reference.parent.parent.parent.id != "users":
                continue
            data = snapshot.to_dict() or {}
            created = coerce_time(data.get("createdAt"))
            if since and created and created < since:
                continue
            rows.append({**data, "uid": parent.id})
        return rows

    def list_cafes(self) -> list[dict]:
        cafes = []
        for cafe in self.db.collection("cafes").stream():
            data = cafe.to_dict() or {}
            row = {
                "cafeId": cafe.id,
                "cafeName": data.get("name") or "Café",
                "municipality": data.get("municipality"),
                "ownerPhone": data.get("ownerPhone"),
                "menuUpdatedAt": data.get("menuUpdatedAt"),
                "items": [],
                "versions": [],
            }
            current = data.get("currentMenuVersion") or 0
            if current > 0:
                versions = [snap.to_dict() or {} for snap in cafe.reference.collection("menuVersions").stream()]
                row["versions"] = versions
                for version in versions:
                    if version.get("version") == current:
                        row["items"] = version.get("items") or []
            cafes.append(row)
        return cafes

    def list_niche_docs(self) -> list[dict]:
        return [snap.to_dict() or {} for snap in self.db.collection("niches").stream()]

    def put_owner_analytics(self, cafe_id: str, document: dict) -> None:
        self.db.collection("cafes").document(cafe_id).collection("analytics").document("current").set(document)

    def put_area(self, area_id: str, document: dict) -> None:
        self.db.collection("areas").document(area_id).set(document)


def run_job(store, uid: str, *, scrape=None, now: datetime | None = None) -> dict:
    """Rebuild taste, reuse or fill niches, write recommendations/current."""
    now = coerce_time(now, datetime.now(timezone.utc))
    events = store.list_events(uid, since=now - EVENT_WINDOW)
    taste = build_profile(events, now=now)
    store.put_taste(
        uid,
        {
            "facets": taste["facets"],
            "ordered": taste["ordered"],
            "niches": taste["niches"],
            "updatedAt": now,
        },
    )

    drinks: list[dict] = []
    for niche in taste["niches"]:
        slug = slugify(niche)
        existing = store.get_niche(slug)
        if niche_is_fresh(existing, now):
            drinks.extend(existing.get("drinks") or [])
            continue
        if scrape is None:
            continue
        trends = scrape(niche)
        extracted = extract_drinks(trends)
        store.put_niche(
            slug,
            {"slug": slug, "query": niche, "scrapedAt": now, "drinks": extracted},
        )
        drinks.extend(extracted)

    # Cached niches may hold fragments or staples from before the name filter.
    drinks = [drink for drink in drinks if is_drink_name(drink.get("name") or "")]
    cards = match_cards(drinks, store.list_menus(), taste, now=now)
    store.put_recommendations(uid, {"cards": cards, "niches": taste["niches"], "updatedAt": now})
    return {"taste": taste, "cards": cards}


def refresh_niche(store, niche: str, now: datetime, *, scrape_blogs=None, scrape_social=None) -> dict | None:
    """Reuse a niche scraped in the last seven days, or scrape it now when scrapers are given."""
    slug = slugify(niche)
    existing = store.get_niche(slug)
    if niche_is_fresh(existing, now) and existing.get("sources"):
        return existing
    if scrape_blogs is None and scrape_social is None:
        return existing
    blogs, blog_error = None, None
    if scrape_blogs is not None:
        try:
            blogs = scrape_blogs(niche)
        except Exception as error:  # one source failing never stops the others
            blog_error = str(error)[:200]
    social = scrape_social(niche) if scrape_social is not None else {}
    document = {"slug": slug, **niche_entry(niche, blogs, social, now, blog_error)}
    store.put_niche(slug, document)
    return document


def demo_niche_docs(now: datetime) -> list[dict]:
    """The fixed sample trends, labelled as sample data so the app can say so."""
    docs = []
    for niche in FIXED_NICHES:
        trends = DEMO_TRENDS[niche]
        entry = niche_entry(niche, None, {}, now)
        drinks = [{**drink, "sources": ["demo"], "mentions": 0, "example": None} for drink in extract_drinks(trends)]
        docs.append(
            {
                "slug": slugify(niche),
                **entry,
                "drinks": drinks,
                "sources": {"demo": {"ok": True, "error": None, "posts": len(trends.get("titles") or [])}},
            }
        )
    return docs


def run_analytics(store, *, scrape_blogs=None, scrape_social=None, now: datetime | None = None) -> dict:
    """Refresh niches, then write the area trends, every owner's signals, and every active person's cards."""
    now = coerce_time(now, datetime.now(timezone.utc))
    events = store.list_all_events(since=now - EVENT_WINDOW)
    by_uid: dict[str, list[dict]] = {}
    for event in events:
        by_uid.setdefault(event["uid"], []).append(event)

    niches = list(FIXED_NICHES)
    for uid_events in by_uid.values():
        for niche in build_profile(uid_events, now=now)["niches"]:
            if niche not in niches:
                niches.append(niche)
    for niche in niches[:10]:
        refresh_niche(store, niche, now, scrape_blogs=scrape_blogs, scrape_social=scrape_social)

    niche_docs = store.list_niche_docs()
    cafes = store.list_cafes()
    store.put_area(AREA_ID, area_doc(cafes, events, niche_docs, now))
    owners = [cafe for cafe in cafes if cafe.get("ownerPhone")]
    for cafe in owners:
        store.put_owner_analytics(cafe["cafeId"], owner_signals(cafe, cafes, events, niche_docs, now))
    for uid in by_uid:
        run_job(store, uid, now=now)
    return {"niches": len(niche_docs), "cafes": len(cafes), "owners": len(owners), "people": len(by_uid)}


def _item(item_id, name, category, usd, **extra):
    prices = [] if usd is None else [{"size": None, "usd": usd}]
    return {
        "id": item_id,
        "section": extra.get("section", "Coffee"),
        "item": name,
        "category": category,
        "prices": prices,
        "add_ons": [],
        "variants": [],
        "tags": [],
        "confidence": extra.get("confidence", 1),
        "available": extra.get("available", True),
    }


def demo_events(now: datetime) -> list[dict]:
    return [
        {"type": "search", "text": "oat milk latte", "createdAt": now},
        {"type": "search", "text": "something less sweet", "createdAt": now},
        {
            "type": "purchase",
            "cafeId": "demo-barbaras",
            "itemId": "cortado",
            "itemName": "Cortado",
            "createdAt": now,
        },
    ]


def demo_menus(now: datetime) -> list[dict]:
    """Barbara's, plus a second café that does not pour the trending drink."""
    return [
        {
            "cafeId": "demo-barbaras",
            "cafeName": "Barbara's",
            "menuUpdatedAt": now,
            "items": [
                _item("lavender-oat-latte", "Lavender Oat Latte", "drink", 5.75),
                _item("cortado", "Cortado", "drink", 4.5),
                _item("brown-sugar", "Brown Sugar Oat Latte", "drink", 6),
                _item("muffin", "Muffin", "food", 3.25),
                _item("sold-out", "Sold Out Latte", "drink", 4, available=False),
                _item("mystery", "Mystery Latte", "drink", 4, confidence=0.4),
            ],
        },
        {
            "cafeId": "other",
            "cafeName": "Other Café",
            "menuUpdatedAt": now,
            "items": [_item("cappuccino", "Cappuccino", "drink", 4)],
        },
    ]


def demo_cards(now: datetime | None = None) -> tuple[list[dict], dict]:
    """Five fixed niches through extract and match. No web request."""
    now = coerce_time(now, datetime(2026, 11, 14, tzinfo=timezone.utc))
    taste = build_profile(demo_events(now), now=now)
    candidates = []
    for niche in FIXED_NICHES:
        candidates.extend(extract_drinks(DEMO_TRENDS[niche]))
    return match_cards(candidates, demo_menus(now), taste, now=now), taste


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Write drink cards for one person, or run the offline demo.")
    parser.add_argument("--uid", help="Firebase Auth uid to rebuild")
    parser.add_argument("--scrape", action="store_true", help="Scrape niches older than 7 days")
    parser.add_argument("--demo", action="store_true", help="Match five fixed niches to Barbara's. No network.")
    parser.add_argument("--analytics", action="store_true", help="Write owner signals, area trends and everyone's cards")
    parser.add_argument("--demo-trends", action="store_true", help="With --analytics: store the sample trends as niches")
    parser.add_argument("--no-reddit", action="store_true", help="With --scrape: blogs only")
    parser.add_argument("--project", default=os.environ.get("FIRESTORE_PROJECT_ID", "jolo-ec76d"))
    args = parser.parse_args(argv)

    if args.demo:
        cards, taste = demo_cards()
        print("Niches: " + ", ".join(taste["niches"]))
        if not cards:
            print("No cards.")
            return 0
        for card in cards:
            price = f"${card['priceUsd']:.2f}" if card.get("priceUsd") is not None else "no price"
            print(f"{card['itemName']} at {card['cafeName']} {price}")
            print(f"  {card['why']}")
        return 0

    if args.analytics:
        store = FirestoreStore(args.project)
        now = datetime.now(timezone.utc)
        if args.demo_trends:
            for document in demo_niche_docs(now):
                store.put_niche(document["slug"], document)
        scrape_social = None
        if args.scrape and not args.no_reddit:
            from recommend.social import scrape_social
        summary = run_analytics(
            store,
            scrape_blogs=scrape_niche if args.scrape else None,
            scrape_social=scrape_social,
            now=now,
        )
        print(
            f"{summary['niches']} niches, {summary['cafes']} cafés, "
            f"{summary['owners']} owners and {summary['people']} people updated."
        )
        return 0

    if not args.uid:
        parser.error("--uid is required unless --demo or --analytics")

    store = FirestoreStore(args.project)
    result = run_job(store, args.uid, scrape=scrape_niche if args.scrape else None)
    print(f"{len(result['cards'])} cards for {args.uid}")
    for card in result["cards"]:
        print(f"  {card['itemName']} at {card['cafeName']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
