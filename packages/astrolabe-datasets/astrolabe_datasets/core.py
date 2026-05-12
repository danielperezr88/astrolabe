"""Core data structures and SQLite loaders for Astrolabe knowledge graphs.

This module defines the :class:`CodeGraph` dataclass and a family of loader
functions that read an Astrolabe-generated SQLite database and return
ready-to-use ``pandas`` DataFrames plus structured metadata.

Only three dependencies are required: **pandas**, **numpy**, and the
standard-library :mod:`sqlite3` module.
"""

from __future__ import annotations

import json
import sqlite3
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np
import pandas as pd

# ---------------------------------------------------------------------------
# Label / relationship constants
# ---------------------------------------------------------------------------

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
    "Record",
    "Delegate",
    "Annotation",
    "Template",
    "Route",
    "Tool",
    "Framework",
]
"""Canonical node labels recognised by the Astrolabe engine."""

RELATIONSHIP_TYPES: list[str] = [
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
"""Canonical directed-edge types in the Astrolabe knowledge graph."""

# ---------------------------------------------------------------------------
# Helper — safe table existence check
# ---------------------------------------------------------------------------


def _table_exists(cursor: sqlite3.Cursor, table_name: str) -> bool:
    """Return ``True`` when *table_name* exists in the connected database."""
    cursor.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name=?",
        (table_name,),
    )
    return cursor.fetchone() is not None


# ---------------------------------------------------------------------------
# Core data structure
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class CodeGraph:
    """In-memory representation of a single Astrolabe knowledge graph.

    Attributes
    ----------
    nodes:
        DataFrame with one row per graph node.  The ``properties`` JSON column
        from the SQLite ``nodes`` table is expanded into individual columns
        (``name``, ``filePath``, ``startLine``, …).
    edges:
        DataFrame with one row per directed relationship.
    embeddings:
        DataFrame with one row per embedded node.  The ``vector`` BLOB is
        decoded into a NumPy ``float32`` array stored in the ``vector`` column.
    metrics:
        DataFrame with one row per node metric entry (may be empty when the
        source database has no ``metrics`` table).
    health:
        Health-check dictionary extracted from the ``meta`` table (key
        ``"health"``).  Empty dict when absent.
    graphlets:
        Graphlet summary extracted from the ``meta`` table (key
        ``"graphlets"``).  Empty dict when absent.
    metadata:
        Catch-all dict with remaining ``meta`` key/value pairs (excludes
        ``"health"`` and ``"graphlets"``).
    """

    nodes: pd.DataFrame
    edges: pd.DataFrame
    embeddings: pd.DataFrame
    metrics: pd.DataFrame
    health: dict[str, object] = field(default_factory=dict)
    graphlets: dict[str, object] = field(default_factory=dict)
    metadata: dict[str, object] = field(default_factory=dict)


# ---------------------------------------------------------------------------
# Internal table loaders
# ---------------------------------------------------------------------------

_PROPERTY_COLUMNS: list[str] = [
    "name",
    "filePath",
    "startLine",
    "endLine",
    "language",
    "isExported",
    "visibility",
    "parameterCount",
    "level",
    "returnType",
    "isStatic",
    "isReadonly",
    "isAbstract",
    "isAsync",
    "keywords",
    "description",
    "heuristicLabel",
    "cohesion",
    "symbolCount",
]
"""Columns expected inside the ``properties`` JSON blob of the ``nodes`` table."""


