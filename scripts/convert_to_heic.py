from pathlib import Path
from PIL import Image
from pillow_heif import register_heif_opener

register_heif_opener()

SRC = Path("eval/originals")   # WEBP files
DST = Path("eval/photos")      # HEIC output
DST.mkdir(parents=True, exist_ok=True)

for src in sorted(SRC.glob("*.webp")):
    img = Image.open(src).convert("RGB")
    out = DST / f"{src.stem}.heic"
    img.save(out, format="HEIF", quality=90)
    print(f"{src.name} -> {out.name}")