"""Upload a mesh to the running server and print the result.

    python scripts/upload_test.py path/to/room.glb
    python scripts/upload_test.py --make-test-mesh      # uploads a generated sphere

Start the server first (see server/README.md).
"""
import argparse
import sys
import tempfile
from pathlib import Path

import requests
import trimesh

parser = argparse.ArgumentParser()
parser.add_argument("path", nargs="?", help="a .glb or .obj file")
parser.add_argument("--make-test-mesh", action="store_true", help="generate a ~330k triangle sphere")
parser.add_argument("--url", default="http://localhost:8000/scan")
args = parser.parse_args()

if args.make_test_mesh:
    path = Path(tempfile.mkdtemp()) / "test_sphere.glb"
    trimesh.creation.icosphere(subdivisions=7).export(path)
elif args.path:
    path = Path(args.path)
else:
    parser.error("give a file path or --make-test-mesh")

with path.open("rb") as f:
    response = requests.post(args.url, files={"file": (path.name, f)})

print(response.status_code, response.json())
sys.exit(0 if response.ok else 1)
