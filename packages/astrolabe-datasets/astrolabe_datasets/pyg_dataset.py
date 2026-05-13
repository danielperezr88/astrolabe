"""PyTorch-Geometric InMemoryDataset with HeteroData for Astrolabe knowledge graphs.

This module provides the :class:`CodeGraphDataset` class — a PyG
``InMemoryDataset`` that loads Astrolabe SQLite databases into
``HeteroData`` objects suitable for heterogeneous GNN training — along
with utility functions for converting DataFrames to ``HeteroData``,
flattening to homogeneous ``Data``, and exporting to OGB format.

**Optional dependencies** — ``torch`` and ``torch_geometric`` are *not*
required at import time; every public function that needs them performs a
lazy import and raises a helpful ``ImportError`` if they are missing.
Install the extras with::

    pip install astrolabe-datasets[pyg]
"""

from __future__ import annotations

import json
import pickle
import sqlite3
from pathlib import Path
from typing import TYPE_CHECKING, Callable, Iterator, Optional, Sequence

import numpy as np  # type: ignore[import-untyped]
import pandas as pd  # type: ignore[import-untyped]

if TYPE_CHECKING:
    from torch_geometric.data import Data, HeteroData  # type: ignore[import-untyped]

# ---------------------------------------------------------------------------
# Schema constants — canonical node labels and edge types
# ---------------------------------------------------------------------------

NODE_LABELS: list[str] = [
    "Project", "Package", "Module", "Folder", "File", "Section", "Class",
    "Function", "Method", "Variable", "Interface", "Enum", "Decorator",
    "Import", "Type", "CodeElement", "Struct", "Constructor", "Community",
    "Process", "Macro", "Typedef", "Union", "Namespace", "Trait", "Impl",
    "TypeAlias", "Const", "Static", "Property", "Record", "Delegate",
    "Annotation", "Template", "Route", "Tool", "Framework",
]

EDGE_TYPES: list[str] = [
    "CONTAINS", "CALLS", "EXTENDS", "METHOD_OVERRIDES", "METHOD_IMPLEMENTS",
    "IMPORTS", "USES", "DEFINES", "DECORATES", "IMPLEMENTS", "HAS_METHOD",
    "HAS_PROPERTY", "ACCESSES", "MEMBER_OF", "STEP_IN_PROCESS",
    "HANDLES_ROUTE", "FETCHES", "HANDLES_TOOL", "ENTRY_POINT_OF", "WRAPS",
    "QUERIES", "USES_FRAMEWORK", "RETURNS_TYPE", "DECLARES_TYPE",
    "CHAINABLE_TO",
]

VISIBILITY_VALUES: list[str] = [
    "public", "private", "protected", "internal", "package", "unknown",
]

# Base node feature dimension (without embeddings).
# type_one_hot(37) + degree(1) + visibility_one_hot(6) + parameterCount(1)
# + is_static(1) + is_async(1) + is_exported(1)
# + pagerank(1) + betweenness(1) + community_id(1)
NODE_FEAT_DIM_BASE: int = (
    len(NODE_LABELS)
    + 1
    + len(VISIBILITY_VALUES)
    + 1
    + 1
    + 1
    + 1
    + 1
    + 1
    + 1
)
# = 37 + 1 + 6 + 1 + 1 + 1 + 1 + 1 + 1 + 1 = 51

EDGE_FEAT_DIM: int = 2  # confidence, step


# ---------------------------------------------------------------------------
# Type-encoding helpers
# ---------------------------------------------------------------------------


def _type_one_hot(label: str, labels: Sequence[str]) -> np.ndarray:
    """Return a one-hot vector of length *len(labels)* for *label*.

    If *label* is not in *labels*, every element is ``0.0``.
    """
    vec = np.zeros(len(labels), dtype=np.float32)
    try:
        vec[labels.index(label)] = 1.0
    except ValueError:
        pass  # unknown type — all zeros
    return vec


