"""iMessage asks land where the app's For you can read them."""

from jolo_agent.store.firestore import FirestoreStore
from tests.fake_firestore import FakeFirestore


def saved(db, prefix):
    return [data for path, data in db.docs.items() if path.startswith(prefix)]


def test_an_ask_waits_under_the_phone_when_there_is_no_app_account():
    db = FakeFirestore()
    store = FirestoreStore(client=db, transactional=None)
    store.record_customer_ask("+1 (908) 555-1234", "  chai tea ", ["osm-1", "osm-2"], history_only=True)
    rows = saved(db, "customerAsks/+19085551234/items/")
    assert len(rows) == 1
    assert rows[0]["text"] == "chai tea"
    assert rows[0]["cafeIds"] == ["osm-1", "osm-2"]
    assert rows[0]["historyOnly"] is True
    assert store.record_customer_ask("not a phone", "hello") is None
    assert len(saved(db, "customerAsks/")) == 1
