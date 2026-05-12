"""Feature encoding and engineering for Astrolabe knowledge graph ML pipelines.

Provides one-hot and ordinal encodings for node types, edge types,
languages, and visibility, plus utilities to build full node/edge
feature matrices suitable for downstream graph neural networks.
"""

from __future__ import annotations

import numpy as np
import pandas as pd

__all__ = [
    "SUPPORTED_LANGUAGES",
    "NODE_LABELS",
    "EDGE_TYPES",
    "encode_node_type",
    "encode_visibility",
    "encode_language",
    "build_node_features",
    "build_edge_features",
    "degree_features",
    "normalize_features",
]


# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

SUPPORTED_LANGUAGES: list[str] = [
    "typescript",
    "javascript",
    "tsx",
    "python",
    "java",
    "go",
    "rust",
    "csharp",
    "php",
    "ruby",
    "swift",
    "c",
    "cpp",
    "dart",
    "kotlin",
    "scala",
    "html",
]
"""Programming languages recognised by the Astrolabe engine."""

NODE_LABELS: list[str] = [
    "Project",
    "Package",
    "Module",
    "Folder",
    "File",
    "Section",
    "Class",
    "Function",
    "Method",
    "Variable",
    "Interface",
    "Enum",
    "Decorator",
    "Import",
    "Type",
    "CodeElement",
    "Struct",
    "Constructor",
    "Community",
    "Process",
    "Macro",
    "Typedef",
    "Union",
    "Namespace",
    "Trait",
    "Impl",
    "TypeAlias",
    "Const",
    "Static",
    "Property",
]
"""Canonical node labels (30 classes) for one-hot encoding."""

EDGE_TYPES: list[str] = [
    "CONTAINS",
    "CALLS",
    "EXTENDS",
    "METHOD_OVERRIDES",
    "METHOD_IMPLEMENTS",
    "IMPORTS",
    "USES",
    "DEFINES",
    "DECORATES",
    "IMPLEMENTS",
    "HAS_METHOD",
    "HAS_PROPERTY",
    "ACCESSES",
    "MEMBER_OF",
    "STEP_IN_PROCESS",
    "HANDLES_ROUTE",
    "FETCHES",
    "HANDLES_TOOL",
    "ENTRY_POINT_OF",
    "WRAPS",
    "QUERIES",
    "USES_FRAMEWORK",
    "RETURNS_TYPE",
    "DECLARES_TYPE",
    "CHAINABLE_TO",
]
"""Canonical directed-edge types (25 types) for one-hot encoding."""

# Pre-computed lookup maps for fast encoding
_NODE_LABEL_INDEX: dict[str, int] = {label: idx for idx, label in enumerate(NODE_LABELS)}
_EDGE_TYPE_INDEX: dict[str, int] = {etype: idx for idx, etype in enumerate(EDGE_TYPES)}
_LANGUAGE_INDEX: dict[str, int] = {lang: idx for idx, lang in enumerate(SUPPORTED_LANGUAGES)}

_VISIBILITY_ORDINAL: dict[str, int] = {"public": 0, "protected": 1, "private": 2}


# ---------------------------------------------------------------------------
# Encoding functions
# ---------------------------------------------------------------------------


def encode_node_type(label_series: pd.Series) -> np.ndarray:
    """One-hot encode node labels into a ``(N, 30)`` float32 array.

    Unknown labels are encoded as an all-zeros vector.

    Parameters
    ----------
    label_series:
        Series of node label strings (e.g. ``"Class"``, ``"Method"``).

    Returns
    -------
    np.ndarray
        Shape ``(N, 30)`` float32 one-hot matrix.
    """
    n = len(label_series)
    out = np.zeros((n, len(NODE_LABELS)), dtype=np.float32)
    for i, label in enumerate(label_series):
        idx = _NODE_LABEL_INDEX.get(label)
        if idx is not None:
            out[i, idx] = 1.0
    return out


def encode_visibility(visibility_series: pd.Series) -> np.ndarray:
    """Ordinal-encode visibility into a ``(N,)`` int8 array.

    Mapping: ``public`` → 0, ``protected`` → 1, ``private`` → 2.
    Unrecognised or missing values default to ``0`` (public).

    Parameters
    ----------
    visibility_series:
        Series of visibility strings.

    Returns
    -------
    np.ndarray
        Shape ``(N,)`` int8 ordinal array.
    """
    return visibility_series.fillna("public").map(
        lambda v: _VISIBILITY_ORDINAL.get(v, 0)
    ).to_numpy(dtype=np.int8)