def _visibility_one_hot(visibility: object) -> np.ndarray:
    """Return a one-hot vector for a visibility string.

    Unknown or ``None`` values map to the ``"unknown"`` slot.
    """
    vec = np.zeros(len(VISIBILITY_VALUES), dtype=np.float32)
    vis_str = str(visibility).lower() if visibility is not None else "unknown"
    if vis_str in VISIBILITY_VALUES:
        idx = VISIBILITY_VALUES.index(vis_str)
    else:
        idx = VISIBILITY_VALUES.index("unknown")
    vec[idx] = 1.0
    return vec


def _deserialize_vector(raw: object) -> np.ndarray:
    """Deserialize a vector BLOB from SQLite into a float32 numpy array.

    Tries ``numpy.frombuffer`` first (``tobytes`` encoding), then falls back
    to ``pickle.loads``.  Returns an empty 0-d array if deserialization fails.
    """
    if isinstance(raw, np.ndarray):
        return raw.astype(np.float32)  # type: ignore[union-attr]
    if isinstance(raw, bytes):
        try:
            return np.frombuffer(raw, dtype=np.float32).copy()
        except (ValueError, TypeError):
            pass
        try:
            result = pickle.loads(raw)
            if isinstance(result, np.ndarray):
                return result.astype(np.float32)  # type: ignore[union-attr]
        except (pickle.UnpicklingError, TypeError, AttributeError):
            pass
    if isinstance(raw, str):
        try:
            return np.frombuffer(bytes.fromhex(raw), dtype=np.float32).copy()
        except (ValueError, TypeError):
            pass
    return np.array([], dtype=np.float32)


# ---------------------------------------------------------------------------
# DataFrame → HeteroData conversion
# ---------------------------------------------------------------------------


