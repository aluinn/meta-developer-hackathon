"""Player-described characters: what we accept, and the prompt we send to Muse Image.

The player's words are only ever inserted into a FIXED template that asks for an original, friendly, text-free character, and the
description itself is limited to plain letters, numbers and a little punctuation (no quotes, colons or new lines), which keeps it from
being used to smuggle in other instructions. A short block-list stops obvious existing characters/brands and unsafe words. It is a
simple filter, not a guarantee: Muse Image itself decides what it will draw, and the rate limits in characters.py protect the credits.
"""
import re

MIN_LENGTH = 3
MAX_LENGTH = 80
ALLOWED = re.compile(r"^[A-Za-z0-9 ,.'\-!]+$")

BLOCKED_MESSAGE = "That description isn't allowed. Describe an original character (no existing characters, brands or unsafe content)."
BLOCKED = [
    # existing characters, franchises and brands
    "mario", "luigi", "pokemon", "pikachu", "sonic", "zelda", "disney", "mickey", "minnie", "frozen", "elsa", "marvel", "spider-man", "spiderman",
    "batman", "superman", "hulk", "star wars", "darth vader", "yoda", "harry potter", "hello kitty", "minecraft", "fortnite", "roblox", "spongebob",
    "peppa", "bluey", "naruto", "goku", "dragon ball", "simpsons", "nintendo", "sega", "pixar", "dreamworks", "nike", "adidas", "coca cola",
    "pepsi", "mcdonald", "mcdonalds", "logo", "brand", "trademark", "copyright",
    # unsafe content
    "nsfw", "nude", "nudity", "naked", "sex", "sexy", "sexual", "porn", "gore", "gory", "blood", "bloody", "bleeding", "kill", "killer", "killing",
    "killed", "murder", "murderer", "gun", "guns", "weapon", "weapons", "knife", "bomb", "violent", "violence", "drug", "drugs", "nazi", "hitler",
    "swastika", "terrorist", "suicide",
    # attempts to give the drawing service other instructions
    "ignore", "instruction", "instructions", "prompt", "jailbreak",
]
_BLOCKED = re.compile(r"\b(" + "|".join(re.escape(word) for word in BLOCKED) + r")\b", re.IGNORECASE)

TEMPLATE = (
    "An original, friendly game character: {description}. Simple flat 2D game-art style with clean thick dark outlines and minimal shading. "
    "Full body, standing, facing the viewer, centred, with space around it. Plain pure white background with no shadow, no floor and no props. "
    "No text, no letters, no logos. The design must be completely original and must not resemble any existing character, mascot, game or brand."
)


def clean_description(text: str) -> str:
    """The description to use, or a ValueError whose message is fit to show the player."""
    if any(ch in text for ch in "\n\r\t") or any(ord(ch) < 32 for ch in text):
        raise ValueError("Please write the description on one line, in plain words.")
    description = " ".join(text.split())
    if not MIN_LENGTH <= len(description) <= MAX_LENGTH:
        raise ValueError(f"Describe your character in {MIN_LENGTH} to {MAX_LENGTH} characters.")
    if not ALLOWED.match(description):
        raise ValueError("Please use plain letters and numbers, with only , . ' - ! as punctuation.")
    if _BLOCKED.search(description):
        raise ValueError(BLOCKED_MESSAGE)
    return description


def build_prompt(description: str) -> str:
    return TEMPLATE.format(description=description)