def encode_language(language_series: pd.Series) -> np.ndarray:
    """One-hot encode programming languages into a ``(N, 17)`` float32 array.

    Unknown languages are encoded as an all-zeros vector.

    Parameters
    ----------
    language_series:
        Series of language strings (e.g. ``"typescript"``, ``"python"``).

    Returns
    -------
    np.ndarray
        Shape ``(N, 17)`` float32 one-hot matrix.
    """
    n = len(language_series)
    out = np.zeros((n, len(SUPPORTED_LANGUAGES)), dtype=np.float32)
    for i, lang in enumerate(language_series):
        idx = _LANGUAGE_INDEX.get(lang)
        if idx is not None:
            out[i, idx] = 1.0
    return out


# ---------------------------------------------------------------------------
# Degree computation
# ---------------------------------------------------------------------------


def degree_features(
    nodes_df: pd.DataFrame,
    edges_df: pd.DataFrame,
) -> np.ndarray:
    """Compute in-degree, out-degree, and total degree for each node.

    Parameters
    ----------
    nodes_df:
        Nodes DataFrame with an ``id`` column.
    edges_df:
        Edges DataFrame with ``source_id`` and ``target_id`` columns.

    Returns
    -------
    np.ndarray
        Shape ``(N, 3)`` float32 array with columns
        ``[in_degree, out_degree, total_degree]``.
    """
    node_ids = nodes_df["id"].tolist()
    n = len(node_ids)
    node_id_to_idx = {nid: idx for idx, nid in enumerate(node_ids)}

    in_deg = np.zeros(n, dtype=np.float32)
    out_deg = np.zeros(n, dtype=np.float32)

    for _, row in edges_df.iterrows():
        src_idx = node_id_to_idx.get(row["source_id"])
        tgt_idx = node_id_to_idx.get(row["target_id"])
        if src_idx is not None:
            out_deg[src_idx] += 1.0
        if tgt_idx is not None:
            in_deg[tgt_idx] += 1.0

    total = in_deg + out_deg
    return np.column_stack([in_deg, out_deg, total])


# ---------------------------------------------------------------------------
# Composite feature builders
# ---------------------------------------------------------------------------


def build_node_features(
    nodes_df: pd.DataFrame,
    include_embeddings: bool = True,
    embeddings_df: pd.DataFrame | None = None,
) -> np.ndarray:
    """Build a combined node feature matrix.

    The feature vector for each node is the horizontal concatenation of:

    1. Node type one-hot encoding ``(N, 30)``
    2. Degree features ``(N, 3)``
    3. Visibility ordinal ``(N, 1)``
    4. Language one-hot encoding ``(N, 17)``
    5. Numeric scalar features ``(N, S)`` — extracted from columns
       ``parameterCount``, ``level``, ``isExported``, ``isStatic``,
       ``isReadonly``, ``isAbstract``, ``isAsync``.  Boolean columns are
       cast to ``float32``.  NaN values are filled with ``0``.
    6. Optional embedding vectors ``(N, D)`` when *include_embeddings* is
       ``True`` and *embeddings_df* is provided.

    Parameters
    ----------
    nodes_df:
        Nodes DataFrame.
    include_embeddings:
        Whether to append embedding vectors.
    embeddings_df:
        Embeddings DataFrame with ``node_id`` and ``vector`` columns.
        Ignored when *include_embeddings* is ``False``.

    Returns
    -------
    np.ndarray
        Shape ``(N, F)`` float32 feature matrix.
    """
    # 1. Type encoding
    type_enc = encode_node_type(nodes_df["label"])

    # 2. Degree features — build from empty edges if we only have nodes
    #    Caller can compute degree separately if edges are available.
    #    Here we provide a zero-filled placeholder of shape (N, 3).
    #    For a real graph, pass edges through degree_features() separately
    #    or call this after constructing edges.
    deg = np.zeros((len(nodes_df), 3), dtype=np.float32)

    # 3. Visibility
    vis = encode_visibility(nodes_df.get("visibility", pd.Series(["public"] * len(nodes_df)))).reshape(-1, 1)

    # 4. Language
    lang = encode_language(nodes_df.get("language", pd.Series([None] * len(nodes_df))))

    # 5. Numeric scalar features
    _BOOL_COLS = ["isExported", "isStatic", "isReadonly", "isAbstract", "isAsync"]
    _NUM_COLS = ["parameterCount", "level"]

    scalar_parts: list[np.ndarray] = []
    for col in _NUM_COLS:
        if col in nodes_df.columns:
            vals = nodes_df[col].fillna(0).to_numpy(dtype=np.float32)
        else:
            vals = np.zeros(len(nodes_df), dtype=np.float32)
        scalar_parts.append(vals.reshape(-1, 1))

    for col in _BOOL_COLS:
        if col in nodes_df.columns:
            vals = nodes_df[col].fillna(False).astype(float).to_numpy(dtype=np.float32)
        else:
            vals = np.zeros(len(nodes_df), dtype=np.float32)
        scalar_parts.append(vals.reshape(-1, 1))

    scalars = np.hstack(scalar_parts) if scalar_parts else np.empty((len(nodes_df), 0), dtype=np.float32)

    # Assemble non-embedding features
    parts: list[np.ndarray] = [type_enc, deg, vis, lang, scalars]

    # 6. Embeddings
    if include_embeddings and embeddings_df is not None and not embeddings_df.empty:
        emb_sorted = embeddings_df.set_index("node_id").reindex(nodes_df["id"])
        vecs = emb_sorted["vector"].tolist()

        first_valid_dim = 0
        for v in vecs:
            if isinstance(v, np.ndarray) and v.size > 0:
                first_valid_dim = v.shape[0]
                break
        if first_valid_dim == 0:
            first_valid_dim = 1

        emb_matrix_list: list[np.ndarray] = []
        for v in vecs:
            if isinstance(v, np.ndarray) and v.size > 0:
                emb_matrix_list.append(v.astype(np.float32))
            else:
                emb_matrix_list.append(np.zeros(first_valid_dim, dtype=np.float32))
        emb_matrix = np.stack(emb_matrix_list)
        parts.append(emb_matrix)

    return np.hstack(parts)