def graph_to_hetero_data(
    nodes_df: pd.DataFrame,
    edges_df: pd.DataFrame,
    embeddings_df: pd.DataFrame,
    metrics_df: pd.DataFrame,
    all_node_types: Sequence[str] | None = None,
    all_edge_type_triples: Sequence[tuple[str, str, str]] | None = None,
) -> "HeteroData":
    """Convert Astrolabe DataFrames into a single ``HeteroData`` object.

    Node features (per type) are assembled from: a type one-hot, degree,
    visibility one-hot, ``parameterCount``, ``isStatic``, ``isAsync``,
    ``isExported`` flags, plus computed metrics (``pagerank``,
    ``betweenness``, ``community_id``).  When an *embeddings_df* with a
    ``vector`` column is supplied, the embedding vector is concatenated to
    each node's feature row; nodes without a matching embedding receive a
    zero-padded vector of the same dimensionality.

    Edge features (per type) are: ``confidence`` and ``step`` (ordinal).

    Parameters
    ----------
    nodes_df:
        DataFrame with columns ``id, label, name, filePath, startLine,
        endLine, language, isExported, visibility, parameterCount, level,
        returnType, isStatic, isReadonly, isAbstract, isAsync, keywords``.
    edges_df:
        DataFrame with columns ``id, source_id, target_id, type,
        confidence, reason, step, evidence``.
    embeddings_df:
        DataFrame with columns ``node_id, hash, vector, dims,
        indexed_at``.  May be empty or lack the ``vector`` column.
    metrics_df:
        DataFrame with columns ``node_id, pagerank, betweenness,
        community_id, cohesion``.
    all_node_types:
        If supplied, every node type in this list is guaranteed to be
        present in the result (with empty tensors for absent types).
        Used to normalise schemas across multiple graphs.
    all_edge_type_triples:
        Same idea — ensures every ``(src, rel, dst)`` triple appears in
        the result even when the current graph has no such edges.

    Returns
    -------
    HeteroData
        A PyG heterogeneous data object.

    Raises
    ------
    ImportError
        If ``torch`` or ``torch_geometric`` is not installed.
    """
    try:
        import torch
        from torch_geometric.data import HeteroData
    except ImportError as exc:
        raise ImportError(
            "PyTorch and PyTorch-Geometric are required for "
            "graph_to_hetero_data.  Install them with: "
            "pip install torch torch-geometric"
        ) from exc

    # ------------------------------------------------------------------
    # Build fast look-ups
    # ------------------------------------------------------------------
    nid_series = nodes_df["id"].astype(str)
    label_series = nodes_df["label"].astype(str)
    node_label_map: dict[str, str] = dict(zip(nid_series, label_series))

    # Degree = in + out edge count per node
    degree_counts: dict[str, int] = {}
    for sid in edges_df["source_id"].astype(str):
        degree_counts[sid] = degree_counts.get(sid, 0) + 1
    for tid in edges_df["target_id"].astype(str):
        degree_counts[tid] = degree_counts.get(tid, 0) + 1

    # Embedding look-up: node_id → float32 vector
    embed_map: dict[str, np.ndarray] = {}
    embed_dim: int = 0
    if not embeddings_df.empty and "vector" in embeddings_df.columns:
        for _, row in embeddings_df.iterrows():
            vec = _deserialize_vector(row["vector"])
            nid = str(row["node_id"])
            if vec.size > 0:
                embed_map[nid] = vec
                if embed_dim == 0:
                    embed_dim = vec.size

    # Metrics look-up: node_id → (pagerank, betweenness, community_id)
    metrics_map: dict[str, tuple[float, float, float]] = {}
    if not metrics_df.empty:
        for _, row in metrics_df.iterrows():
            nid = str(row["node_id"])
            pr = float(row.get("pagerank", 0.0) or 0.0)
            bw = float(row.get("betweenness", 0.0) or 0.0)
            raw_cid = row.get("community_id", -1)
            cid = float(raw_cid) if pd.notna(raw_cid) and raw_cid is not None else -1.0
            metrics_map[nid] = (pr, bw, cid)

    # ------------------------------------------------------------------
    # Determine the full set of node types
    # ------------------------------------------------------------------
    if all_node_types is not None:
        effective_node_types: list[str] = list(all_node_types)
    else:
        present = set(nodes_df["label"].astype(str).unique())
        effective_node_types = list(present | set(NODE_LABELS))

    # ------------------------------------------------------------------
    # Build node features per type
    # ------------------------------------------------------------------
    hetero = HeteroData()
    node_id_to_type_idx: dict[str, tuple[str, int]] = {}

    for ntype in effective_node_types:
        mask = nodes_df["label"].astype(str) == ntype
        type_nodes = nodes_df.loc[mask]
        n = len(type_nodes)

        if n == 0:
            hetero[ntype].x = torch.zeros(
                (0, NODE_FEAT_DIM_BASE + embed_dim), dtype=torch.float,
            )
            hetero[ntype].num_nodes = 0
            continue

        feat_rows: list[np.ndarray] = []
        for idx, (local_idx, (_, node)) in enumerate(type_nodes.iterrows()):
            nid = str(node["id"])
            node_id_to_type_idx[nid] = (ntype, idx)

            type_enc = _type_one_hot(ntype, NODE_LABELS)
            deg = np.array(
                [float(degree_counts.get(nid, 0))], dtype=np.float32,
            )
            vis_enc = _visibility_one_hot(node.get("visibility"))
            param_count = np.array(
                [
                    float(
                        node.get("parameterCount", 0)
                        if pd.notna(node.get("parameterCount"))
                        else 0
                    )
                ],
                dtype=np.float32,
            )
            is_static = np.array(
                [float(bool(node.get("isStatic", False)))],
                dtype=np.float32,
            )
            is_async = np.array(
                [float(bool(node.get("isAsync", False)))],
                dtype=np.float32,
            )
            is_exported = np.array(
                [float(bool(node.get("isExported", False)))],
                dtype=np.float32,
            )
            pr, bw, cid_val = metrics_map.get(nid, (0.0, 0.0, -1.0))
            metrics_arr = np.array([pr, bw, cid_val], dtype=np.float32)

            emb_vec = embed_map.get(nid)
            emb_arr = (
                emb_vec
                if emb_vec is not None
                else np.zeros(embed_dim, dtype=np.float32)
            )

            feat = np.concatenate([
                type_enc, deg, vis_enc, param_count,
                is_static, is_async, is_exported,
                metrics_arr, emb_arr,
            ])
            feat_rows.append(feat)

        feat_tensor = torch.tensor(np.stack(feat_rows), dtype=torch.float)
        hetero[ntype].x = feat_tensor
        hetero[ntype].num_nodes = n

    # ------------------------------------------------------------------
    # Determine the full set of edge type triples
    # ------------------------------------------------------------------
    actual_triples: set[tuple[str, str, str]] = set()
    for _, edge in edges_df.iterrows():
        sid = str(edge["source_id"])
        tid = str(edge["target_id"])
        src_type = node_label_map.get(sid)
        dst_type = node_label_map.get(tid)
        if src_type is None or dst_type is None:
            continue
        actual_triples.add((src_type, str(edge["type"]), dst_type))

    if all_edge_type_triples is not None:
        effective_triples: set[tuple[str, str, str]] = (
            set(all_edge_type_triples) | actual_triples
        )
    else:
        effective_triples = actual_triples
    effective_triples_sorted = sorted(effective_triples)

    # ------------------------------------------------------------------
    # Build edge indices and features per triple
    # ------------------------------------------------------------------
    edges_by_triple: dict[tuple[str, str, str], list[tuple[int, int, float, float]]] = {
        t: [] for t in effective_triples_sorted
    }

    for _, edge in edges_df.iterrows():
        sid = str(edge["source_id"])
        tid = str(edge["target_id"])
        src_type = node_label_map.get(sid)
        dst_type = node_label_map.get(tid)
        if src_type is None or dst_type is None:
            continue

        src_info = node_id_to_type_idx.get(sid)
        dst_info = node_id_to_type_idx.get(tid)
        if src_info is None or dst_info is None:
            continue

        rel = str(edge["type"])
        triple = (src_type, rel, dst_type)

        raw_conf = edge.get("confidence", 1.0)
        conf = float(raw_conf) if pd.notna(raw_conf) else 1.0
        raw_step = edge.get("step", 0)
        step_val = float(raw_step) if pd.notna(raw_step) else 0.0

        edges_by_triple.setdefault(triple, []).append(
            (src_info[1], dst_info[1], conf, step_val)
        )

    for triple in effective_triples_sorted:
        src_type, rel, dst_type = triple
        entries = edges_by_triple.get(triple, [])

        if len(entries) == 0:
            hetero[src_type, rel, dst_type].edge_index = torch.zeros(
                (2, 0), dtype=torch.long,
            )
            hetero[src_type, rel, dst_type].edge_attr = torch.zeros(
                (0, EDGE_FEAT_DIM), dtype=torch.float,
            )
        else:
            src_idx = [e[0] for e in entries]
            dst_idx = [e[1] for e in entries]
            edge_feats = np.array(
                [[e[2], e[3]] for e in entries], dtype=np.float32,
            )
            hetero[src_type, rel, dst_type].edge_index = torch.tensor(
                [src_idx, dst_idx], dtype=torch.long,
            )
            hetero[src_type, rel, dst_type].edge_attr = torch.tensor(
                edge_feats, dtype=torch.float,
            )

    return hetero


