"""Tests for compare.py, using a hand-made old menu and a hand-made new one."""

import io

from PIL import Image

from menu_reader import pipeline
from menu_reader.compare import compare_menus
from menu_reader.config import load_config


def png_bytes():
    buffer = io.BytesIO()
    Image.new("RGB", (300, 200), "white").save(buffer, format="PNG")
    return buffer.getvalue()

OLD_MENU = {"items": [
    {"section": "Coffee", "item": "Cortado", "category": "drink", "prices": [{"size": None, "usd": 4.50}]},
    {"section": "Coffee", "item": "Latte", "category": "drink",
     "prices": [{"size": "Small", "usd": 4.00}, {"size": "Large", "usd": 5.00}]},
    {"section": "Coffee", "item": "Cappuccino", "category": "drink", "prices": [{"size": None, "usd": 4.25}]},
    {"section": "Smoothies", "item": "Açai", "category": "drink", "prices": [{"size": None, "usd": 7.00}]},
    {"section": "Bowls", "item": "Açai", "category": "food", "prices": [{"size": None, "usd": 10.00}]},
    {"section": "Bakery", "item": "Croissant", "category": "food", "prices": [{"size": None, "usd": 3.00}]},
    {"section": "Bakery", "item": "Banana Bread", "category": "food", "prices": [{"size": None, "usd": 3.50}]},
]}

NEW_ITEMS = [
    {"section": "Coffee", "item": "Cortado", "category": "drink", "prices": [{"size": "8 oz", "usd": 4.75}]},
    {"section": "Coffee", "item": "Latte", "category": "drink",
     "prices": [{"size": "small", "usd": 4.00}, {"size": "large", "usd": 5.50}, {"size": "XL", "usd": 6.00}]},
    {"section": "Coffee", "item": "Capuccino", "category": "drink", "prices": [{"size": None, "usd": 4.25}]},
    {"section": "Bowls", "item": "Acai", "category": "food", "prices": [{"size": None, "usd": 11.00}]},
    {"section": "Smoothies", "item": "Açai", "category": "drink", "prices": [{"size": None, "usd": 7.00}]},
    {"section": "Bakery", "item": "Croissant", "category": "food", "prices": []},
    {"section": "Coffee", "item": "Flat White", "category": "drink", "prices": [{"size": None, "usd": 4.50}]},
]


def as_tuples(changes):
    return [(c.item, c.size, c.old_usd, c.new_usd) for c in changes.price_changes]


def test_compare_with_a_hand_made_old_menu():
    changes = compare_menus(OLD_MENU, NEW_ITEMS)

    assert changes.new_items == ["Flat White"]
    assert changes.missing_from_photo == ["Banana Bread"]      # reported, never "removed"
    assert as_tuples(changes) == [
        ("Cortado", "8 oz", 4.5, 4.75),      # one price each: same price slot, size name or not
        ("Latte", "large", 5.0, 5.5),        # sizes match whatever the capitals
        ("Latte", "XL", None, 6.0),          # a size that wasn't there before
        ("Acai", None, 10.0, 11.0),          # the bowl, not the smoothie with the same name
    ]
    # "Capuccino" is the old "Cappuccino": not new, not missing, no price change.
    # Croissant has no price in the photo: nothing to compare, so no change.


def test_no_changes_when_the_menu_is_the_same():
    changes = compare_menus(OLD_MENU, OLD_MENU["items"])
    assert changes.new_items == [] and changes.price_changes == [] and changes.missing_from_photo == []


def test_a_size_that_disappeared():
    old = [{"item": "Latte", "category": "drink",
            "prices": [{"size": "Small", "usd": 4.0}, {"size": "Large", "usd": 5.0}]}]
    new = [{"item": "Latte", "category": "drink",
            "prices": [{"size": "Small", "usd": 4.0}, {"size": "Medium", "usd": 4.5}]}]
    assert as_tuples(compare_menus(old, new)) == [("Latte", "Medium", None, 4.5), ("Latte", "Large", 5.0, None)]


def test_extract_menu_fills_changes_only_with_a_current_menu(monkeypatch):
    def read(image, config, photo_id=None):
        return {"text": "Coffee | Cortado | 4.75 | drink\nCoffee | Mocha | 5 | drink",
                "finish_reason": "stop", "seconds": 1.0, "format": "lines"}
    monkeypatch.setattr(pipeline, "READERS", {"glm_ocr_schema": read})
    config = load_config("laptop_cpu")

    without = pipeline.extract_menu(png_bytes(), config=config)
    assert without.changes.new_items == [] and "compare" not in without.timings

    result = pipeline.extract_menu(png_bytes(), current_menu=OLD_MENU, config=config)
    assert result.changes.new_items == ["Mocha"]
    assert as_tuples(result.changes) == [("Cortado", None, 4.5, 4.75)]
    assert "Latte" in result.changes.missing_from_photo