def build_edge_features(edges_df: pd.DataFrame) -> np.ndarray:
    """Build a combined edge feature matrix.

    The feature vector for each edge is the horizontal concatenation of:

    1. Confidence score ``(E, 1)``
    2. Step number ``(E, 1)``
    3. Edge type one-hot encoding ``(E, 25)``

    NaN values in *confidence* and *step* are filled with ``0``.

    Parameters
    ----------
    edges_df:
        Edges DataFrame with ``confidence``, ``step``, and ``type`` columns.

    Returns
    -------
    np.ndarray
        Shape ``(E, 27)`` float32 feature matrix.
    """
    confidence = edges_df["confidence"].fillna(0.0).to_numpy(dtype=np.float32).reshape(-1, 1)
    step = edges_df["step"].fillna(0).to_numpy(dtype=np.float32).reshape(-1, 1)

    # One-hot encode edge type
    n = len(edges_df)
    type_one_hot = np.zeros((n, len(EDGE_TYPES)), dtype=np.float32)
    for i, etype in enumerate(edges_df["type"]):
        idx = _EDGE_TYPE_INDEX.get(etype)
        if idx is not None:
            type_one_hot[i, idx] = 1.0

    return np.hstack([confidence, step, type_one_hot])


# ---------------------------------------------------------------------------
# Normalization
# ---------------------------------------------------------------------------


def normalize_features(
    features: np.ndarray,
    method: str = "standard",
) -> np.ndarray:
    """Normalize feature matrix along the feature (column) axis.

    Parameters
    ----------
    features:
        Shape ``(N, F)`` feature matrix.
    method:
        Normalization strategy.  ``"standard"`` subtracts the mean and
        divides by the standard deviation (z-score).  ``"minmax"`` scales
        each column to ``[0, 1]``.  Columns with zero variance are left
        unchanged (set to ``0``).

    Returns
    -------
    np.ndarray
        Normalized copy of *features* with the same shape and dtype.

    Raises
    ------
    ValueError
        When *method* is not ``"standard"`` or ``"minmax"``.
    """
    out = features.astype(np.float32, copy=True)

    if method == "standard":
        mean = out.mean(axis=0)
        std = out.std(axis=0)
        # Avoid division by zero on constant columns
        std[std == 0] = 1.0
        out = (out - mean) / std
    elif method == "minmax":
        col_min = out.min(axis=0)
        col_max = out.max(axis=0)
        denom = col_max - col_min
        denom[denom == 0] = 1.0
        out = (out - col_min) / denom
    else:
        raise ValueError(
            f"Unsupported normalization method: {method!r}. "
            f"Supported: 'standard', 'minmax'"
        )

    return out