# ---------------------------------------------------------------------------
# Homogeneous flattening
# ---------------------------------------------------------------------------


def to_homogeneous(hetero: "HeteroData") -> "Data":
    """Flatten a heterogeneous graph into a homogeneous ``Data`` object.

    Nodes of all types are concatenated in ``node_type`` order.  An extra
    ``node_type`` attribute (``LongTensor``) stores the type index for
    each node; ``edge_type`` stores the edge-type index for each edge.

    Node features are aligned across types: if any type has a different
    feature width the shorter vectors are zero-padded to the maximum width.
    Edge features are similarly aligned.

    Parameters
    ----------
    hetero:
        A ``HeteroData`` object as produced by :func:`graph_to_hetero_data`.

    Returns
    -------
    Data
        A homogeneous PyG ``Data`` object.

    Raises
    ------
    ImportError
        If ``torch`` or ``torch_geometric`` is not installed.
    """
    try:
        import torch
        from torch_geometric.data import Data
    except ImportError as exc:
        raise ImportError(
            "PyTorch and PyTorch-Geometric are required for "
            "to_homogeneous.  Install them with: "
            "pip install torch torch-geometric"
        ) from exc

    # Collect node features per type
    node_features: list[torch.Tensor] = []
    node_type_ids: list[torch.Tensor] = []
    node_offsets: dict[str, int] = {}
    offset = 0

    max_node_feat_dim = 0
    for ntype in hetero.node_types:
        x = hetero[ntype].x
        if x is not None and x.numel() > 0:
            max_node_feat_dim = max(max_node_feat_dim, x.size(1))

    max_edge_feat_dim = 0
    for rel_type in hetero.edge_types:
        ea = hetero[rel_type].edge_attr
        if ea is not None and ea.numel() > 0:
            max_edge_feat_dim = max(max_edge_feat_dim, ea.size(1))

    for i, ntype in enumerate(hetero.node_types):
        x = hetero[ntype].x
        n = hetero[ntype].num_nodes
        node_offsets[str(ntype)] = offset
        offset += n

        if x is not None and x.numel() > 0:
            # Pad to max_node_feat_dim if needed
            if x.size(1) < max_node_feat_dim:
                pad = torch.zeros(
                    x.size(0), max_node_feat_dim - x.size(1),
                    dtype=x.dtype,
                )
                x = torch.cat([x, pad], dim=1)
            node_features.append(x)
            node_type_ids.append(torch.full((n,), i, dtype=torch.long))
        elif n > 0:
            placeholder = torch.zeros(n, max_node_feat_dim, dtype=torch.float)
            node_features.append(placeholder)
            node_type_ids.append(torch.full((n,), i, dtype=torch.long))

    # Collect edge indices and features per type
    edge_indices: list[torch.Tensor] = []
    edge_features: list[torch.Tensor] = []
    edge_type_ids: list[torch.Tensor] = []
    edge_key_map: dict[str, int] = {}

    for i, rel_type in enumerate(hetero.edge_types):
        src_type, rel, dst_type = rel_type
        key = str(rel_type)
        edge_key_map[key] = i

        ei = hetero[rel_type].edge_index
        if ei is None or ei.numel() == 0:
            continue

        src_offset = node_offsets.get(str(src_type), 0)
        dst_offset = node_offsets.get(str(dst_type), 0)

        shifted = ei.clone()
        shifted[0] += src_offset
        shifted[1] += dst_offset

        edge_indices.append(shifted)
        edge_type_ids.append(
            torch.full((ei.size(1),), i, dtype=torch.long)
        )

        ea = hetero[rel_type].edge_attr
        if ea is not None and ea.numel() > 0:
            if ea.size(1) < max_edge_feat_dim:
                pad = torch.zeros(
                    ea.size(0), max_edge_feat_dim - ea.size(1),
                    dtype=ea.dtype,
                )
                ea = torch.cat([ea, pad], dim=1)
            edge_features.append(ea)
        else:
            num_edges = ei.size(1)
            edge_features.append(
                torch.zeros(num_edges, max_edge_feat_dim, dtype=torch.float)
            )

    data = Data()

    if node_features:
        data.x = torch.cat(node_features, dim=0)
        data.node_type = torch.cat(node_type_ids, dim=0)
    else:
        data.x = torch.zeros((0, max_node_feat_dim), dtype=torch.float)
        data.node_type = torch.zeros((0,), dtype=torch.long)

    if edge_indices:
        data.edge_index = torch.cat(edge_indices, dim=1)
        data.edge_type = torch.cat(edge_type_ids, dim=0)
        data.edge_attr = torch.cat(edge_features, dim=0)
    else:
        data.edge_index = torch.zeros((2, 0), dtype=torch.long)
        data.edge_type = torch.zeros((0,), dtype=torch.long)
        data.edge_attr = torch.zeros(
            (0, max(1, max_edge_feat_dim)), dtype=torch.float,
        )

    data._node_type_names = [
        str(nt) for nt in hetero.node_types
    ]
    data._edge_type_names = [
        f"{src}__{rel}__{dst}"
        for src, rel, dst in hetero.edge_types
    ]

    return data


