"""The Firestore store: the translation to the app's document shapes, ownership, versions, and the flow on top.

Runs against a fake client (tests/fake_firestore.py), so no network and no emulator. The same store tests run
against the real Firestore emulator when FIRESTORE_EMULATOR_HOST is set (CI does this, see ci.yml).
"""

import os
from datetime import datetime, timezone

import pytest

import fake_firestore
from agent_helpers import OWNER, FakeReader, InlineExecutor, config, item, make_brain, result, seeded_store
from menu_reader.schema import Changes, PriceChange
from jolo_agent import messages
from jolo_agent.flow import MenuUpdateFlow
from jolo_agent.store import Cafe, Draft, hash_phone, to_e164
from jolo_agent.store import firestore as fs
from jolo_agent.store.base import StaleMenu
from jolo_agent.store.firestore import FirestoreStore

OWNER_E164 = "+16095550100"
PHONE = hash_phone(OWNER)

# A café document as the app's seed script writes it: a lot of fields the brain doesn't own.
APP_CAFE = {
    "name": "Coffee Culture Roastery", "nameLower": "coffee culture roastery", "source": "osm",
    "address": "462 Springfield Avenue, Berkeley Heights, NJ 07922",
    "location": {"lat": 40.6843063, "lng": -74.4402301},
    "hours": {"mo": [], "tu": [{"open": "07:00", "close": "11:00"}], "we": [{"open": "07:00", "close": "11:00"}],
              "th": [], "fr": [{"open": "07:00", "close": "11:00"}, {"open": "13:00", "close": "18:00"}],
              "sa": [], "su": []},
    "website": "https://www.coffeecultureroasterynj.com/", "amenities": {"wifi": None, "outdoorSeating": False},
}


@pytest.fixture(params=["fake", "emulator"])
def db(request):
    """The fake client, or the emulator's (skipped unless FIRESTORE_EMULATOR_HOST is set)."""
    if request.param == "fake":
        yield fake_firestore.FakeFirestore()
        return
    if not os.environ.get("FIRESTORE_EMULATOR_HOST"):
        pytest.skip("Set FIRESTORE_EMULATOR_HOST to run against the Firestore emulator")
    client = fs.make_client()
    wipe(client)
    yield client
    wipe(client)


def wipe(client):
    for name in ["cafes", *fs.AGENT_COLLECTIONS.values()]:
        for snapshot in client.collection(name).stream():
            for sub in snapshot.reference.collections():
                for inner in sub.stream():
                    inner.reference.delete()
            snapshot.reference.delete()


def store_for(db, **kwargs):
    emulator = isinstance(db, fake_firestore.FakeFirestore) is False
    return FirestoreStore(client=db, transactional=None if emulator else fake_firestore.fake_transactional,
                          cache_seconds=kwargs.pop("cache_seconds", 0.0), **kwargs)


def put(db, path, data):
    db.document(path).set(data) if not isinstance(db, fake_firestore.FakeFirestore) else db.put(path, data)


def get(db, path):
    if isinstance(db, fake_firestore.FakeFirestore):
        return db.docs.get(path)
    snapshot = db.document(path).get()
    return snapshot.to_dict() if snapshot.exists else None


def bridge_cafe(db, cafe_id="owner-16095550100"):
    """What the bridge's onboarding creates: a name, an owner and no menu."""
    put(db, f"cafes/{cafe_id}", {"name": "Barbara's", "ownerName": "Barbara", "ownerPhone": OWNER_E164,
                                 "source": "imessage", "currentMenuVersion": 0})
    return cafe_id


# ---------- translation ----------

def test_hours_survive_the_round_trip_including_a_break_and_closed_days():
    hours = fs.hours_from_app(APP_CAFE["hours"])
    assert hours == {"tue": ["07:00", "11:00"], "wed": ["07:00", "11:00"], "fri": ["07:00", "11:00", "13:00", "18:00"]}
    again = fs.hours_to_app(hours)
    assert again["mo"] == [] and again["fr"] == [{"open": "07:00", "close": "11:00"},
                                                 {"open": "13:00", "close": "18:00"}]
    assert fs.hours_from_app(again) == hours


def test_a_cafe_the_bridge_just_created_loads_with_no_menu_hours_or_place():
    cafe = fs.cafe_from_doc("owner-1", {"name": "Barbara's", "ownerPhone": OWNER_E164, "currentMenuVersion": 0})
    assert (cafe.current_version, cafe.hours, cafe.lat, cafe.address) == (0, {}, None, None)
    assert cafe.owner_phone == OWNER_E164 and cafe.owner_phone_hash == PHONE


