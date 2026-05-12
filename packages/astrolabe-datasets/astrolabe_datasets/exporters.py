"""Export functions for Astrolabe knowledge graphs to multiple formats.

Supports OGB dict format (.npz), GraphML, GML, and flat CSV exports.
Optional dependencies (networkx) are imported at function level to keep
the core installation lightweight.
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import Collection

import numpy as np
import pandas as pd

# Re-use canonical constants from core so OGB node_type / edge_type
# integers are consistent with the same label/type ordering.
from astrolabe_datasets.core import NODE_LABELS, RELATIONSHIP_TYPES

__all__ = [
    "export_ogb",
    "export_graphml",
    "export_gml",
    "export_node_csv",
    "export_edge_csv",
    "export_all",
]


# ---------------------------------------------------------------------------
# Helper — label / type → integer index
# ---------------------------------------------------------------------------

_NODE_LABEL_INDEX: dict[str, int] = {label: idx for idx, label in enumerate(NODE_LABELS)}
_EDGE_TYPE_INDEX: dict[str, int] = {rtype: idx for idx, rtype in enumerate(RELATIONSHIP_TYPES)}


# ---------------------------------------------------------------------------
# OGB export
# ---------------------------------------------------------------------------


def export_ogb(
    nodes_df: pd.DataFrame,
    edges_df: pd.DataFrame,
    embeddings_df: pd.DataFrame,
    metrics_df: pd.DataFrame,
    output_dir: str | Path,
) -> Path:
    """Export graph data to OGB dict format saved as ``.npz``.

    The resulting file contains an OGB-compatible dictionary with the
    following keys:

    - ``node_feat`` – concatenated node feature matrix ``(N, F)``
    - ``edge_feat`` – concatenated edge feature matrix ``(E, D)``
    - ``edge_index`` – 2×E int64 array of source/target indices
    - ``num_nodes`` – integer node count
    - ``node_type`` – int32 label indices per node
    - ``edge_type`` – int32 relationship type indices per edge

    Parameters
    ----------
    nodes_df:
        Nodes DataFrame (columns: id, label, …).
    edges_df:
        Edges DataFrame (columns: id, source_id, target_id, type, …).
    embeddings_df:
        Embeddings DataFrame (columns: node_id, hash, vector, dims).
    metrics_df:
        Metrics DataFrame (columns: node_id, pagerank, betweenness, …).
    output_dir:
        Directory to write the ``astrolabe_ogb.npz`` file into.

    Returns
    -------
    Path
        Path to the written ``.npz`` file.
    """
    # --- node index mapping ---------------------------------------------------
    node_ids: list[str] = nodes_df["id"].tolist()
    node_id_to_idx: dict[str, int] = {nid: idx for idx, nid in enumerate(node_ids)}

    # --- node_type ------------------------------------------------------------
    node_type = np.array(
        [_NODE_LABEL_INDEX.get(label, 0) for label in nodes_df["label"]],
        dtype=np.int32,
    )

    # --- node_feat (embeddings) -----------------------------------------------
    emb_sorted = embeddings_df.set_index("node_id").reindex(node_ids)
    vecs = emb_sorted["vector"].tolist()
    # Handle missing embeddings — replace with zero vector
    first_valid_dim: int = 0
    for v in vecs:
        if isinstance(v, np.ndarray) and v.size > 0:
            first_valid_dim = v.shape[0]
            break
    if first_valid_dim == 0:
        first_valid_dim = 1

    node_feat_list: list[np.ndarray] = []
    for v in vecs:
        if isinstance(v, np.ndarray) and v.size > 0:
            node_feat_list.append(v.astype(np.float32))
        else:
            node_feat_list.append(np.zeros(first_valid_dim, dtype=np.float32))
    node_feat = np.stack(node_feat_list) if node_feat_list else np.empty((0, 0), dtype=np.float32)

    # --- edge_index -----------------------------------------------------------
    src_indices = edges_df["source_id"].map(node_id_to_idx)
    tgt_indices = edges_df["target_id"].map(node_id_to_idx)

    # Drop edges whose endpoints are not in the node set
    valid_mask = src_indices.notna() & tgt_indices.notna()
    src_arr = src_indices[valid_mask].to_numpy(dtype=np.int64)
    tgt_arr = tgt_indices[valid_mask].to_numpy(dtype=np.int64)
    edge_index = np.vstack([src_arr, tgt_arr])

    # --- edge_type ------------------------------------------------------------
    edge_type = np.array(
        [_EDGE_TYPE_INDEX.get(t, 0) for t in edges_df.loc[valid_mask, "type"]],
        dtype=np.int32,
    )

    # --- edge_feat (confidence + step) ----------------------------------------
    confidence = edges_df.loc[valid_mask, "confidence"].fillna(0.0).to_numpy(dtype=np.float32)
    step = edges_df.loc[valid_mask, "step"].fillna(0).to_numpy(dtype=np.float32)
    # One-hot encode edge type
    type_one_hot = np.zeros((len(edge_type), len(RELATIONSHIP_TYPES)), dtype=np.float32)
    for row_idx, tidx in enumerate(edge_type):
        type_one_hot[row_idx, tidx] = 1.0
    edge_feat = np.hstack([
        confidence.reshape(-1, 1),
        step.reshape(-1, 1),
        type_one_hot,
    ])

    # --- assemble & save ------------------------------------------------------
    out_path = Path(output_dir)
    out_path.mkdir(parents=True, exist_ok=True)
    npz_path = out_path / "astrolabe_ogb.npz"

    np.savez(
        npz_path,
        node_feat=node_feat,
        edge_feat=edge_feat,
        edge_index=edge_index,
        num_nodes=np.array([len(node_ids)], dtype=np.int64),
        node_type=node_type,
        edge_type=edge_type,
    )
    return npz_path


# ---------------------------------------------------------------------------
# GraphML export
# ---------------------------------------------------------------------------


def export_graphml(
    nodes_df: pd.DataFrame,
    edges_df: pd.DataFrame,
    output_path: str | Path,
) -> Path:
    """Export graph data to GraphML format via NetworkX.

    NetworkX is imported lazily so that callers who do not need GraphML
    do not have to install it.

    Parameters
    ----------
    nodes_df:
        Nodes DataFrame (columns: id, label, …).
    edges_df:
        Edges DataFrame (columns: id, source_id, target_id, type, …).
    output_path:
        Destination file path (should end with ``.graphml``).

    Returns
    -------
    Path
        Path to the written GraphML file.

    Raises
    ------
    ImportError
        When ``networkx`` is not installed.
    """
    import networkx as nx  # noqa: PLC0415 — lazy import

    G = nx.DiGraph()

    for _, row in nodes_df.iterrows():
        attrs = {k: v for k, v in row.items() if k != "id" and pd.notna(v)}
        G.add_node(str(row["id"]), **attrs)

    for _, row in edges_df.iterrows():
        attrs = {k: v for k, v in row.items() if k not in ("id", "source_id", "target_id") and pd.notna(v)}
        G.add_edge(str(row["source_id"]), str(row["target_id"]), **attrs)

    out = Path(output_path)
    out.parent.mkdir(parents=True, exist_ok=True)
    nx.write_graphml(G, str(out))
    return out


# ---------------------------------------------------------------------------
# GML export
# ---------------------------------------------------------------------------


def export_gml(
    nodes_df: pd.DataFrame,
    edges_df: pd.DataFrame,
    output_path: str | Path,
) -> Path:
    """Export graph data to GML format via NetworkX.

    NetworkX is imported lazily so that callers who do not need GML
    do not have to install it.

    GML has limitations on attribute keys (must be valid Python
    identifiers).  Non-conforming keys are silently skipped.

    Parameters
    ----------
    nodes_df:
        Nodes DataFrame (columns: id, label, …).
    edges_df:
        Edges DataFrame (columns: id, source_id, target_id, type, …).
    output_path:
        Destination file path (should end with ``.gml``).

    Returns
    -------
    Path
        Path to the written GML file.

    Raises
    ------
    ImportError
        When ``networkx`` is not installed.
    """
    import networkx as nx  # noqa: PLC0415 — lazy import

    G = nx.DiGraph()

    for _, row in nodes_df.iterrows():
        # GML allows only simple scalar attributes; filter accordingly.
        attrs: dict[str, object] = {}
        for k, v in row.items():
            if k == "id" or pd.isna(v):
                continue
            if isinstance(v, (bool, int, float, str)):
                attrs[str(k)] = v
        G.add_node(str(row["id"]), **attrs)

    for _, row in edges_df.iterrows():
        attrs: dict[str, object] = {}  # type: ignore[no-redef]
        for k, v in row.items():
            if k in ("id", "source_id", "target_id") or pd.isna(v):
                continue
            if isinstance(v, (bool, int, float, str)):
                attrs[str(k)] = v
        G.add_edge(str(row["source_id"]), str(row["target_id"]), **attrs)

    out = Path(output_path)
    out.parent.mkdir(parents=True, exist_ok=True)
    nx.write_gml(G, str(out))
    return out


# ---------------------------------------------------------------------------
# CSV exports
# ---------------------------------------------------------------------------


def export_node_csv(
    nodes_df: pd.DataFrame,
    output_path: str | Path,
) -> Path:
    """Export node data to a CSV file.

    Parameters
    ----------
    nodes_df:
        Nodes DataFrame.
    output_path:
        Destination file path (should end with ``.csv``).

    Returns
    -------
    Path
        Path to the written CSV file.
    """
    out = Path(output_path)
    out.parent.mkdir(parents=True, exist_ok=True)
    nodes_df.to_csv(out, index=False)
    return out


def export_edge_csv(
    edges_df: pd.DataFrame,
    output_path: str | Path,
) -> Path:
    """Export edge data to a CSV file.

    Parameters
    ----------
    edges_df:
        Edges DataFrame.
    output_path:
        Destination file path (should end with ``.csv``).

    Returns
    -------
    Path
        Path to the written CSV file.
    """
    out = Path(output_path)
    out.parent.mkdir(parents=True, exist_ok=True)
    edges_df.to_csv(out, index=False)
    return out


# ---------------------------------------------------------------------------
# Multi-format export
# ---------------------------------------------------------------------------

_DEFAULT_FORMATS: tuple[str, ...] = ("ogb", "graphml", "gml", "node_csv", "edge_csv")


def export_all(
    nodes_df: pd.DataFrame,
    edges_df: pd.DataFrame,
    embeddings_df: pd.DataFrame,
    metrics_df: pd.DataFrame,
    output_dir: str | Path,
    formats: Collection[str] | None = None,
) -> dict[str, Path]:
    """Export graph data to multiple formats in a single call.

    Parameters
    ----------
    nodes_df:
        Nodes DataFrame.
    edges_df:
        Edges DataFrame.
    embeddings_df:
        Embeddings DataFrame.
    metrics_df:
        Metrics DataFrame.
    output_dir:
        Directory to write all output files into.
    formats:
        Iterable of format names to export.  Supported values are
        ``"ogb"``, ``"graphml"``, ``"gml"``, ``"node_csv"``, and
        ``"edge_csv"``.  Defaults to all five.

    Returns
    -------
    dict[str, Path]
        Mapping from format name to the written file path.

    Raises
    ------
    ImportError
        When ``networkx`` is required but not installed (GraphML / GML).
    ValueError
        When an unsupported format name is requested.
    """
    out = Path(output_dir)
    out.mkdir(parents=True, exist_ok=True)

    if formats is None:
        formats = _DEFAULT_FORMATS

    results: dict[str, Path] = {}
    for fmt in formats:
        if fmt == "ogb":
            results[fmt] = export_ogb(nodes_df, edges_df, embeddings_df, metrics_df, out)
        elif fmt == "graphml":
            results[fmt] = export_graphml(nodes_df, edges_df, out / "astrolabe.graphml")
        elif fmt == "gml":
            results[fmt] = export_gml(nodes_df, edges_df, out / "astrolabe.gml")
        elif fmt == "node_csv":
            results[fmt] = export_node_csv(nodes_df, out / "nodes.csv")
        elif fmt == "edge_csv":
            results[fmt] = export_edge_csv(edges_df, out / "edges.csv")
        else:
            raise ValueError(
                f"Unsupported export format: {fmt!r}. "
                f"Supported: {', '.join(_DEFAULT_FORMATS)}"
            )
    return results