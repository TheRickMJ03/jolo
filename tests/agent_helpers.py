"""Fakes for the agent tests: no model server, no Firestore, no model downloads."""

import hashlib
import math

from langchain_core.messages import AIMessage

from menu_reader.config import load_config
from menu_reader.schema import MenuItem, MenuResult, Price
from jolo_agent.brain import Brain, Outbox
from jolo_agent.flow import MenuUpdateFlow
from jolo_agent.search import CafeSearch, SearchIndex, store_docs
from jolo_agent.store import Cafe, MemoryStore, User, hash_phone

OWNER = "+1 609 555 0100"
CUSTOMER = "+1 609 555 0199"
WEEK = {day: ["07:00", "18:00"] for day in ("mon", "tue", "wed", "thu", "fri", "sat", "sun")}


def item(name, usd=None, size=None, confidence=1.0, category="drink", prices=None):
    if prices is None:
        prices = [Price(size=size, usd=usd)] if usd is not None else []
    return MenuItem(item=name, category=category, prices=prices, confidence=confidence)


def result(*items, hours=None):
    return MenuResult(readable=True, items=list(items), hours=hours, confidence=0.8)


def unreadable(reason="blurry"):
    return MenuResult(readable=False, reason=reason)


class InlineExecutor:
    """Runs a 'background' read at once, so tests don't wait for threads."""

    def submit(self, function, *args):
        function(*args)


class HeldExecutor:
    """Keeps reads until run() is called, to test what happens while a photo is being read."""

    def __init__(self):
        self.jobs = []

    def submit(self, function, *args):
        self.jobs.append((function, args))

    def run(self):
        jobs, self.jobs = self.jobs, []
        for function, args in jobs:
            function(*args)


class FakeReader:
    """Returns the queued MenuResults, one per photo, in order."""

    def __init__(self, *results):
        self.results = list(results)
        self.photos = []

    def __call__(self, photo):
        self.photos.append(photo)
        return self.results.pop(0)


class FakeModel:
    """Stands in for Qwen: answers with the scripted messages, in order.

    A script entry is an AIMessage, a string (a text reply), or a list of
    (tool name, args) pairs (tool calls).
    """
    mode = "fake"

    def __init__(self, *script):
        self.script = list(script)
        self.seen = []          # (messages, tool names) of every call

    def invoke(self, messages, tools=()):
        self.seen.append((list(messages), [tool.name for tool in tools]))
        if not self.script:
            raise AssertionError("The model was called more often than the test scripted")
        entry = self.script.pop(0)
        if isinstance(entry, Exception):
            raise entry
        if isinstance(entry, AIMessage):
            return entry
        if isinstance(entry, str):
            return AIMessage(entry)
        return AIMessage("", tool_calls=[{"name": name, "args": args, "id": f"call_{number}", "type": "tool_call"}
                                         for number, (name, args) in enumerate(entry)])


class FakeEmbedder:
    """Bag-of-words vectors: texts that share words are close. Enough to test the plumbing."""
    size = 64

    def _vector(self, text):
        vector = [0.0] * self.size
        for word in text.lower().split():
            vector[int(hashlib.md5(word.strip(".,()").encode()).hexdigest(), 16) % self.size] += 1.0
        norm = math.sqrt(sum(value * value for value in vector)) or 1.0
        return [value / norm for value in vector]

    def embed_documents(self, texts):
        return [self._vector(text) for text in texts]

    def embed_query(self, text):
        return self._vector(text)


def config():
    loaded = load_config("vm")
    loaded["agent"]["search"]["bandit"]["enabled"] = False
    return loaded


def seeded_store():
    """Two cafés. Barbara's has an owner and a three-item menu (version 1)."""
    store = MemoryStore()
    store.upsert_cafe(Cafe(cafe_id="barbaras", name="Barbara's", owner_phone_hash=hash_phone(OWNER),
                           lat=40.3509, lng=-74.6606, hours=WEEK, vibe="warm, family-run",
                           summary="Brazilian café with espresso drinks and empanadas."))
    store.upsert_user(User(phone_hash=hash_phone(OWNER), role="owner", cafe_id="barbaras"))
    store.save_menu_version("barbaras", [item("Cortado", 4.50), item("Latte", 5.00),
                                         item("Cheese Empanada", 3.50, category="food")], source="seed")
    store.upsert_cafe(Cafe(cafe_id="curiosity", name="Curiosity", lat=40.3516, lng=-74.6597,
                           hours={"mon": ["10:00", "21:00"]}, vibe="cozy, students with laptops",
                           summary="Bubble tea and matcha drinks."))
    store.save_menu_version("curiosity", [item("Matcha Latte", 6.00), item("Bubble Tea", 5.50)], source="seed")
    return store


def make_search(store, tmp_path, embedder=None, reranker=None, rng=None):
    index = SearchIndex(tmp_path / "index", embedder)
    index.rebuild(store_docs(store))
    return CafeSearch(store, index, config(), reranker, rng)


def make_brain(tmp_path, model=None, reader=None, store=None, executor=None):
    """A Brain wired with fakes. Late messages land in brain.outbox."""
    settings = config()
    store = store or seeded_store()
    search = make_search(store, tmp_path)
    outbox = Outbox()
    brain = Brain(settings, store, model or FakeModel(), search, outbox=outbox,
                  flow=MenuUpdateFlow(store, settings, reader=reader or FakeReader(),
                                      send=outbox.push, executor=executor or InlineExecutor()))
    brain.flow.on_saved = brain.reindex
    return brain