def test_an_app_cafe_loads_location_and_hours():
    cafe = fs.cafe_from_doc("osm-1", APP_CAFE)
    assert (cafe.lat, cafe.lng) == (40.6843063, -74.4402301)
    assert cafe.hours["fri"] == ["07:00", "11:00", "13:00", "18:00"] and "mon" not in cafe.hours
    assert cafe.owner_phone_hash is None


def test_timestamps_become_iso_strings_and_back():
    moment = datetime(2026, 11, 9, 14, 30, tzinfo=timezone.utc)
    assert fs.to_iso(moment) == "2026-11-09T14:30:00+00:00"
    assert fs.to_datetime("2026-11-09T14:30:00+00:00") == moment
    assert fs.to_datetime("2026-11-09T14:30:00").tzinfo is not None
    assert fs.to_iso(None) is None


def test_to_e164():
    assert to_e164("+1 (609) 555-0100") == to_e164("6095550100") == OWNER_E164
    assert to_e164("a@b.com") is None and to_e164("terminal-user") is None


def test_the_phone_hash_made_from_ownerPhone_matches_the_one_made_from_the_sender():
    assert fs.cafe_from_doc("x", {"ownerPhone": OWNER_E164}).owner_phone_hash == hash_phone("+1 609 555 0100")


# ---------- cafés ----------

def test_upsert_never_overwrites_what_the_app_wrote(db):
    put(db, "cafes/osm-1", {**APP_CAFE, "currentMenuVersion": 4})
    store = store_for(db)
    cafe = store.get_cafe("osm-1")
    cafe.vibe = "calm"
    cafe.current_version = 0              # a stale copy must not move the version back
    cafe.hours = {}
    store.upsert_cafe(cafe)
    doc = get(db, "cafes/osm-1")
    assert doc["website"] == APP_CAFE["website"] and doc["amenities"] == APP_CAFE["amenities"]
    assert doc["hours"]["fr"] == APP_CAFE["hours"]["fr"]
    assert doc["currentMenuVersion"] == 4 and doc["vibe"] == "calm"


def test_a_new_cafe_gets_version_zero(db):
    store = store_for(db)
    store.upsert_cafe(Cafe(cafe_id="new", name="New", lat=40.0, lng=-74.0, hours={"mon": ["07:00", "15:00"]}))
    doc = get(db, "cafes/new")
    assert doc["currentMenuVersion"] == 0 and doc["location"] == {"lat": 40.0, "lng": -74.0}
    assert doc["hours"]["mo"] == [{"open": "07:00", "close": "15:00"}] and doc["hours"]["tu"] == []


def test_list_cafes_is_cached_and_forgotten_on_upsert(db):
    put(db, "cafes/a", {"name": "A"})
    store = store_for(db, cache_seconds=60.0)
    assert [cafe.cafe_id for cafe in store.list_cafes()] == ["a"]
    put(db, "cafes/b", {"name": "B"})
    assert [cafe.cafe_id for cafe in store.list_cafes()] == ["a"]           # still cached
    store.upsert_cafe(Cafe(cafe_id="c", name="C"))
    assert [cafe.cafe_id for cafe in store.list_cafes()] == ["a", "b", "c"]


# ---------- ownership ----------

def test_owner_is_found_by_the_raw_phone_the_bridge_stored(db):
    bridge_cafe(db)
    put(db, "cafes/osm-1", APP_CAFE)
    store = store_for(db)
    assert store.find_cafe_by_owner(PHONE).cafe_id == "owner-16095550100"
    assert store.find_cafe_by_owner(hash_phone("6095550199")) is None


def test_a_newly_linked_owner_is_found_after_the_short_wait(db, monkeypatch):
    clock = [1000.0]
    monkeypatch.setattr(fs.time, "monotonic", lambda: clock[0])
    store = store_for(db, cache_seconds=60.0)
    assert store.find_cafe_by_owner(PHONE) is None
    bridge_cafe(db)
    assert store.find_cafe_by_owner(PHONE) is None           # looked less than 5 s ago: not asked again
    clock[0] += 6
    assert store.find_cafe_by_owner(PHONE).cafe_id == "owner-16095550100"


