"""A small stand-in for the Firestore client, for tests that must not need the network or the emulator.

It supports what jolo_agent.store.firestore uses: collections, documents, set (with merge), delete,
stream, where(filter=FieldFilter(...)) with ==, >, >=, select, sub-collections and transactions. Like the
real thing, it refuses an array inside an array.
"""

import copy


def _check(value, inside_list=False):
    if isinstance(value, dict):
        for item in value.values():
            _check(item)
    elif isinstance(value, (list, tuple)):
        if inside_list:
            raise ValueError("Firestore does not allow an array directly inside an array")
        for item in value:
            _check(item, inside_list=True)


def _merge(old, new):
    out = copy.deepcopy(old)
    for key, value in new.items():
        if isinstance(value, dict) and isinstance(out.get(key), dict):
            out[key] = _merge(out[key], value)
        else:
            out[key] = copy.deepcopy(value)
    return out


class Snapshot:
    def __init__(self, doc_id, data):
        self.id = doc_id
        self._data = data

    @property
    def exists(self):
        return self._data is not None

    def to_dict(self):
        return copy.deepcopy(self._data)


class Query:
    def __init__(self, client, path, filters=(), fields=None):
        self.client, self.path, self.filters, self.fields = client, path, list(filters), fields

    def where(self, field=None, op=None, value=None, filter=None):
        if filter is not None:
            field, op, value = filter.field_path, filter.op_string, filter.value
        return Query(self.client, self.path, self.filters + [(field, op, value)], self.fields)

    def select(self, fields):
        return Query(self.client, self.path, self.filters, list(fields))

    @staticmethod
    def _matches(data, field, op, value):
        if field not in data or data[field] is None:
            return False
        actual = data[field]
        return {"==": actual == value, ">": actual > value, ">=": actual >= value}[op]

    def stream(self):
        self.client.reads += 1
        prefix = self.path + "/"
        for full, data in sorted(self.client.docs.items()):
            if not full.startswith(prefix) or "/" in full[len(prefix):]:
                continue
            if all(self._matches(data, *condition) for condition in self.filters):
                shown = {key: data[key] for key in self.fields if key in data} if self.fields is not None else data
                yield Snapshot(full[len(prefix):], copy.deepcopy(shown))


class Collection(Query):
    def document(self, doc_id):
        return Document(self.client, f"{self.path}/{doc_id}")


class Document:
    def __init__(self, client, path):
        self.client, self.path = client, path
        self.id = path.rsplit("/", 1)[-1]

    def get(self, transaction=None):
        self.client.reads += 1
        return Snapshot(self.id, copy.deepcopy(self.client.docs.get(self.path)))

    def set(self, data, merge=False):
        _check(data)
        old = self.client.docs.get(self.path)
        self.client.docs[self.path] = _merge(old, data) if merge and old is not None else copy.deepcopy(data)

    def delete(self):
        self.client.docs.pop(self.path, None)

    def collection(self, name):
        return Collection(self.client, f"{self.path}/{name}")


class Transaction:
    def __init__(self, client):
        self.client = client

    def set(self, reference, data, merge=False):
        reference.set(data, merge=merge)


class FakeFirestore:
    def __init__(self):
        self.docs = {}        # "cafes/barbaras/menuVersions/1" -> dict
        self.reads = 0
        self.transactions = 0

    def collection(self, name):
        return Collection(self, name)

    def transaction(self):
        self.transactions += 1
        return Transaction(self)

    def put(self, path, data):
        """Seed a document the way the app or the bridge would have written it."""
        self.docs[path] = copy.deepcopy(data)


def fake_transactional(function):
    """Stands in for google.cloud.firestore.transactional: runs the function with the transaction."""
    return lambda transaction: function(transaction)