def _load_nodes(cursor: sqlite3.Cursor) -> pd.DataFrame:
    """Load the ``nodes`` table, expanding its ``properties`` JSON column.

    Returns an empty DataFrame with the expected columns when the table does
    not exist.
    """
    if not _table_exists(cursor, "nodes"):
        cols = ["id", "label"] + _PROPERTY_COLUMNS
        return pd.DataFrame(columns=cols)

    cursor.execute("SELECT id, label, properties FROM nodes")
    rows: list[tuple[str, str, dict[str, object]]] = []
    for node_id, label, raw_props in cursor.fetchall():
        props: dict[str, object] = json.loads(raw_props) if raw_props else {}
        rows.append((node_id, label, props))

    if not rows:
        cols = ["id", "label"] + _PROPERTY_COLUMNS
        return pd.DataFrame(columns=cols)

    df = pd.DataFrame(rows, columns=["id", "label", "properties"])
    props_df = pd.json_normalize(df["properties"]).reindex(
        columns=_PROPERTY_COLUMNS
    )
    df = pd.concat(
        [df.drop(columns=["properties"]), props_df],
        axis=1,
    )
    return df


def _load_edges(cursor: sqlite3.Cursor) -> pd.DataFrame:
    """Load the ``relationships`` table as a DataFrame."""
    if not _table_exists(cursor, "relationships"):
        return pd.DataFrame(
            columns=[
                "id",
                "source_id",
                "target_id",
                "type",
                "confidence",
                "reason",
                "step",
                "evidence",
            ]
        )

    cursor.execute(
        "SELECT id, source_id, target_id, type, confidence, reason, step, evidence "
        "FROM relationships"
    )
    records = cursor.fetchall()
    if not records:
        return pd.DataFrame(
            columns=[
                "id",
                "source_id",
                "target_id",
                "type",
                "confidence",
                "reason",
                "step",
                "evidence",
            ]
        )

    df = pd.DataFrame(
        records,
        columns=[
            "id",
            "source_id",
            "target_id",
            "type",
            "confidence",
            "reason",
            "step",
            "evidence",
        ],
    )
    return df


def _load_embeddings(cursor: sqlite3.Cursor) -> pd.DataFrame:
    """Load the ``embeddings`` table, decoding BLOB vectors to float32 arrays."""
    if not _table_exists(cursor, "embeddings"):
        return pd.DataFrame(
            columns=["node_id", "hash", "vector", "dims", "indexed_at"]
        )

    cursor.execute(
        "SELECT node_id, hash, vector, dims, indexed_at FROM embeddings"
    )
    rows = cursor.fetchall()
    if not rows:
        return pd.DataFrame(
            columns=["node_id", "hash", "vector", "dims", "indexed_at"]
        )

    decoded: list[tuple[str, str, np.ndarray, int, int]] = []
    for node_id, hash_val, blob, dims, indexed_at in rows:
        vec = np.frombuffer(blob, dtype=np.float32) if blob else np.array([], dtype=np.float32)
        decoded.append((node_id, hash_val, vec, dims, indexed_at))

    df = pd.DataFrame(
        decoded,
        columns=["node_id", "hash", "vector", "dims", "indexed_at"],
    )
    return df


def _load_metrics(cursor: sqlite3.Cursor) -> pd.DataFrame:
    """Load the ``metrics`` table (optional — may not exist)."""
    if not _table_exists(cursor, "metrics"):
        return pd.DataFrame()

    cursor.execute("SELECT * FROM metrics")
    rows = cursor.fetchall()
    if not rows:
        return pd.DataFrame()

    col_names = [desc[0] for desc in cursor.description]
    return pd.DataFrame(rows, columns=col_names)


def _load_meta(cursor: sqlite3.Cursor) -> dict[str, object]:
    """Load the ``meta`` table into a plain dict."""
    if not _table_exists(cursor, "meta"):
        return {}

    cursor.execute("SELECT key, value FROM meta")
    raw: dict[str, str] = dict(cursor.fetchall())

    parsed: dict[str, object] = {}
    for key, value in raw.items():
        try:
            parsed[key] = json.loads(value)
        except (json.JSONDecodeError, TypeError):
            parsed[key] = value
    return parsed


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def _open_connection(db_path: str | Path) -> sqlite3.Connection:
    """Open a SQLite connection with WAL journal mode.

    Parameters
    ----------
    db_path:
        Path to the ``.db`` file.

    Returns
    -------
    sqlite3.Connection
        An open connection with ``PRAGMA journal_mode`` set to ``WAL``.
    """
    path = Path(db_path).resolve()
    conn = sqlite3.connect(str(path))
    conn.execute("PRAGMA journal_mode=WAL")
    return conn


