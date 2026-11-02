"""Build world.json for an uploaded scan that A2 has already labelled (needs MODEL_API_KEY in .env).

    python scripts/make_world.py <scan_id>
    python scripts/make_world.py <scan_id> --out ../shared/real_world_01.json
"""
import argparse
import asyncio
import json
import shutil
import sys
from pathlib import Path

from dotenv import load_dotenv

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from labelling.roles import MuseSparkClient  # noqa: E402
from labelling.world import build_world  # noqa: E402
from scans import SCANS_DIR  # noqa: E402

parser = argparse.ArgumentParser()
parser.add_argument("scan_id")
parser.add_argument("--out", help="also copy world.json here (e.g. ../shared/real_world_01.json)")
args = parser.parse_args()

load_dotenv()
scan_dir = SCANS_DIR / args.scan_id
world = asyncio.run(build_world(scan_dir, MuseSparkClient()))
print(f"{len(world['objects'])} objects, spawn {world['spawn']}, goal {world['goal']}")
print("wrote", scan_dir / "world.json", "(valid against shared/world.schema.json)")
for obj_id, detail in json.loads((scan_dir / "roles_detail.json").read_text()).items():
    print(f"  {obj_id:14s} {detail['role']:10s} {detail['confidence']:.2f} [{detail['source']}] {detail['reason']}")
if args.out:
    shutil.copy(scan_dir / "world.json", args.out)
    print("copied to", args.out)
