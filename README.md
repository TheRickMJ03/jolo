# Jolo Menu Reader

A Python tool that extracts structured information from menu images using AI and OCR.

## Features

- Extract menu items, categories, and prices from images.
- Support JPG, PNG, WebP, and HEIC formats.
- Compare menus to identify new items and price changes.
- Process multiple images of the same menu.
- Export results as structured JSON.

## Project Structure

```text
jolo-menu-reader/
├── api/
├── demo/
├── docs/
├── eval/
├── menu_reader/
├── output/
├── scripts/
├── tests/
├── config.yaml
├── requirements.txt
└── README.md
```

## Installation

Clone the repository:

```bash
git clone <repository-url>
cd jolo-menu-reader
```

Create a virtual environment:

```bash
python -m venv .venv
```

Activate it:

```bash
# Windows Git Bash
source .venv/Scripts/activate

# Linux / macOS
source .venv/bin/activate
```

Install dependencies:

```bash
pip install -r requirements.txt
```

## Usage

Extract information from a menu image:

```python
from menu_reader.pipeline import extract_menu

result = extract_menu("menu.jpg")

# Get structured results
menu_data = result.model_dump()

print(menu_data)
```

Compare a menu with an existing menu:

```python
result = extract_menu(
    "menu.jpg",
    current_menu=existing_menu
)

print(result.changes)
```

Process multiple menu images:

```python
from menu_reader.pipeline import extract_menu
from menu_reader.merge import merge_results

results = [
    extract_menu("menu1.jpg"),
    extract_menu("menu2.jpg")
]

menu = merge_results(results)
```

## Model Configuration

The project uses Qwen3.5-9B through vLLM for image processing and PP-OCRv6 for additional OCR-based confidence assessment.

Configure the model server and other settings in `config.yaml`.

A running model server is required for menu extraction.

## Testing

Run the test suite:

```bash
python -m pytest -q
```

## Documentation

Additional documentation is available in the `docs/` directory.

## Notes

- Extraction results should be reviewed before updating an existing menu.
- Missing items in a photo are not automatically considered deleted.
- Processing time depends on image complexity and server performance.
- Model credentials, private keys, and other sensitive information should never be committed to the repository.