# ---------------------------------------------------------------------------
# OGB export
# ---------------------------------------------------------------------------


def export_ogb(
    dataset: CodeGraphDataset,
    output_dir: str,
) -> None:
    """Export a :class:`CodeGraphDataset` to Open Graph Benchmark (OGB) format.

    Creates a directory structure compatible with the ``ogb`` library::

        output_dir/
        ├── dataset_meta.json
        ├── raw/
        │   ├── node-<type>.csv            (per node type)
        │   └── edge-<src>-<rel>-<dst>.csv  (per edge type)
        └── processed/
            └── data.pt

    Parameters
    ----------
    dataset:
        A fully-processed :class:`CodeGraphDataset`.
    output_dir:
        Path to the output directory (created if it does not exist).

    Raises
    ------
    ImportError
        If ``torch`` is not installed.
    """
    try:
        import torch
    except ImportError as exc:
        raise ImportError(
            "PyTorch is required for export_ogb. "
            "Install it with: pip install torch"
        ) from exc

    out = Path(output_dir)
    (out / "raw").mkdir(parents=True, exist_ok=True)
    (out / "processed").mkdir(parents=True, exist_ok=True)

    # Collect all node types and edge types across the dataset
    all_node_types: set[str] = set()
    all_edge_triples: set[tuple[str, str, str]] = set()
    for data in dataset:  # type: ignore[union-attr]
        all_node_types.update(data.node_types)  # type: ignore[union-attr]
        all_edge_triples.update(data.edge_types)  # type: ignore[union-attr]

    meta = {
        "dataset_name": "astrolabe-codegraph",
        "num_node_types": len(all_node_types),
        "node_types": sorted(all_node_types),
        "num_edge_types": len(all_edge_triples),
        "edge_types": [
            f"{s}__{r}__{d}" for s, r, d in sorted(all_edge_triples)
        ],
        "num_graphs": len(dataset),
        "node_feat_dim": NODE_FEAT_DIM_BASE,
        "edge_feat_dim": EDGE_FEAT_DIM,
    }

    with open(out / "dataset_meta.json", "w", encoding="utf-8") as f:
        json.dump(meta, f, indent=2)

    # Per-graph raw CSVs
    for graph_idx, data in enumerate(dataset):  # type: ignore[union-attr]
        ntype_name_map: dict[str, dict[int, str]] = {}

        for ntype in data.node_types:  # type: ignore[union-attr]
            x = data[ntype].x  # type: ignore[index]
            n = data[ntype].num_nodes  # type: ignore[index]
            feat_cols = {f"feat_{j}": [] for j in range(x.size(1) if x is not None and x.numel() > 0 else 0)}
            feat_cols["node_idx"] = list(range(n))

            if x is not None and x.numel() > 0:
                x_np = x.cpu().numpy()
                for j in range(x_np.shape[1]):
                    feat_cols[f"feat_{j}"] = x_np[:, j].tolist()

            df = pd.DataFrame(feat_cols)
            safe_ntype = ntype.replace(" ", "_")
            df.to_csv(
                out / "raw" / f"node-{safe_ntype}_graph{graph_idx}.csv",
                index=False,
            )

        for rel_type in data.edge_types:  # type: ignore[union-attr]
            src_type, rel, dst_type = rel_type
            ei = data[rel_type].edge_index  # type: ignore[index]
            ea = data[rel_type].edge_attr  # type: ignore[index]

            edge_dict: dict[str, list[int | float]] = {
                "src_idx": ei[0].cpu().tolist() if ei is not None and ei.numel() > 0 else [],
                "dst_idx": ei[1].cpu().tolist() if ei is not None and ei.numel() > 0 else [],
            }
            if ea is not None and ea.numel() > 0:
                ea_np = ea.cpu().numpy()
                for j in range(ea_np.shape[1]):
                    edge_dict[f"edge_feat_{j}"] = ea_np[:, j].tolist()

            df = pd.DataFrame(edge_dict)
            safe_key = f"{src_type.replace(' ', '_')}__{rel}__{dst_type.replace(' ', '_')}"
            df.to_csv(
                out / "raw" / f"edge-{safe_key}_graph{graph_idx}.csv",
                index=False,
            )

    # Save processed data
    data_list = list(dataset)  # type: ignore[arg-type]
    torch.save(data_list, out / "processed" / "data.pt")


