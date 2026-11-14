"""The store on Firestore, the source of truth Isaiah's app also reads.

Needs a service-account key: put its path in GOOGLE_APPLICATION_CREDENTIALS
(in .env, never in Git). Not yet run against a real Firebase project.
"""

from jolo_agent.store.base import Store, versions_path


class FirestoreStore(Store):
    def __init__(self, credentials_path=None, client=None):
        """client: a ready Firestore client (for tests); otherwise one is made from the key."""
        super().__init__()
        if client is None:
            import firebase_admin
            from firebase_admin import credentials, firestore
            try:
                app = firebase_admin.get_app()
            except ValueError:
                credential = (credentials.Certificate(credentials_path) if credentials_path
                              else credentials.ApplicationDefault())
                app = firebase_admin.initialize_app(credential)
            client = firestore.client(app)
        self.db = client

    def _get(self, collection, doc_id):
        snapshot = self.db.collection(collection).document(doc_id).get()
        return snapshot.to_dict() if snapshot.exists else None

    def _set(self, collection, doc_id, data):
        self.db.collection(collection).document(doc_id).set(data)

    def _delete(self, collection, doc_id):
        self.db.collection(collection).document(doc_id).delete()

    def _list(self, collection):
        return [snapshot.to_dict() for snapshot in self.db.collection(collection).stream()]

    def _find(self, collection, field, value):
        from google.cloud.firestore_v1.base_query import FieldFilter
        query = self.db.collection(collection).where(filter=FieldFilter(field, "==", value))
        return [snapshot.to_dict() for snapshot in query.stream()]

    def save_menu_version(self, cafe_id, items, hours=None, source="photo", scope=None, changes=None):
        """As in Store, but in a transaction: the app may write the same café at the same time."""
        from google.cloud import firestore
        from jolo_agent.store.models import Cafe

        cafe_ref = self.db.collection("cafes").document(cafe_id)
        versions = self.db.collection(versions_path(cafe_id))

        @firestore.transactional
        def write(transaction):
            snapshot = cafe_ref.get(transaction=transaction)
            if not snapshot.exists:
                raise KeyError(f"No café {cafe_id!r}")
            version, cafe = self._new_version(Cafe.model_validate(snapshot.to_dict()),
                                              items, hours, source, scope, changes)
            transaction.set(versions.document(str(version.version)), version.model_dump())
            transaction.set(cafe_ref, cafe.model_dump())
            return version

        return write(self.db.transaction())
