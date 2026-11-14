"""Preprocessing: perspective fix, invert light-on-dark boards, CLAHE contrast, upscale.

Every step takes and returns a BGR image. Each one is switched on or off in
config.yaml under "preprocess"; preprocess() applies the enabled ones in order.
"""

import cv2
import numpy as np


# ---------- perspective ----------

def _order_corners(points):
    """Sort 4 points as: top-left, top-right, bottom-right, bottom-left."""
    points = points.astype("float32")
    total = points.sum(axis=1)
    difference = np.diff(points, axis=1).ravel()   # y - x
    return np.array([
        points[np.argmin(total)],        # top-left: smallest x + y
        points[np.argmin(difference)],   # top-right: smallest y - x
        points[np.argmax(total)],        # bottom-right: largest x + y
        points[np.argmax(difference)],   # bottom-left: largest y - x
    ], dtype="float32")


def find_board_corners(image, min_area_fraction=0.25):
    """Look for one big four-sided shape (the menu board). Returns 4 corners or None."""
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    gray = cv2.GaussianBlur(gray, (5, 5), 0)
    edges = cv2.Canny(gray, 50, 150)
    edges = cv2.dilate(edges, np.ones((5, 5), np.uint8), iterations=2)
    contours, _ = cv2.findContours(edges, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)

    image_area = image.shape[0] * image.shape[1]
    for contour in sorted(contours, key=cv2.contourArea, reverse=True)[:5]:
        if cv2.contourArea(contour) < min_area_fraction * image_area:
            break
        outline = cv2.approxPolyDP(contour, 0.02 * cv2.arcLength(contour, True), True)
        if len(outline) == 4 and cv2.isContourConvex(outline):
            return _order_corners(outline.reshape(4, 2))
    return None


def fix_perspective(image, min_area_fraction=0.25):
    """Straighten the menu board if one clear four-sided board is found.

    Returns (image, found). When nothing convincing is found the image comes
    back unchanged: a wrong warp is worse than no warp.
    """
    corners = find_board_corners(image, min_area_fraction)
    if corners is None:
        return image, False
    top_left, top_right, bottom_right, bottom_left = corners
    width = int(max(np.linalg.norm(top_right - top_left), np.linalg.norm(bottom_right - bottom_left)))
    height = int(max(np.linalg.norm(bottom_left - top_left), np.linalg.norm(bottom_right - top_right)))
    if width < 50 or height < 50:
        return image, False
    target = np.array([[0, 0], [width - 1, 0], [width - 1, height - 1], [0, height - 1]], dtype="float32")
    matrix = cv2.getPerspectiveTransform(corners, target)
    return cv2.warpPerspective(image, matrix, (width, height)), True


# ---------- light-on-dark boards ----------

def is_dark_background(image):
    """True when most of the photo is dark (chalkboards, black menu boards).

    Otsu's method splits pixels into a dark group and a light group. Text
    covers less area than background, so if the dark group is the bigger one,
    the background is dark.
    """
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    _, light_mask = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    return float(np.mean(light_mask == 0)) > 0.5


def invert(image):
    return cv2.bitwise_not(image)


# ---------- contrast ----------

def clahe_contrast(image, clip_limit=2.0, grid=8):
    """Local contrast boost (CLAHE) on brightness only, so colors don't shift."""
    lab = cv2.cvtColor(image, cv2.COLOR_BGR2LAB)
    lightness, a, b = cv2.split(lab)
    clahe = cv2.createCLAHE(clipLimit=clip_limit, tileGridSize=(grid, grid))
    return cv2.cvtColor(cv2.merge((clahe.apply(lightness), a, b)), cv2.COLOR_LAB2BGR)


# ---------- size ----------

def upscale(image, long_side_px):
    """Enlarge small photos so the longest side is long_side_px. Never shrinks."""
    longest = max(image.shape[:2])
    if longest >= long_side_px:
        return image
    scale = long_side_px / longest
    return cv2.resize(image, None, fx=scale, fy=scale, interpolation=cv2.INTER_CUBIC)


# ---------- all together ----------

def preprocess(image, settings):
    """Apply the steps enabled in config.yaml. Returns (image, info).

    info records what was actually done, e.g.
    {"perspective": False, "inverted": True, "clahe": True, "size": (1500, 2000)}
    """
    info = {"perspective": False, "inverted": False, "clahe": False}
    if settings.get("perspective"):
        image, info["perspective"] = fix_perspective(image)
    if settings.get("invert_dark") and is_dark_background(image):
        image, info["inverted"] = invert(image), True
    if settings.get("clahe"):
        image, info["clahe"] = clahe_contrast(image), True
    if settings.get("upscale_long_side_px"):
        image = upscale(image, settings["upscale_long_side_px"])
    info["size"] = (image.shape[1], image.shape[0])
    return image, info