# ---------------------------------------------------------------------------
# CodeGraphDataset
# ---------------------------------------------------------------------------


class CodeGraphDataset:
    """PyTorch-Geometric ``InMemoryDataset`` for Astrolabe knowledge graphs.

    Each SQLite database in the ``raw/`` directory represents one graph.
    The :meth:`process` method loads every ``.db`` file, converts it into a
    ``HeteroData`` object with a *uniform* node/edge type schema (empty
    tensors for types that are absent in a particular graph), and saves the
    resulting list to ``processed/data.pt``.

    Parameters
    ----------
    root:
        Root directory where ``raw/`` and ``processed/`` sub-directories
        live.
    transform:
        A function/transform that takes in a ``HeteroData`` object and
        returns a transformed version.  Applied every time a graph is
        accessed.
    pre_transform:
        A function/transform that takes in a ``HeteroData`` object and
        returns a transformed version.  Applied once during
        :meth:`process`, before saving.
    pre_filter:
        A function that takes in a ``HeteroData`` object and returns
        ``True`` if the graph should be kept.  Applied once during
        :meth:`process`, before saving.

    Raises
    ------
    ImportError
        On instantiation if ``torch`` or ``torch_geometric`` is not
        installed.
    """

    def __init__(
        self,
        root: str | Path,
        transform: Callable | None = None,
        pre_transform: Callable | None = None,
        pre_filter: Callable | None = None,
    ) -> None:
        try:
            import torch  # noqa: F401
            from torch_geometric.data import HeteroData  # noqa: F401
        except ImportError as exc:
            raise ImportError(
                "PyTorch and PyTorch-Geometric are required for "
                "CodeGraphDataset.  Install them with: "
                "pip install torch torch-geometric"
            ) from exc

        self._root = Path(root)
        self._transform = transform
        self._pre_transform = pre_transform
        self._pre_filter = pre_filter
        self._data_list: list | None = None

        # Ensure directories exist
        (self._root / "raw").mkdir(parents=True, exist_ok=True)
        (self._root / "processed").mkdir(parents=True, exist_ok=True)

        # If processed data doesn't exist, process raw data
        processed_path = self._root / "processed" / "data.pt"
        if not processed_path.exists():
            self.process()

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    @property
    def raw_file_names(self) -> list[str]:
        """List of ``.db`` files in the ``raw/`` directory."""
        raw_dir = self._root / "raw"
        if not raw_dir.exists():
            return []
        return sorted(f.name for f in raw_dir.iterdir() if f.suffix == ".db")

    @property
    def processed_file_names(self) -> list[str]:
        """List of processed file names (single ``data.pt``)."""
        return ["data.pt"]

    @property
    def raw_paths(self) -> list[Path]:
        """Full paths to ``.db`` files in ``raw/``."""
        raw_dir = self._root / "raw"
        if not raw_dir.exists():
            return []
        return sorted(raw_dir.glob("*.db"))

    @property
    def num_graphs(self) -> int:
        """Number of graphs in the dataset."""
        return len(self)

    def len(self) -> int:
        """Number of graphs in the dataset."""
        if self._data_list is None:
            self._load()
        assert self._data_list is not None  # guaranteed after _load()
        return len(self._data_list)

    def __len__(self) -> int:
        return self.len()

    def __getitem__(self, idx: int) -> HeteroData:
        """Return the ``HeteroData`` at *idx*, with ``transform`` applied."""
        import torch  # noqa: F401

        if self._data_list is None:
            self._load()

        assert self._data_list is not None  # guaranteed after _load()
        data = self._data_list[idx]

        if self._transform is not None:
            data = self._transform(data)

        return data

    def __iter__(self) -> Iterator[HeteroData]:
        """Iterate over graphs in the dataset."""
        for i in range(len(self)):
            yield self[i]

    # ------------------------------------------------------------------
    # Processing pipeline
    # ------------------------------------------------------------------

    def process(self) -> None:
        """Load raw ``.db`` files, convert to ``HeteroData``, and save.

        Two-pass strategy:

        1. **Schema pass** — scan all databases to discover the complete
           set of node types and edge-type triples across the entire
           dataset.
        2. **Conversion pass** — convert each database into a
           ``HeteroData`` using the unified schema so that every graph
           has an identical set of node and edge types (with empty
           tensors for missing types).
        """
        import torch

        db_paths = list(self.raw_paths)
        if not db_paths:
            raise FileNotFoundError(
                f"No .db files found in {self._root / 'raw'}. "
                "Place Astrolabe SQLite databases there before processing."
            )

        # ---- Pass 1: collect schema ----
        all_node_types: set[str] = set()
        all_edge_triples: set[tuple[str, str, str]] = set()

        graph_data: list[tuple[pd.DataFrame, pd.DataFrame, pd.DataFrame, pd.DataFrame]] = []
        for db_path in db_paths:
            nodes_df, edges_df, emb_df, met_df = self._load_db(db_path)
            graph_data.append((nodes_df, edges_df, emb_df, met_df))

            all_node_types.update(nodes_df["label"].astype(str).unique().tolist())

            nid_to_label = dict(
                zip(nodes_df["id"].astype(str), nodes_df["label"].astype(str))
            )
            for _, edge in edges_df.iterrows():
                src_type = nid_to_label.get(str(edge["source_id"]))
                dst_type = nid_to_label.get(str(edge["target_id"]))
                if src_type is not None and dst_type is not None:
                    all_edge_triples.add(
                        (src_type, str(edge["type"]), dst_type)
                    )

        # Merge with canonical types
        all_node_types.update(NODE_LABELS)
        sorted_node_types = sorted(all_node_types)
        sorted_edge_triples = sorted(all_edge_triples)

        # ---- Pass 2: convert each graph ----
        data_list: list = []
        for nodes_df, edges_df, emb_df, met_df in graph_data:
            hetero = graph_to_hetero_data(
                nodes_df=nodes_df,
                edges_df=edges_df,
                embeddings_df=emb_df,
                metrics_df=met_df,
                all_node_types=sorted_node_types,
                all_edge_type_triples=sorted_edge_triples,
            )

            if self._pre_filter is not None and not self._pre_filter(hetero):
                continue

            if self._pre_transform is not None:
                hetero = self._pre_transform(hetero)

            data_list.append(hetero)

        # ---- Save ----
        processed_path = self._root / "processed" / "data.pt"
        torch.save(data_list, str(processed_path))
        self._data_list = data_list

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    def _load(self) -> None:
        """Load processed data from disk."""
        import torch

        processed_path = self._root / "processed" / "data.pt"
        if not processed_path.exists():
            self.process()
            return
        loaded = torch.load(str(processed_path), weights_only=False)
        self._data_list = loaded if isinstance(loaded, list) else []

    @staticmethod
    def _load_db(
        db_path: Path,
    ) -> tuple[pd.DataFrame, pd.DataFrame, pd.DataFrame, pd.DataFrame]:
        """Read an Astrolabe SQLite database into four DataFrames.

        Returns ``(nodes_df, edges_df, embeddings_df, metrics_df)``.
        If a table is missing the function returns an empty DataFrame for
        it rather than raising.
        """
        conn = sqlite3.connect(str(db_path))
        try:
            nodes_df = pd.read_sql("SELECT * FROM nodes", conn)
        except Exception:
            nodes_df = pd.DataFrame()
        try:
            edges_df = pd.read_sql("SELECT * FROM edges", conn)
        except Exception:
            edges_df = pd.DataFrame()
        try:
            embeddings_df = pd.read_sql("SELECT * FROM embeddings", conn)
        except Exception:
            embeddings_df = pd.DataFrame()
        try:
            metrics_df = pd.read_sql("SELECT * FROM metrics", conn)
        except Exception:
            metrics_df = pd.DataFrame()
        conn.close()
        return nodes_df, edges_df, embeddings_df, metrics_df