def test_an_old_owner_is_not_matched_once_the_phone_changed(db):
    bridge_cafe(db)
    store = store_for(db, cache_seconds=60.0)
    assert store.find_cafe_by_owner(PHONE) is not None
    put(db, "cafes/owner-16095550100", {"name": "Barbara's", "ownerPhone": "+16095550177", "currentMenuVersion": 0})
    assert store.find_cafe_by_owner(PHONE) is None


# ---------- menu versions ----------

def test_a_saved_version_has_the_shape_of_the_contract(db):
    cafe_id = bridge_cafe(db)
    store = store_for(db)
    changes = Changes(new_items=["Mocha"], price_changes=[PriceChange(item="Cortado", old_usd=4.5, new_usd=4.75)])
    version = store.save_menu_version(cafe_id, [item("Cortado", 4.75), item("Mocha", 5.0, confidence=0.55)],
                                      hours="7am - 3pm", source="photo", scope="partial", changes=changes)
    assert version.version == 1
    doc = get(db, f"cafes/{cafe_id}/menuVersions/1")
    assert (doc["version"], doc["basedOn"], doc["scope"], doc["source"]) == (1, 0, "partial", "imessage")
    assert doc["createdBy"] == {"phone": OWNER_E164, "uid": None}
    assert isinstance(doc["createdAt"], datetime)
    assert [(entry["id"], entry["item"], entry["available"]) for entry in doc["items"]] == [
        ("cortado", "Cortado", True), ("mocha", "Mocha", True)]
    assert doc["items"][1]["confidence"] == 0.55 and doc["items"][0]["prices"] == [{"size": None, "usd": 4.75}]
    assert doc["changes"] == {"added": ["Mocha"], "changed": [], "removed": [],
                              "price_changes": [{"item": "Cortado", "size": None, "old_usd": 4.5, "new_usd": 4.75}]}
    cafe_doc = get(db, f"cafes/{cafe_id}")
    assert cafe_doc["currentMenuVersion"] == 1 and isinstance(cafe_doc["menuUpdatedAt"], datetime)
    assert cafe_doc["name"] == "Barbara's" and cafe_doc["ownerPhone"] == OWNER_E164      # untouched


def test_the_next_version_is_based_on_the_last_and_keeps_item_ids(db):
    cafe_id = bridge_cafe(db)
    store = store_for(db)
    store.save_menu_version(cafe_id, [item("Cortado", 4.5), item("Latte", 5.0)])
    second = store.save_menu_version(cafe_id, [item("Mocha", 5.0), item("Latte", 5.25), item("Cortado", 4.75)])
    doc = get(db, f"cafes/{cafe_id}/menuVersions/2")
    assert second.version == 2 and doc["basedOn"] == 1
    assert {entry["item"]: entry["id"] for entry in doc["items"]} == {"Cortado": "cortado", "Latte": "latte", "Mocha": "mocha"}
    assert store.get_cafe(cafe_id).current_version == 2
    assert [v.version for v in store.list_menu_versions(cafe_id)] == [1, 2]
    assert store.get_menu_version(cafe_id, 1).items[1].prices[0].usd == 5.0         # history is still there


def test_two_items_with_the_same_name_get_different_ids(db):
    cafe_id = bridge_cafe(db)
    store = store_for(db)
    store.save_menu_version(cafe_id, [item("Latte", 5.0, category="drink"), item("Latte", 3.0, category="food")])
    assert [entry["id"] for entry in get(db, f"cafes/{cafe_id}/menuVersions/1")["items"]] == ["latte", "latte-2"]


def test_sold_out_in_the_app_is_read_and_kept_by_the_next_version(db):
    cafe_id = bridge_cafe(db)
    store = store_for(db)
    store.save_menu_version(cafe_id, [item("Cortado", 4.5), item("Muffin", 3.0, category="food")])
    doc = get(db, f"cafes/{cafe_id}/menuVersions/1")
    doc["items"][1]["available"] = False              # the owner marked the muffin sold out in the app
    put(db, f"cafes/{cafe_id}/menuVersions/1", doc)
    assert store.get_current_menu(cafe_id).sold_out == ["Muffin"]
    store.save_menu_version(cafe_id, [item("Cortado", 4.75), item("Muffin", 3.0, category="food")])
    items = get(db, f"cafes/{cafe_id}/menuVersions/2")["items"]
    assert {entry["item"]: entry["available"] for entry in items} == {"Cortado": True, "Muffin": False}
    store.save_menu_version(cafe_id, [item("Cortado", 4.75)])                       # the muffin is gone for good
    assert store.get_current_menu(cafe_id).sold_out == []


