"""Iterator-based lazy loaders for large Astrolabe SQLite databases.

Provides memory-efficient batch iterators over nodes, relationships (edges),
and embeddings stored in Astrolabe SQLite knowledge-graph databases.  Each
public function opens its own connection with WAL journaling and yields
results in configurable batch sizes so that arbitrarily large databases can
be processed without loading an entire table into memory.
"""

from __future__ import annotations

import json
import sqlite3
from pathlib import Path
from typing import Iterator

import numpy as np
import pandas as pd


def _connect(db_path: str | Path) -> sqlite3.Connection:
    """Open a SQLite connection with WAL journaling enabled."""
    con = sqlite3.connect(str(db_path))
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA journal_mode=WAL")
    return con


def _table_exists(con: sqlite3.Connection, table_name: str) -> bool:
    """Return *True* when *table_name* is present in the database."""
    row = con.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name=?",
        (table_name,),
    ).fetchone()
    return row is not None


def _rows_to_dataframe(rows: list[sqlite3.Row]) -> pd.DataFrame:
    """Convert a list of :class:`sqlite3.Row` to a :class:`~pandas.DataFrame`."""
    if not rows:
        return pd.DataFrame()
    columns = rows[0].keys()
    data = [tuple(r) for r in rows]
    return pd.DataFrame(data, columns=columns)


def iter_nodes(
    db_path: str | Path,
    batch_size: int = 10_000,
    *,
    label: str | None = None,
) -> Iterator[pd.DataFrame]:
    """Yield batches of nodes from an Astrolabe SQLite database.

    Each yielded DataFrame has columns ``id``, ``label``, and ``properties``
    (the JSON string is parsed into a Python dict per batch).

    Args:
        db_path: Path to the ``.db`` file.
        batch_size: Rows per yielded DataFrame.
        label: When given, only nodes whose ``label`` column matches are
            returned.

    Yields:
        :class:`~pandas.DataFrame` batches of node records.
    """
    con = _connect(db_path)
    try:
        if not _table_exists(con, "nodes"):
            return

        query = "SELECT * FROM nodes"
        params: tuple[str, ...] = ()
        if label is not None:
            query += " WHERE label = ?"
            params = (label,)

        cur = con.execute(query, params)
        while True:
            rows = cur.fetchmany(batch_size)
            if not rows:
                break
            df = _rows_to_dataframe(rows)
            df["properties"] = df["properties"].apply(json.loads)
            yield df
    finally:
        con.close()


def iter_edges(
    db_path: str | Path,
    batch_size: int = 10_000,
    *,
    type: str | None = None,
) -> Iterator[pd.DataFrame]:
    """Yield batches of relationships (edges) from an Astrolabe SQLite database.

    Each yielded DataFrame has columns ``id``, ``source_id``, ``target_id``,
    ``type``, ``confidence``, ``reason``, ``step``, and ``evidence``.

    Args:
        db_path: Path to the ``.db`` file.
        batch_size: Rows per yielded DataFrame.
        type: When given, only edges whose ``type`` column matches are
            returned.

    Yields:
        :class:`~pandas.DataFrame` batches of edge records.
    """
    con = _connect(db_path)
    try:
        if not _table_exists(con, "relationships"):
            return

        query = "SELECT * FROM relationships"
        params: tuple[str, ...] = ()
        if type is not None:
            query += " WHERE type = ?"
            params = (type,)

        cur = con.execute(query, params)
        while True:
            rows = cur.fetchmany(batch_size)
            if not rows:
                break
            yield _rows_to_dataframe(rows)
    finally:
        con.close()


def iter_embeddings(
    db_path: str | Path,
    batch_size: int = 1_000,
) -> Iterator[pd.DataFrame]:
    """Yield batches of embeddings with decoded float32 vectors.

    Each yielded DataFrame has columns ``node_id``, ``hash``, ``vector``
    (decoded as :class:`~numpy.ndarray` of ``float32``), ``dims``, and
    ``indexed_at``.

    Args:
        db_path: Path to the ``.db`` file.
        batch_size: Rows per yielded DataFrame.

    Yields:
        :class:`~pandas.DataFrame` batches of embedding records.
    """
    con = _connect(db_path)
    try:
        if not _table_exists(con, "embeddings"):
            return

        cur = con.execute("SELECT * FROM embeddings")
        while True:
            rows = cur.fetchmany(batch_size)
            if not rows:
                break
            df = _rows_to_dataframe(rows)
            df["vector"] = df["vector"].apply(
                lambda blob: np.frombuffer(blob, dtype=np.float32),
            )
            yield df
    finally:
        con.close()


def stream_graph(db_path: str | Path) -> Iterator[dict]:
    """Yield individual node and edge records as plain dicts.

    Nodes are streamed first, then edges.  Every record includes a
    ``_kind`` key (``"node"`` or ``"edge"``) so callers can discriminate
    between the two.

    Node records have their ``properties`` column parsed from JSON; edge
    records are returned as-is.

    Args:
        db_path: Path to the ``.db`` file.

    Yields:
        Individual graph records as :class:`dict` objects.
    """
    con = _connect(db_path)
    try:
        if _table_exists(con, "nodes"):
            cur = con.execute("SELECT * FROM nodes")
            while True:
                rows = cur.fetchmany(1_000)
                if not rows:
                    break
                for row in rows:
                    record = dict(row)
                    record["properties"] = json.loads(record["properties"])
                    record["_kind"] = "node"
                    yield record

        if _table_exists(con, "relationships"):
            cur = con.execute("SELECT * FROM relationships")
            while True:
                rows = cur.fetchmany(1_000)
                if not rows:
                    break
                for row in rows:
                    record = dict(row)
                    record["_kind"] = "edge"
                    yield record
    finally:
        con.close()
