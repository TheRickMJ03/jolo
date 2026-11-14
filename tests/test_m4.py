"""Tests for the M4 pieces: price formats, sizes in names, merging photos, confidence."""

from menu_reader.confidence import numbers_in_text, score_items
from menu_reader.merge import merge_results
from menu_reader.schema import MenuItem, MenuResult, Price
from menu_reader.validate import build_items, parse_lines_reply, parse_usd, split_size_from_name


# ---------- price formats ----------

def test_price_formats_from_real_menus():
    assert parse_usd("$4.50") == 4.5
    assert parse_usd("4.5") == 4.5
    assert parse_usd("10.5") == 10.5
    assert parse_usd("50¢") == 0.5
    assert parse_usd("+.50") == 0.5
    assert parse_usd("+$1.00") == 1.0
    assert parse_usd("$11:00") == 11.0
    assert parse_usd("7") == 7.0


def test_prices_that_are_never_guessed():
    for text in ("", "market price", "ask", "$", "4.50.2", "6-9", "$675 or so"):
        assert parse_usd(text) is None
    assert parse_usd("$675") == 675.0      # no point printed: read as written, never turned into 6.75


# ---------- sizes written into names ----------

def test_split_size_from_name():
    assert split_size_from_name("French fries (Small)") == ("French fries", "Small")
    assert split_size_from_name("ACAI COPO 12 OZ") == ("ACAI COPO", "12 OZ")
    assert split_size_from_name("RED BULL 8.4 Oz") == ("RED BULL", "8.4 Oz")
    assert split_size_from_name("Latte") == ("Latte", None)
    assert split_size_from_name("Mochi Waffle (3 topings)") == ("Mochi Waffle (3 topings)", None)
    assert split_size_from_name("Large Steamed Buns") == ("Large Steamed Buns", None)


def test_size_in_name_moves_to_the_size():
    items = build_items(parse_lines_reply(
        "Acai | ACAI COPO 12 OZ | 8 | food\n"
        "Acai | ACAI COPO 16 OZ | 9.75 | food\n"
        "Sides | French fries (Small) | 2.75 | food\n"
        "Coffee | Cold Brew 16 oz | SM 4; LG 5 | drink\n"      # already has sizes: name left alone
    ))
    assert [item.item for item in items] == ["ACAI COPO", "French fries", "Cold Brew 16 oz"]
    assert [(p.size, p.usd) for p in items[0].prices] == [("12 OZ", 8.0), ("16 OZ", 9.75)]
    assert [(p.size, p.usd) for p in items[1].prices] == [("Small", 2.75)]


# ---------- lines the model writes in unexpected ways ----------

def test_four_unnamed_prices_stay_on_one_item():
    items = build_items(parse_lines_reply(
        "COFFEE | LATTE | SM 4 | drink\n"
        "COFFEE | DRIP COFFEE | 2; 2.75; 3.50; 4 | drink\n"
        "COFFEE | LATTE | 5; 6; 7; 8 | drink\n"        # same name as an earlier item: still one item
    ))
    assert [item.item for item in items] == ["LATTE", "DRIP COFFEE", "LATTE"]
    assert [(p.size, p.usd) for p in items[1].prices] == [(None, 2.0), (None, 2.75), (None, 3.5), (None, 4.0)]
    assert [p.usd for p in items[2].prices] == [5.0, 6.0, 7.0, 8.0]
    assert [(p.size, p.usd) for p in items[0].prices] == [("SM", 4.0)]


def test_sub_heading_written_as_an_extra_column():
    items = build_items(parse_lines_reply(
        "COFFEE THINGS | KID'S | LITTLE LATTE | 3.25 | drink\n"
        "TEA & OTHER GOODIES | EXTRAS | ADD ESPRESSO | 2 | modifier\n"
        "TEA & OTHER GOODIES | EXTRAS | NON-DAIRY MILK | 0.75 | modifier\n"
        "Coffee | Syrups | 0.75 | modifier | Vanilla; Caramel\n"      # the older 5-column form still works
    ))
    assert [(i.section, i.item, i.prices[0].usd, i.category) for i in items] == [
        ("KID'S", "LITTLE LATTE", 3.25, "drink"),
        ("EXTRAS", "ADD ESPRESSO", 2.0, "modifier"),
        ("EXTRAS", "NON-DAIRY MILK", 0.75, "modifier"),
        ("Coffee", "Syrups", 0.75, "modifier"),
    ]
    assert items[3].variants == ["Vanilla", "Caramel"]