def test_removed_is_only_recorded_when_the_owner_said_full(db):
    cafe_id = bridge_cafe(db)
    store = store_for(db)
    store.save_menu_version(cafe_id, [item("Cortado", 4.5)], scope="partial", changes=Changes(missing_from_photo=["Latte"]))
    store.save_menu_version(cafe_id, [item("Cortado", 4.5)], scope="full", changes=Changes(missing_from_photo=["Latte"]))
    assert get(db, f"cafes/{cafe_id}/menuVersions/1")["changes"]["removed"] == []
    assert get(db, f"cafes/{cafe_id}/menuVersions/2")["changes"]["removed"] == ["Latte"]


def test_a_menu_the_app_wrote_is_readable_even_with_an_odd_item(db):
    cafe_id = bridge_cafe(db)
    put(db, f"cafes/{cafe_id}", {"name": "Barbara's", "ownerPhone": OWNER_E164, "currentMenuVersion": 1})
    put(db, f"cafes/{cafe_id}/menuVersions/1", {
        "version": 1, "basedOn": 0, "source": "app", "createdAt": datetime(2026, 11, 1, tzinfo=timezone.utc),
        "createdBy": {"phone": None, "uid": "abc"},
        "items": [{"id": "cortado", "item": "Cortado", "category": "drink", "prices": [{"size": None, "usd": 4.5}],
                   "confidence": 1, "available": True},
                  {"id": "x", "item": "Mystery", "category": "souvenir", "prices": []}],
        "changes": {"added": [{"itemId": "cortado", "item": "Cortado"}], "price_changes": [], "removed": []}})
    version = store_for(db).get_current_menu(cafe_id)
    assert [entry.item for entry in version.items] == ["Cortado"]
    assert (version.source, version.created_at, version.changes.new_items) == ("app", "2026-11-01T00:00:00+00:00", ["Cortado"])


def test_save_for_an_unknown_cafe_raises(db):
    with pytest.raises(KeyError):
        store_for(db).save_menu_version("nowhere", [item("Cortado", 4.5)])


def test_a_menu_that_moved_on_is_not_overwritten(db):
    cafe_id = bridge_cafe(db)
    store = store_for(db)
    store.save_menu_version(cafe_id, [item("Cortado", 4.5)])
    with pytest.raises(StaleMenu):
        store.save_menu_version(cafe_id, [item("Cortado", 9.0)], expected_version=0)
    assert store.get_cafe(cafe_id).current_version == 1
    assert store.save_menu_version(cafe_id, [item("Cortado", 4.75)], expected_version=1).version == 2


def test_menu_versions_lists_every_cafes_current_version(db):
    bridge_cafe(db)
    put(db, "cafes/osm-1", APP_CAFE)
    assert store_for(db).menu_versions() == {"owner-16095550100": 0, "osm-1": 0}


# ---------- the brain's own collections ----------

def test_drafts_users_and_events_go_to_agent_collections_not_the_apps_users(db):
    put(db, "users/some-uid", {"displayName": "An app user"})
    store = store_for(db)
    store.save_draft(Draft(phone_hash=PHONE, cafe_id="x", items=[item("Cortado", 4.5)], ops=[{"op": "set_price"}]))
    store.add_event("search", phone_hash=PHONE, data={"query": "latte", "shown": ["a", "b"]})
    store.add_correction("x", PHONE, {"op": "set_price"}, {"a": 1}, {"a": 2})
    assert store.get_draft(PHONE).items[0].item == "Cortado"
    assert get(db, "users/some-uid") == {"displayName": "An app user"}
    assert get(db, f"agentDrafts/{PHONE}") is not None
    store.delete_draft(PHONE)
    assert store.get_draft(PHONE) is None
    assert len(store.list_events("search")) == 1 and len(store.list_corrections("x")) == 1


def test_events_since_are_found_by_time_and_kind(db):
    store = store_for(db)
    store.add_event("search", data={"q": "old"}, created_at="2026-01-01T00:00:00+00:00")
    store.add_event("search", data={"q": "new"}, created_at="2026-11-10T00:00:00+00:00")
    store.add_event("pick", data={}, created_at="2026-11-10T00:00:00+00:00")
    found = store.list_events("search", since="2026-11-01T00:00:00+00:00")
    assert [event.data["q"] for event in found] == ["new"]
    assert len(store.list_events(since="2026-11-01T00:00:00+00:00")) == 2


