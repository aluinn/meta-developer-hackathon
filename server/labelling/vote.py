"""Project 2D masks onto the 3D mesh and vote for one label per surface."""
from dataclasses import dataclass

import numpy as np
import trimesh
from scipy.sparse import coo_matrix
from scipy.sparse.csgraph import connected_components

from .render import View
from .types import Detection

MIN_VOTE = 0.3  # a face needs at least this much summed confidence for its label
MIN_VIEWS = 2  # ...from at least this many views (a surface only one view can see cannot be cross-checked, so it stays unlabelled)
MIN_FACES = 40  # ignore specks
MIN_SIZE_M = 0.15  # ignore objects whose largest side is smaller than this
MERGE_MARGIN_M = 0.05  # same-label patches whose boxes come within this of each other are one object


@dataclass
class LabelledObject:
    id: str
    label: str
    confidence: float
    bbox_min: list[float]
    bbox_max: list[float]
    face_count: int

    def to_dict(self) -> dict:
        lo, hi = np.array(self.bbox_min), np.array(self.bbox_max)
        return {
            "id": self.id,
            "label": self.label,
            "confidence": round(self.confidence, 3),
            "bbox": {"min": self.bbox_min, "max": self.bbox_max},
            "position": ((lo + hi) / 2).round(3).tolist(),
            "size": (hi - lo).round(3).tolist(),
            "face_count": self.face_count,
        }


def vote_faces(
    mesh: trimesh.Trimesh, views: list[View], detections: list[Detection], labels: list[str]
) -> tuple[np.ndarray, np.ndarray]:
    """Return (label index per face, agreement per face). Label -1 = unlabelled.

    Agreement is the share of the views that could see the face which gave it the winning label.
    """
    n_faces, n_labels = len(mesh.faces), len(labels)
    label_index = {name: i for i, name in enumerate(labels)}
    score = np.zeros((n_faces, n_labels), dtype=np.float32)
    views_with_label = np.zeros((n_faces, n_labels), dtype=np.int16)
    seen_in_views = np.zeros(n_faces, dtype=np.int16)
    by_view = {v.index: v for v in views}

    for view in views:
        seen_in_views[np.unique(view.face_id[view.face_id >= 0])] += 1

    for view in views:
        per_label_faces: dict[int, np.ndarray] = {}
        for det in (d for d in detections if d.view_index == view.index):
            j = label_index[det.prompt]
            face_ids = np.unique(by_view[view.index].face_id[det.mask])
            face_ids = face_ids[face_ids >= 0]
            score[face_ids, j] += det.confidence  # sum over instances and views
            per_label_faces[j] = np.union1d(per_label_faces.get(j, face_ids[:0]), face_ids)
        for j, face_ids in per_label_faces.items():
            views_with_label[face_ids, j] += 1  # each view counts once per label

    best = score.argmax(axis=1)
    best_score = score[np.arange(n_faces), best]
    best_views = views_with_label[np.arange(n_faces), best]
    enough_views = best_views >= MIN_VIEWS
    keep = (best_score >= MIN_VOTE) & enough_views & (seen_in_views > 0)
    agreement = np.where(seen_in_views > 0, best_views / np.maximum(seen_in_views, 1), 0.0)
    return np.where(keep, best, -1), agreement


def group_objects(
    mesh: trimesh.Trimesh, face_labels: np.ndarray, agreement: np.ndarray, labels: list[str]
) -> list[LabelledObject]:
    """Connected patches of the same label become objects, each with a metre bounding box."""
    adjacency = mesh.face_adjacency
    same = (face_labels[adjacency[:, 0]] == face_labels[adjacency[:, 1]]) & (face_labels[adjacency[:, 0]] >= 0)
    a, b = adjacency[same, 0], adjacency[same, 1]
    n = len(mesh.faces)
    graph = coo_matrix((np.ones(len(a)), (a, b)), shape=(n, n))
    _, component = connected_components(graph, directed=False)

    # 1. one patch per connected component of same-label faces
    patches: list[dict] = []
    for comp in np.unique(component[face_labels >= 0]):
        faces = np.nonzero((component == comp) & (face_labels >= 0))[0]
        points = mesh.vertices[mesh.faces[faces].ravel()]
        patches.append({"label": face_labels[faces[0]], "lo": points.min(axis=0), "hi": points.max(axis=0), "faces": len(faces), "agreement": float(agreement[faces].sum())})

    # 2. real scan meshes are patchy, so one object often shows up as several touching or overlapping patches: merge them
    merged = True
    while merged:
        merged = False
        for i in range(len(patches)):
            for j in range(i + 1, len(patches)):
                a_, b_ = patches[i], patches[j]
                if a_["label"] == b_["label"] and (a_["lo"] - MERGE_MARGIN_M <= b_["hi"]).all() and (b_["lo"] - MERGE_MARGIN_M <= a_["hi"]).all():
                    a_.update(lo=np.minimum(a_["lo"], b_["lo"]), hi=np.maximum(a_["hi"], b_["hi"]), faces=a_["faces"] + b_["faces"], agreement=a_["agreement"] + b_["agreement"])
                    del patches[j]
                    merged = True
                    break
            if merged:
                break

    objects, counters = [], {}
    for patch in sorted(patches, key=lambda p: -p["faces"]):
        if patch["faces"] < MIN_FACES or (patch["hi"] - patch["lo"]).max() < MIN_SIZE_M:
            continue
        label = labels[patch["label"]]
        counters[label] = counters.get(label, 0) + 1
        objects.append(LabelledObject(
            id=f"{label}_{counters[label]}",
            label=label,
            confidence=patch["agreement"] / patch["faces"],
            bbox_min=patch["lo"].round(3).tolist(),
            bbox_max=patch["hi"].round(3).tolist(),
            face_count=patch["faces"],
        ))
    return objects
