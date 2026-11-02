# Character image prompt

The play-mode character for Zac (Z3). `server/scripts/make_character.py` reads the prompt below, so what is written here
is exactly what gets sent to Muse Image (`muse-image-1.0`, `POST /v1/images/generations`).

**Status:** prompt written, image **not generated yet** (needs `MODEL_API_KEY`). When it is generated, the script writes
`web/public/assets/character.png` and fills in the log at the bottom of this file.

## Prompt

```
An original, friendly game character: a small round bean-shaped creature with a soft squishy body, two big glossy
friendly eyes, a tiny smile, stubby little arms and legs, and a single small leaf-shaped tuft on top of its head.
Colours: warm sunny yellow body with a soft teal belly patch and teal leaf. Simple flat 2D game-art style with clean
thick dark outlines and minimal shading. Full body, standing, facing the viewer, centred, with space around it.
Plain pure white background with no shadow, no floor and no props. No text, no letters, no logos. The design must be
completely original and must not resemble any existing character, mascot, game or brand.
```

## Why it is written this way
- **Original and simple:** a generic bean with a leaf tuft, with no references to existing characters or brands, so the licence stays clean.
- **Plain white background:** Muse Image ignores a transparent-background request, so the script removes the white that touches the image border
  (white inside the character, such as the eye highlights, is kept).
- **Front-facing, full body, centred:** easiest to use as a sprite or texture in three.js.
- **Flat style with thick outlines:** reads clearly at phone size.

## Licence note
Generated with Meta's model during the hackathon from the prompt above. Check Meta's terms for generated images before the submission
(see `THIRD_PARTY.md`). Never edit in artwork from another source without recording its licence.

## Generation log
_Not generated yet._
