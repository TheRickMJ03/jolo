"""Tests for café search and the HTTP API. Models are faked: nothing is downloaded."""

import random
from datetime import datetime
from zoneinfo import ZoneInfo

from fastapi.testclient import TestClient

from agent_helpers import (CUSTOMER, OWNER, FakeEmbedder, FakeModel, FakeReader, item, make_brain, make_search,
                           result, seeded_store)
from api.app import create_app
from jolo_agent import messages
from jolo_agent.places import is_open, miles_between, resolve_location
from jolo_agent.search import SearchIndex, cafe_docs, store_docs
from jolo_agent.search.cafes import feedback_counts, thompson_sample

MONDAY_NOON = datetime(2026, 11, 16, 12, 0, tzinfo=ZoneInfo("America/New_York"))
TUESDAY_NOON = datetime(2026, 11, 17, 12, 0, tzinfo=ZoneInfo("America/New_York"))


def found(response):
    return [cafe["cafe_id"] for cafe in response["results"]]


# ---------- places ----------

def test_miles_between_and_open_hours():
    assert miles_between((40.3487, -74.6593), (40.3487, -74.6593)) == 0
    assert 0.4 < miles_between((40.3487, -74.6593), (40.3422, -74.6596)) < 0.5      # Nassau Hall to the station
    hours = {"mon": ["10:00", "21:00"]}
    assert is_open(hours, MONDAY_NOON) is True
    assert is_open(hours, TUESDAY_NOON) is False            # no entry for the day: closed
    assert is_open(hours, MONDAY_NOON.replace(hour=21)) is False
    assert is_open({}, MONDAY_NOON) is None                 # no hours stored: unknown, not closed


def test_resolve_location():
    cafes = seeded_store().list_cafes()
    places = {"nassau hall": (40.3487, -74.6593)}
    assert resolve_location("40.35, -74.66") == (40.35, -74.66)
    assert resolve_location("near Nassau Hall", cafes, places) == (40.3487, -74.6593)
    assert resolve_location("Barbara's", cafes, places) == (40.3509, -74.6606)
    assert resolve_location("the moon", cafes, places) is None
    assert resolve_location("", cafes, places) is None


# ---------- index ----------

def test_docs_one_per_cafe_and_one_per_item():
    docs = store_docs(seeded_store())
    assert [doc["kind"] for doc in docs].count("cafe") == 2 and len(docs) == 7
    assert docs[1] == {"id": "barbaras#item0", "cafe_id": "barbaras", "kind": "item", "name": "Cortado",
                       "text": "Cortado, drink at Barbara's", "prices": "$4.50"}


def test_keyword_search_ignores_accents_and_case(tmp_path):
    store = seeded_store()
    store.save_menu_version("barbaras", [item("Açaí Bowl", 9.0, category="food")])
    index = SearchIndex(tmp_path / "index")
    index.rebuild(store_docs(store))
    assert index.search("ACAI")[0][0]["name"] == "Açaí Bowl"
    assert index.search("sushi") == []
    assert not index.has_vectors


def test_hybrid_search_reindex_and_reload(tmp_path):
    store = seeded_store()
    index = SearchIndex(tmp_path / "index", FakeEmbedder())
    index.rebuild(store_docs(store))
    assert index.has_vectors
    assert index.search("matcha latte", mode="vector")[0][0]["name"] == "Matcha Latte"
    assert index.search("matcha latte", mode="hybrid")[0][0]["name"] == "Matcha Latte"

    store.save_menu_version("barbaras", [item("Mocha", 5.5)])
    cafe = store.get_cafe("barbaras")
    index.reindex_cafe("barbaras", cafe_docs(cafe, store.get_current_menu("barbaras").items))
    assert index.search("cortado", mode="bm25") == []                      # the old menu is gone
    assert index.search("mocha", mode="bm25")[0][0]["cafe_id"] == "barbaras"
    assert sum(row["cafe_id"] == "curiosity" for row in index.rows) == 3   # other cafés untouched

    reopened = SearchIndex(tmp_path / "index", FakeEmbedder())             # as after a restart
    assert len(reopened.rows) == len(index.rows) and reopened.has_vectors
    assert reopened.search("mocha")[0][0]["name"] == "Mocha"


