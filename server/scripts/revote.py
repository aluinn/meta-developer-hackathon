"""Redo the 3D voting for an already-labelled scan from its saved SAM masks (free: no API calls).

    python scripts/revote.py scans/<scan_id>
Then redraw the picture with scripts/make_label_image.py.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from labelling.pipeline import revote_scan  # noqa: E402

result = revote_scan(Path(sys.argv[1]))
for o in result["objects"]:
    print(f"{o['id']:10s} conf={o['confidence']:.2f} size(m)={o['size']} pos={o['position']} faces={o['face_count']}")
