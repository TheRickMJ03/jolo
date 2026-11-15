import sys
from pathlib import Path

import yaml

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))
import push_cafes_firestore as push                                          # noqa: E402

REPO = Path(__file__).resolve().parent.parent


def test_doc_id_matches_the_apps_osm_import():
    assert push.doc_id("node/13811269295") == "osm-node-13811269295"
    assert push.doc_id("way/42") == "osm-way-42"


def test_doc_has_the_apps_shape():
    cafe = {"name": "Junbi", "address": "27 Witherspoon Street, Princeton", "lat": 40.35, "lng": -74.66,
            "hours": {"mon": ["07:00", "15:00"]}, "vibe": "", "summary": "",
            "osm": {"id": "node/1", "opening_hours": "Mo 07:00-15:00", "website": "https://x", "phone": None,
                    "brand": None, "municipality": "Princeton", "wifi": None, "outdoor_seating": True,
                    "drive_through": None}}
    doc = push.build_doc(cafe)
    assert doc["source"] == "osm" and doc["osmId"] == "node/1" and doc["nameLower"] == "junbi"
    assert doc["hours"]["mo"] == [{"open": "07:00", "close": "15:00"}] and doc["hours"]["tu"] == []
    assert doc["amenities"] == {"wifi": None, "outdoorSeating": True, "driveThrough": None}
    assert doc["isChain"] is False
    assert "vibe" not in doc and "summary" not in doc          # blank fields are not written
    assert "ownerPhone" not in doc and "currentMenuVersion" not in doc


def test_every_real_cafe_in_the_file_builds():
    cafes = yaml.safe_load((REPO / "data" / "cafes_osm.yaml").read_text(encoding="utf-8"))["cafes"]
    ids = [push.doc_id(push.build_doc(c)["osmId"]) for c in cafes.values()]
    assert len(ids) == len(set(ids)) and all(i.startswith("osm-") for i in ids)


def test_store_backend_can_be_chosen_by_environment(monkeypatch):
    from menu_reader.config import load_config
    monkeypatch.delenv("JOLO_STORE_BACKEND", raising=False)
    assert load_config()["agent"]["store"]["backend"] == "memory"
    monkeypatch.setenv("JOLO_STORE_BACKEND", "firestore")
    assert load_config()["agent"]["store"]["backend"] == "firestore"


def test_reader_accepts_a_geopoint_location():
    from types import SimpleNamespace
    from jolo_agent.store.firestore import cafe_from_doc
    geo = SimpleNamespace(latitude=40.35, longitude=-74.66)
    cafe = cafe_from_doc("osm-node-1", {"name": "Junbi", "location": geo})
    assert (cafe.lat, cafe.lng) == (40.35, -74.66)
    cafe = cafe_from_doc("x", {"name": "Y", "location": {"lat": 1.5, "lng": 2.5}})
    assert (cafe.lat, cafe.lng) == (1.5, 2.5)
    assert cafe_from_doc("z", {"name": "Z"}).lat is None
