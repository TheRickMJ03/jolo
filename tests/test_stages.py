"""Tests for intake, preprocessing and cropping, on made-up images (no photos, no models)."""

import io

import cv2
import numpy as np
from PIL import Image

from menu_reader import preprocess as pre
from menu_reader.config import load_config
from menu_reader.crop import crop_menu, union_box
from menu_reader.intake import blur_score, load_image


def image_bytes(pil_image, image_format, **save_options):
    buffer = io.BytesIO()
    pil_image.save(buffer, format=image_format, **save_options)
    return buffer.getvalue()


def text_image(background, ink, width=600, height=400):
    """A plain page with a few lines of text."""
    image = np.full((height, width, 3), background, dtype=np.uint8)
    for i, text in enumerate(["LATTE 4.50", "CORTADO 3.75", "MOCHA 5.00"]):
        cv2.putText(image, text, (40, 100 + 100 * i), cv2.FONT_HERSHEY_SIMPLEX, 1.5, (ink, ink, ink), 3)
    return image


# ---------- intake ----------

def test_load_png_from_bytes():
    result = load_image(image_bytes(Image.new("RGB", (300, 200), "white"), "PNG"))
    assert result.readable
    assert result.image.shape == (200, 300, 3)
    assert result.original_size == (300, 200)


def test_load_webp_and_heic():
    for image_format in ("WEBP", "HEIF"):
        result = load_image(image_bytes(Image.new("RGB", (320, 240), "white"), image_format))
        assert result.readable, image_format
        assert result.image.shape == (240, 320, 3), image_format


def test_load_from_path(tmp_path):
    path = tmp_path / "menu.jpg"
    Image.new("RGB", (300, 200), "white").save(path)
    assert load_image(path).image.shape == (200, 300, 3)


def test_exif_rotation_is_applied():
    # Orientation 6 means "rotate 90 degrees to view": a 300x200 file is a 200x300 photo.
    exif = Image.Exif()
    exif[0x0112] = 6
    data = image_bytes(Image.new("RGB", (300, 200), "white"), "JPEG", exif=exif)
    result = load_image(data)
    assert result.image.shape[:2] == (300, 200)   # (height, width)


def test_big_photos_are_shrunk_and_small_ones_left_alone():
    big = load_image(image_bytes(Image.new("RGB", (4000, 3000), "white"), "JPEG"), max_side_px=2000)
    assert big.image.shape[:2] == (1500, 2000)
    assert big.original_size == (4000, 3000)
    small = load_image(image_bytes(Image.new("RGB", (800, 600), "white"), "JPEG"), max_side_px=2000)
    assert small.image.shape[:2] == (600, 800)


def test_garbage_bytes_are_unreadable():
    result = load_image(b"this is not an image")
    assert not result.readable
    assert result.reason == "unreadable_file"
    assert result.image is None


def test_blurred_image_scores_lower():
    sharp = text_image(background=255, ink=0)
    blurred = cv2.GaussianBlur(sharp, (21, 21), 0)
    assert blur_score(blurred) < blur_score(sharp)


def test_blur_threshold_marks_photo_unreadable():
    data = image_bytes(Image.new("RGB", (300, 200), "gray"), "PNG")   # flat gray: score 0
    result = load_image(data, blur_threshold=10)
    assert not result.readable
    assert result.reason == "blurry"
    assert load_image(data, blur_threshold=None).readable


# ---------- preprocess ----------

def test_dark_background_detection():
    assert pre.is_dark_background(text_image(background=20, ink=240))
    assert not pre.is_dark_background(text_image(background=240, ink=20))


def test_invert_turns_dark_board_light():
    inverted = pre.invert(text_image(background=20, ink=240))
    assert not pre.is_dark_background(inverted)


def test_clahe_keeps_size_and_raises_contrast():
    faded = text_image(background=140, ink=110)
    boosted = pre.clahe_contrast(faded)
    assert boosted.shape == faded.shape
    assert boosted.std() > faded.std()


def test_upscale_only_enlarges():
    small = np.zeros((500, 400, 3), dtype=np.uint8)
    assert pre.upscale(small, 1000).shape[:2] == (1000, 800)
    assert pre.upscale(small, 300) is small


def test_perspective_finds_a_tilted_board():
    image = np.full((600, 800, 3), 30, dtype=np.uint8)
    board = np.array([[150, 100], [650, 60], [700, 520], [120, 480]], dtype=np.int32)
    cv2.fillPoly(image, [board], (230, 230, 230))
    warped, found = pre.fix_perspective(image)
    assert found
    assert warped.mean() > 200          # the result is almost all board


def test_perspective_leaves_image_alone_when_no_board():
    image = np.full((600, 800, 3), 128, dtype=np.uint8)
    warped, found = pre.fix_perspective(image)
    assert not found
    assert warped is image


def test_preprocess_follows_the_settings():
    dark = text_image(background=20, ink=240)
    same, info = pre.preprocess(dark, {})
    assert same is dark
    assert info == {"perspective": False, "inverted": False, "clahe": False, "size": (600, 400)}

    changed, info = pre.preprocess(dark, {"invert_dark": True, "clahe": True, "upscale_long_side_px": 1200})
    assert info["inverted"] and info["clahe"]
    assert info["size"] == (1200, 800)
    assert changed.shape[:2] == (800, 1200)


# ---------- crop ----------

def test_union_box_adds_margin_and_stays_inside():
    box = union_box([(100, 100, 200, 150), (300, 400, 500, 450)], 1000, 1000, margin=0.03)
    assert box == (70, 70, 530, 480)
    assert union_box([(0, 0, 1000, 1000)], 1000, 1000, margin=0.03) == (0, 0, 1000, 1000)
    assert union_box([], 1000, 1000) is None


def test_crop_mode_none_keeps_the_photo():
    config = load_config("laptop_cpu")
    config["crop"]["mode"] = "none"
    image = np.zeros((400, 600, 3), dtype=np.uint8)
    cropped, box = crop_menu(image, config)
    assert cropped is image and box is None


def test_crop_ppocr_boxes_uses_confident_lines_only():
    config = load_config("laptop_cpu")
    config["crop"].update({"mode": "ppocr_boxes", "min_text_score": 0.5, "margin": 0.0})
    image = np.zeros((400, 600, 3), dtype=np.uint8)
    lines = [
        {"text": "Latte", "score": 0.99, "box": (100, 100, 200, 130)},
        {"text": "4.50", "score": 0.95, "box": (300, 100, 350, 130)},
        {"text": "??", "score": 0.20, "box": (550, 380, 590, 395)},   # ignored
    ]
    cropped, box = crop_menu(image, config, text_lines=lines)
    assert box == (100, 100, 350, 130)
    assert cropped.shape[:2] == (30, 250)


def test_config_profiles():
    assert load_config("laptop_cpu")["profile"] == "laptop_cpu"
    assert load_config("vm")["endpoint"] == "http://localhost:8000/v1"
    assert load_config("vm")["ppocr"]["device"] == "cpu"   # inherited from common