# ---------- merging photos of one menu ----------

def item(name, usd=None, section=None, confidence=0.5, size=None):
    prices = [Price(size=size, usd=usd)] if usd is not None else []
    return MenuItem(section=section, item=name, category="food", prices=prices, confidence=confidence)


def test_merge_results():
    first = MenuResult(readable=True, hours=None, timings={"read": 10.0},
                       items=[item("Edamame", 4), item("Gyoza", 6, confidence=0.4)])
    second = MenuResult(readable=True, hours="11am - closing", timings={"read": 5.0},
                        items=[item("Gyoza", 6, confidence=0.9), item("Gyoza", 7), item("Mochi")])
    blurry = MenuResult(readable=False, reason="blurry", timings={"intake": 0.1})

    merged = merge_results([first, blurry, second.model_dump()])
    assert merged.readable and merged.hours == "11am - closing"
    # Gyoza at 6 is on both photos: kept once, the more confident copy.
    # Gyoza at 7 is a different entry: kept, the pipeline doesn't pick a winner.
    assert [(i.item, i.prices[0].usd if i.prices else None, i.confidence) for i in merged.items] == [
        ("Edamame", 4.0, 0.5), ("Gyoza", 6.0, 0.9), ("Gyoza", 7.0, 0.5), ("Mochi", None, 0.5)]
    assert merged.timings == {"read": 15.0, "intake": 0.1}


def test_merge_with_no_readable_photo_and_with_a_current_menu():
    blurry = MenuResult(readable=False, reason="blurry")
    assert merge_results([blurry]).reason == "blurry"
    assert merge_results([]).reason == "no_photos"

    current = [{"item": "Edamame", "category": "food", "prices": [{"size": None, "usd": 4}]},
               {"item": "Ramen", "category": "food", "prices": [{"size": None, "usd": 12}]}]
    one = MenuResult(readable=True, items=[item("Edamame", 4.5)])
    two = MenuResult(readable=True, items=[item("Ramen", 12)])
    merged = merge_results([one, two], current_menu=current)
    # Each photo alone would report the other's item as missing; the merged menu doesn't.
    assert merged.changes.missing_from_photo == []
    assert [(c.item, c.old_usd, c.new_usd) for c in merged.changes.price_changes] == [("Edamame", 4.0, 4.5)]


# ---------- confidence ----------

def test_numbers_in_text():
    amounts = numbers_in_text(["Latte $4.50", "Pizza $1599", "Syrup +.50", "Tea 3", "Soup $11:00"])
    assert {4.5, 15.99, 0.5, 3.0, 11.0} <= amounts


def test_confidence_from_a_second_read():
    items = [
        item("Cortado", 4.5),              # name and price both seen
        item("Flat White", 5.0),           # name seen, price not
        item("Unicorn Latte", 9.0),        # neither: the reader may have made it up
        item("Croissant"),                 # no price on the menu; name seen
        MenuItem(item="Latte", category="drink",
                 prices=[Price(size="Small", usd=4.0), Price(size="Large", usd=6.0)]),   # one of two prices seen
    ]
    overall = score_items(items, ["CORTADO 4.50", "Flat Whlte 4.75", "Croissant", "Latte 4.00 5.50"])
    assert [i.confidence for i in items] == [1.0, 0.7, 0.4, 1.0, 0.85]
    assert overall == round((1.0 + 0.7 + 0.4 + 1.0 + 0.85) / 5, 2)


def test_confidence_without_a_second_read():
    items = [item("Cortado", 4.5)]
    assert score_items(items, None) == 0.5 and items[0].confidence == 0.5
    assert score_items([], ["anything"]) == 0.0