def test_unchanged_documents_are_not_embedded_again(tmp_path):
    class Counting(FakeEmbedder):
        embedded = 0

        def embed_documents(self, texts):
            self.embedded += len(texts)
            return super().embed_documents(texts)

    store, embedder = seeded_store(), Counting()
    index = SearchIndex(tmp_path / "index", embedder)
    index.rebuild(store_docs(store))
    index.rebuild(store_docs(store))
    assert embedder.embedded == 7


# ---------- search_cafes ----------

def test_search_returns_the_reason_and_logs_the_event(tmp_path):
    store = seeded_store()
    search = make_search(store, tmp_path)
    response = search.search("matcha latte", phone_hash="hash", now=MONDAY_NOON)
    top = response["results"][0]
    assert top["cafe_id"] == "curiosity" and top["matching_items"] == [{"item": "Matcha Latte", "prices": "$6.00"}]
    assert top["open_now"] is True and "miles" not in top and "score" not in top
    event = store.list_events("search")[0]
    assert event.data == {"query": "matcha latte", "shown": found(response)} and event.phone_hash == "hash"


def test_open_now_and_distance_filters(tmp_path):
    search = make_search(seeded_store(), tmp_path)
    assert found(search.search("latte", now=MONDAY_NOON, record=False)) == ["barbaras", "curiosity"]
    assert found(search.search("latte", open_now=True, now=TUESDAY_NOON, record=False)) == ["barbaras"]

    near = search.search("latte", near="Barbara's", now=MONDAY_NOON, record=False)
    assert [cafe["miles"] for cafe in near["results"]] == [0.0, 0.1]
    assert found(search.search("latte", near="Barbara's", max_miles=0.05, record=False)) == ["barbaras"]
    unknown = search.search("latte", near="the moon", record=False)
    assert "don't know where" in unknown["note"] and len(unknown["results"]) == 2


def test_a_request_that_names_no_dish_still_lists_open_cafes(tmp_path):
    search = make_search(seeded_store(), tmp_path)
    assert found(search.search("zzz", open_now=True, now=TUESDAY_NOON, record=False)) == ["barbaras"]


def test_reranker_decides_the_order(tmp_path):
    class PrefersCuriosity:
        def score(self, query, documents):
            return [1.0 if document.startswith("Curiosity") else 0.1 for document in documents]

    search = make_search(seeded_store(), tmp_path, reranker=PrefersCuriosity())
    assert found(search.search("latte", record=False)) == ["curiosity", "barbaras"]
    assert found(search.search("latte", rerank=False, record=False)) == ["barbaras", "curiosity"]


def test_thompson_sampling_favours_picked_cafes_but_still_explores(tmp_path):
    rng = random.Random(7)
    often_picked = [thompson_sample(50, 40, rng) for _ in range(200)]
    rarely_picked = [thompson_sample(50, 2, rng) for _ in range(200)]
    never_shown = [thompson_sample(0, 0, rng) for _ in range(200)]
    assert min(often_picked) > max(rarely_picked)
    assert max(never_shown) > 0.9 and min(never_shown) < 0.1         # unknown cafés get wide draws

    store = seeded_store()
    for _ in range(30):
        store.add_event("search", data={"query": "latte", "shown": ["barbaras", "curiosity"]})
        store.add_event("pick", "curiosity")
    assert feedback_counts(store) == {"barbaras": (30, 0), "curiosity": (30, 30)}
    search = make_search(store, tmp_path, rng=random.Random(1))
    search.settings["bandit"]["weight"] = 2.0
    assert found(search.search("latte", bandit=True, record=False)) == ["curiosity", "barbaras"]