def load_graph(db_path: str | Path) -> CodeGraph:
    """Load a single Astrolabe SQLite database into a :class:`CodeGraph`.

    Missing tables are handled gracefully — the corresponding DataFrame will
    be empty (or the dict empty for health/graphlets/metadata).

    Parameters
    ----------
    db_path:
        Filesystem path to the ``.db`` file produced by ``astrolabe analyze``.

    Returns
    -------
    CodeGraph
        A fully-populated graph data object.

    Raises
    ------
    FileNotFoundError
        When *db_path* does not point to an existing file.
    sqlite3.OperationalError
        When the file is not a valid SQLite database.
    """
    path = Path(db_path)
    if not path.exists():
        raise FileNotFoundError(f"Database not found: {path}")

    conn = _open_connection(path)
    try:
        cursor = conn.cursor()

        nodes = _load_nodes(cursor)
        edges = _load_edges(cursor)
        embeddings = _load_embeddings(cursor)
        metrics = _load_metrics(cursor)

        meta = _load_meta(cursor)
        health: dict[str, object] = meta.pop("health", {}) or {}
        graphlets: dict[str, object] = meta.pop("graphlets", {}) or {}

        return CodeGraph(
            nodes=nodes,
            edges=edges,
            embeddings=embeddings,
            metrics=metrics,
            health=health,
            graphlets=graphlets,
            metadata=meta,
        )
    finally:
        conn.close()


def load_graphs(db_paths: list[str | Path]) -> list[CodeGraph]:
    """Load multiple Astrolabe SQLite databases into a list of :class:`CodeGraph` objects.

    Each path is loaded independently; a failure on one path will **not**
    prevent the remaining paths from being loaded.  Paths that raise an
    exception are silently skipped — callers should verify the returned list
    length if strictness is required.

    Parameters
    ----------
    db_paths:
        Iterable of filesystem paths to ``.db`` files.

    Returns
    -------
    list[CodeGraph]
        One :class:`CodeGraph` per successfully loaded database, preserving
        the input order.
    """
    graphs: list[CodeGraph] = []
    for path in db_paths:
        try:
            graphs.append(load_graph(path))
        except (FileNotFoundError, sqlite3.OperationalError):
            continue
    return graphs


def list_available_graphs(db_path: str | Path) -> dict[str, object]:
    """Return metadata about a graph database without loading full DataFrames.

    This is a lightweight inspection function that reads only the ``meta``
    table and counts rows in the main tables, making it suitable for
    cataloguing large collections of databases.

    Parameters
    ----------
    db_path:
        Filesystem path to the ``.db`` file.

    Returns
    -------
    dict[str, object]
        A dictionary with the following keys:

        - ``"meta"`` — all key/value pairs from the ``meta`` table.
        - ``"tables"`` — mapping of table name → row count for every
          user table found in the database.
        - ``"path"`` — resolved absolute path of the database file.

    Raises
    ------
    FileNotFoundError
        When *db_path* does not point to an existing file.
    """
    path = Path(db_path)
    if not path.exists():
        raise FileNotFoundError(f"Database not found: {path}")

    conn = _open_connection(path)
    try:
        cursor = conn.cursor()

        # Table row counts
        cursor.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
        )
        table_names = [row[0] for row in cursor.fetchall()]
        tables: dict[str, int] = {}
        for tbl in table_names:
            try:
                cursor.execute(f'SELECT COUNT(*) FROM "{tbl}"')
                tables[tbl] = cursor.fetchone()[0]
            except sqlite3.OperationalError:
                tables[tbl] = 0

        meta = _load_meta(cursor)

        return {
            "meta": meta,
            "tables": tables,
            "path": str(path.resolve()),
        }
    finally:
        conn.close()
