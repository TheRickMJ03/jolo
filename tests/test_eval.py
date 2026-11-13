"""Sanity checks for the eval harness. They only ever touch DEV photos.

Run from the repo root:  python -m pytest -v
"""

from eval.check_data import load_ground_truth, load_splits, parse_flavors, parse_price, validate
from eval.run_eval import (check_trap, evaluate, flatten_menu_result, normalize_name,
                           normalize_size, score_photo)

THRESHOLD = 85


def row(item, size="", price=None, category="drink", flavors=None):
    return {"item": item, "size": size, "price": price, "category": category,
            "flavors": flavors or []}


def as_predictions(truth, photo_ids):
    return {
        photo_id: {"rows": [{k: r[k] for k in ("item", "size", "price", "category")}
                            for r in truth[photo_id]],
                   "valid_json": True, "seconds": None}
        for photo_id in photo_ids
    }


# ---------- the two sanity checks from the build prompt ----------

def test_ground_truth_as_predictions_scores_100_percent():
    truth = load_ground_truth()
    dev = load_splits()["dev"]
    metrics, failures = evaluate(truth, as_predictions(truth, dev), dev, THRESHOLD)

    assert failures == []
    assert metrics["overall"]["recall"] == 1.0
    assert metrics["overall"]["precision"] == 1.0
    assert metrics["overall"]["f1"] == 1.0
    assert metrics["overall"]["price_exact_match"] == 1.0
    assert metrics["overall"]["category_accuracy"] == 1.0
    assert metrics["valid_json_rate"] == 1.0
    for photo_id in dev:
        assert metrics["by_photo"][photo_id]["f1"] == 1.0, photo_id


def test_empty_predictions_score_zero_recall():
    truth = load_ground_truth()
    dev = load_splits()["dev"]
    empty = {photo_id: {"rows": [], "valid_json": True, "seconds": None} for photo_id in dev}
    metrics, failures = evaluate(truth, empty, dev, THRESHOLD)

    assert metrics["overall"]["tp"] == 0
    assert metrics["overall"]["recall"] == 0.0
    assert metrics["overall"]["f1"] == 0.0
    assert metrics["overall"]["fn"] == sum(len(truth[photo_id]) for photo_id in dev)
    assert len(failures) == metrics["overall"]["fn"]
    assert all(f["kind"] == "missing" for f in failures)


# ---------- data ----------

def test_data_has_no_errors():
    errors, _warnings = validate()
    assert errors == []


def test_parse_price():
    assert parse_price("") is None
    assert parse_price("4.5") == 4.5
    assert parse_price(" 3 ") == 3.0


def test_parse_flavors():
    assert parse_flavors("flavors: Mango/Peach Mango; CHECK faded names") == ["Mango", "Peach Mango"]
    assert parse_flavors("spelled as on menu") == []
    assert parse_flavors("CHECK - flavors Honey/Vanilla") == ["Honey", "Vanilla"]   # no colon
    assert parse_flavors("mixed smoothie up to 2 flavors") == []
    assert parse_flavors("written as +50c; many flavors") == []


# ---------- normalization ----------

def test_normalize_name():
    assert normalize_name("  Açaí   Bowl! ") == "acai bowl"
    assert normalize_name("Barbara's Croissant") == "barbaras croissant"
    assert normalize_name("Crème Brûlée") == "creme brulee"


def test_normalize_size():
    assert normalize_size("12 oz") == normalize_size("12oz") == "12oz"
    assert normalize_size("Small") == normalize_size("Sm") == normalize_size("SM") == "small"
    assert normalize_size("Extra Large") == normalize_size("XL")
    assert normalize_size("Small") != normalize_size("Large")
    assert normalize_size("PQ") == "pq"                      # unknown labels are left alone


# ---------- matching ----------

def test_latte_is_not_paired_with_iced_latte():
    # token_set_ratio scores "latte" vs "iced latte" as 100, so the tie-breakers must decide.
    truth = [row("Latte", price=3.5), row("Iced Latte", price=4.5)]
    preds = [row("Iced Latte", price=4.5), row("Latte", price=3.5)]
    result = score_photo(truth, preds, THRESHOLD)
    assert len(result["pairs"]) == 2
    for truth_row, pred_row in result["pairs"]:
        assert truth_row["item"] == pred_row["item"]


def test_same_name_twice_pairs_by_price():
    truth = [row("Cheese", price=1.0, category="modifier"), row("Cheese", price=6.5, category="food")]
    preds = [row("Cheese", price=6.5, category="food"), row("Cheese", price=1.0, category="modifier")]
    result = score_photo(truth, preds, THRESHOLD)
    assert all(t["price"] == p["price"] for t, p in result["pairs"])
    assert len(result["pairs"]) == 2