# ---------- the owner flow, end to end on Firestore ----------

def flow_on(db, *reads):
    store = FirestoreStore(client=db, cache_seconds=0.0,
                           transactional=None if not isinstance(db, fake_firestore.FakeFirestore)
                           else fake_firestore.fake_transactional)
    seeded_store(store)
    sent = []
    flow = MenuUpdateFlow(store, config(), reader=FakeReader(*reads), executor=InlineExecutor(),
                          send=lambda phone_hash, text: sent.append(text))
    return flow, store, sent


def test_photo_to_saved_menu_on_firestore(db):
    flow, store, sent = flow_on(db, result(item("Cortado", 4.75), item("Mocha", 5.0)))
    flow.start_read(PHONE, b"photo")
    summary = flow.set_scope(PHONE, "partial")
    assert "Mocha" in summary
    flow.confirm(PHONE)
    assert store.get_cafe("barbaras").current_version == 2
    assert {entry.item for entry in store.get_current_menu("barbaras").items} == {
        "Cortado", "Latte", "Cheese Empanada", "Mocha"}
    assert get(db, "cafes/barbaras/menuVersions/2")["basedOn"] == 1
    assert store.get_draft(PHONE) is None


def test_the_owner_is_asked_again_when_the_app_changes_the_menu_during_the_save(db):
    flow, store, sent = flow_on(db, result(item("Cortado", 4.75), item("Mocha", 5.0)))
    flow.start_read(PHONE, b"photo")
    flow.set_scope(PHONE, "partial")
    real_save = store.save_menu_version

    def app_edits_first(*args, **kwargs):
        # The app saves its own version between the flow reading the menu and writing its version.
        store.save_menu_version = real_save
        real_save("barbaras", [item("Cortado", 4.95), item("Latte", 5.0), item("Cheese Empanada", 3.5, category="food")],
                  source="app")
        return real_save(*args, **kwargs)

    store.save_menu_version = app_edits_first
    text = flow.confirm(PHONE)
    assert messages.MENU_CHANGED in text and "Mocha" in text
    assert flow.outcomes[PHONE]["kind"] == "stale"
    assert store.get_cafe("barbaras").current_version == 2         # only the app's version was written
    assert store.get_draft(PHONE) is not None                      # the update is still open

    flow.confirm(PHONE)                                            # the owner says yes to the new summary
    assert store.get_cafe("barbaras").current_version == 3
    items = {entry.item: entry for entry in store.get_current_menu("barbaras").items}
    assert items["Mocha"].prices[0].usd == 5.0 and items["Cortado"].prices[0].usd == 4.75


# ---------- the search index follows menus edited elsewhere ----------

def test_refresh_reindexes_only_the_cafes_whose_menu_changed(tmp_path):
    brain = make_brain(tmp_path)
    brain.mark_indexed()
    assert brain.refresh_index() == []
    # The app saves a new version straight into the store; the brain didn't see it.
    brain.store.save_menu_version("barbaras", [item("Cortado", 4.5), item("Pão de Queijo", 4.0, category="food")],
                                  source="app")

    def matching(query):
        return [entry["item"] for found in brain.search.search(query, record=False)["results"]
                for entry in found["matching_items"]]

    assert "Pão de Queijo" not in matching("Pão de Queijo")
    assert brain.refresh_index() == ["barbaras"]
    assert "Pão de Queijo" in matching("Pão de Queijo")
    assert brain.refresh_index() == []                               # nothing more to do


def test_a_failed_reindex_is_tried_again_next_time(tmp_path):
    brain = make_brain(tmp_path)
    brain.mark_indexed()
    brain.store.save_menu_version("curiosity", [item("Matcha Latte", 6.5)], source="app")
    real, calls = brain.reindex, []

    def broken(cafe_id):
        calls.append(cafe_id)
        raise RuntimeError("index busy")

    brain.reindex = broken
    assert brain.refresh_index() == ["curiosity"]
    brain.reindex = real
    assert brain.refresh_index() == ["curiosity"] and calls == ["curiosity"]


def test_the_refresher_is_off_when_the_interval_is_zero(tmp_path):
    brain = make_brain(tmp_path)
    assert brain.start_refresher(0) is None
