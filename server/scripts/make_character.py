"""Generate the original game character with Muse Image and save it for the web app.

    python scripts/make_character.py

Reads the prompt from docs/character-prompt.md (the block under "## Prompt"), needs MODEL_API_KEY in .env, and writes
web/public/assets/character.png (white background removed, shrunk to 512 px for phones). The full-size image exactly as the model
returned it goes to server/scans/character_raw.png (git-ignored).
Costs about $0.01 per run. Results vary each time; run it again if you do not like the first one.
"""
import datetime
import os
import re
import sys
from pathlib import Path

from dotenv import load_dotenv
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from labelling.muse_image import ImageApiError, MODEL, generate_image, white_background_to_transparent  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]
DOC = ROOT / "docs" / "character-prompt.md"
OUT_DIR = ROOT / "web" / "public" / "assets"
RAW_DIR = ROOT / "server" / "scans"
OUT_SIZE = 512


def read_prompt() -> str:
    text = DOC.read_text()
    section = text.split("## Prompt", 1)[1]
    block = re.search(r"```\n(.*?)\n```", section, re.S)
    if not block:
        raise SystemExit("Could not find the prompt block in docs/character-prompt.md")
    return " ".join(block.group(1).split())


def main() -> None:
    load_dotenv()
    api_key = os.environ.get("MODEL_API_KEY")
    if not api_key:
        raise SystemExit("MODEL_API_KEY is not set. Copy .env.example to .env and add your key.")
    prompt = read_prompt()
    try:
        raw = generate_image(prompt, api_key)
    except ImageApiError as exc:
        raise SystemExit(str(exc))
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    RAW_DIR.mkdir(parents=True, exist_ok=True)
    raw.save(RAW_DIR / "character_raw.png")
    white_background_to_transparent(raw).resize((OUT_SIZE, OUT_SIZE), Image.LANCZOS).save(OUT_DIR / "character.png", optimize=True)
    with DOC.open("a") as f:
        f.write(f"\n- {datetime.date.today()}: generated with `{MODEL}`, {raw.width}x{raw.height} (shrunk to {OUT_SIZE}x{OUT_SIZE}), saved to `web/public/assets/character.png`.\n")
    print("wrote", OUT_DIR / "character.png", "(and the full-size raw to", RAW_DIR / "character_raw.png)" + ". LOOK AT IT before committing: check it is friendly, original and has no text.")


if __name__ == "__main__":
    main()