# ---------- API ----------

def client_for(tmp_path, model=None, reader=None):
    brain = make_brain(tmp_path, model, reader)
    brain.warm = lambda: None
    return TestClient(create_app(brain)), brain


def test_api_owner_photo_flow(tmp_path):
    client, brain = client_for(tmp_path, reader=FakeReader(result(item("Mocha", 5.50))))
    sent = client.post("/messages", data={"phone": OWNER, "text": "update the menu"},
                       files=[("photos", ("menu.heic", b"original bytes", "image/heic"))])
    assert sent.status_code == 200 and sent.json() == {"replies": [messages.READING, messages.ASK_SCOPE]}
    assert brain.flow.reader.photos == [b"original bytes"]

    waiting = client.get("/outbox", params={"phone": OWNER}).json()["messages"]
    assert len(waiting) == 1 and "Is this your full menu" in waiting[0]
    assert client.get("/outbox", params={"phone": OWNER}).json() == {"messages": []}      # delivered once

    client.post("/messages", data={"phone": OWNER, "text": "just part of it"})
    saved = client.post("/messages", data={"phone": OWNER, "text": "yes"}).json()["replies"][0]
    assert saved == "Your menu is updated (version 2): 1 new item."


def test_api_customer_message_and_validation(tmp_path):
    model = FakeModel([("get_menu", {"cafe_id": "barbaras", "contains": "latte"})], "A latte is $5.00.")
    client, _brain = client_for(tmp_path, model)
    assert client.post("/messages", data={"phone": CUSTOMER, "text": "latte at barbara's?"}).json() \
        == {"replies": ["A latte is $5.00."]}
    assert client.post("/messages", data={"phone": "not a number", "text": "hi"}).status_code == 422
    assert client.post("/messages", data={"text": "hi"}).status_code == 422


def test_api_health_users_and_insights(tmp_path):
    client, brain = client_for(tmp_path)
    health = client.get("/health").json()
    assert health["cafes"] == 2 and health["store"] == "memory" and health["search"]["documents"] == 7
    assert isinstance(health["model_server"], bool)

    new_owner = {"phone": "+1 609 555 0142", "name": "Ana", "role": "owner", "cafe_id": "curiosity"}
    assert client.post("/users", json=new_owner).status_code == 200
    assert client.post("/messages", data={"phone": "6095550142"},
                       files=[("photos", ("m.jpg", b"x", "image/jpeg"))]).json()["replies"][0] == messages.READING
    assert client.post("/users", json={**new_owner, "phone": "+1 609 555 0143"}).status_code == 409
    assert client.post("/users", json={**new_owner, "cafe_id": "nowhere"}).status_code == 404

    assert client.get("/insights/barbaras").json()["times_suggested"] == 0
    assert client.get("/insights/nowhere").status_code == 404


def test_api_key_is_required_when_set(tmp_path, monkeypatch):
    client, _brain = client_for(tmp_path)
    monkeypatch.setenv("JOLO_API_KEY", "secret")
    assert client.get("/health").status_code == 401
    assert client.get("/health", headers={"X-Jolo-Key": "secret"}).status_code == 200


def test_late_messages_go_to_the_callback_when_one_is_set(tmp_path, monkeypatch):
    from jolo_agent import brain as brain_module
    posted = []

    class Ok:
        def raise_for_status(self):
            pass

    monkeypatch.setattr(brain_module.requests, "post", lambda url, json, timeout: posted.append((url, json)) or Ok())
    brain = make_brain(tmp_path, reader=FakeReader(result(item("Mocha", 5.50))))
    brain.outbox.callback_url = "http://mac.local:3000/jolo"
    brain.handle_message(OWNER, "", [b"photo"])
    assert posted[0][0] == "http://mac.local:3000/jolo" and posted[0][1]["phone"] == OWNER
    assert brain.outbox.drain(OWNER) == []                # not delivered twice