def test_empty_size_matches_a_single_size_item():
    truth = [row("Cortado", size="", price=3.0)]
    preds = [row("Cortado", size="8 oz", price=3.0)]
    assert len(score_photo(truth, preds, THRESHOLD)["pairs"]) == 1


def test_empty_size_does_not_match_a_multi_size_item():
    truth = [row("Latte", size="12oz", price=4.0), row("Latte", size="16oz", price=5.0)]
    preds = [row("Latte", size="", price=4.0)]
    result = score_photo(truth, preds, THRESHOLD)
    assert result["pairs"] == []
    assert len(result["missing"]) == 2
    assert len(result["extra"]) == 1


def test_different_sizes_do_not_match():
    truth = [row("Latte", size="Small", price=4.0), row("Latte", size="Large", price=5.0)]
    preds = [row("Latte", size="Large", price=5.0), row("Latte", size="Medium", price=4.5)]
    result = score_photo(truth, preds, THRESHOLD)
    assert len(result["pairs"]) == 1
    assert result["pairs"][0][0]["size"] == "Large"


def test_flavor_group_counts_once_with_no_false_positives():
    truth = [row("Tea", price=3.0, flavors=["Black", "Green", "Chamomile"])]
    preds = [row("Black", price=3.0), row("Green", price=3.0), row("Chamomile", price=3.0)]
    result = score_photo(truth, preds, THRESHOLD)
    assert len(result["pairs"]) == 1
    assert result["extra"] == []
    assert len(result["absorbed"]) == 2


def test_flavor_at_a_different_price_is_a_false_positive():
    truth = [row("Tea", price=3.0, flavors=["Black", "Green"])]
    preds = [row("Tea", price=3.0), row("Green", price=4.0)]
    result = score_photo(truth, preds, THRESHOLD)
    assert len(result["pairs"]) == 1
    assert len(result["extra"]) == 1


def test_price_where_ground_truth_is_empty_is_wrong():
    truth = {"p": [row("Espresso", price=None)]}
    preds = {"p": {"rows": [row("Espresso", price=2.5)], "valid_json": True, "seconds": 1.0}}
    metrics, failures = evaluate(truth, preds, ["p"], THRESHOLD)
    assert metrics["overall"]["tp"] == 1
    assert metrics["overall"]["price_exact_match"] == 0.0
    assert failures[0]["kind"] == "wrong_price"


def test_missing_prediction_counts_as_invalid_json():
    truth = {"p": [row("Espresso", price=2.5)]}
    metrics, _ = evaluate(truth, {}, ["p"], THRESHOLD)
    assert metrics["valid_json_rate"] == 0.0
    assert metrics["overall"]["recall"] == 0.0


# ---------- flattening a MenuResult ----------

def test_flatten_menu_result():
    result = {
        "readable": True,
        "items": [
            {"item": "Cortado", "category": "drink",
             "prices": [{"size": "8 oz", "usd": 4.5}, {"size": "12 oz", "usd": 5.0}],
             "add_ons": [{"name": "Oat milk", "usd": 0.75}]},
            {"item": "Croissant", "category": "food", "prices": [], "add_ons": []},
        ],
    }
    assert flatten_menu_result(result) == [
        {"item": "Cortado", "size": "8 oz", "price": 4.5, "category": "drink"},
        {"item": "Cortado", "size": "12 oz", "price": 5.0, "category": "drink"},
        {"item": "Oat milk", "size": "", "price": 0.75, "category": "modifier"},
        {"item": "Croissant", "size": "", "price": None, "category": "food"},
    ]


def test_flatten_unreadable_photo_gives_no_rows():
    assert flatten_menu_result({"readable": False, "reason": "blurry", "items": []}) == []
    assert flatten_menu_result(None) == []


# ---------- traps ----------

def test_traps():
    assert check_trap("curiosity_07a", [row("Ramen", category="food")]) == "pass"
    assert check_trap("curiosity_07a", [row("Unadon", category="food")]).startswith("FAIL")
    assert check_trap("curiosity_07a", [row("Unadon (grilled eel with rice)", category="food")]).startswith("CHECK BY EYE")
    assert check_trap("minas_03", [row("Americano", category="food")]) == "pass"
    assert check_trap("minas_03", [row("Americano", category="drink")]).startswith("FAIL")
    assert check_trap("minas_03", []).startswith("FAIL")
