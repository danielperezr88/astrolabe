"""Tests for astrolabe_datasets — shared fixtures and test utilities."""

from __future__ import annotations

import json
import sqlite3
import tempfile
from pathlib import Path
from typing import Generator

import numpy as np
import pandas as pd
import pytest


# ---------------------------------------------------------------------------
# Constants matching the real Astrolabe schema
# ---------------------------------------------------------------------------

NODE_LABELS = [
    "Project", "Package", "Module", "Folder", "File", "Section",
    "Class", "Function", "Method", "Variable", "Interface", "Enum",
    "Decorator", "Import", "Type", "CodeElement", "Struct", "Constructor",
    "Community", "Process",
    "Macro", "Typedef", "Union", "Namespace", "Trait", "Impl",
    "TypeAlias", "Const", "Static", "Property",
    "Record", "Delegate", "Annotation", "Template", "Route", "Tool", "Framework",
]

EDGE_TYPES = [
    "CONTAINS", "CALLS", "EXTENDS", "METHOD_OVERRIDES", "METHOD_IMPLEMENTS",
    "IMPORTS", "USES", "DEFINES", "DECORATES", "IMPLEMENTS",
    "HAS_METHOD", "HAS_PROPERTY", "ACCESSES", "MEMBER_OF",
    "STEP_IN_PROCESS", "HANDLES_ROUTE", "FETCHES", "HANDLES_TOOL",
    "ENTRY_POINT_OF", "WRAPS", "QUERIES", "USES_FRAMEWORK",
    "RETURNS_TYPE", "DECLARES_TYPE", "CHAINABLE_TO",
]


# ---------------------------------------------------------------------------
# Fixture: synthetic SQLite database
# ---------------------------------------------------------------------------

@pytest.fixture
def sample_db(tmp_path: Path) -> Path:
    """Create a minimal Astrolabe SQLite database with test data."""
    db_path = tmp_path / "test_graph.db"
    conn = sqlite3.connect(str(db_path))
    conn.execute("PRAGMA journal_mode = WAL")

    # -- nodes --
    conn.execute("""
        CREATE TABLE IF NOT EXISTS nodes (
            id         TEXT PRIMARY KEY,
            label      TEXT NOT NULL,
            properties TEXT NOT NULL DEFAULT '{}'
        )
    """)
    nodes = [
        ("src/index.ts:AuthService", "Class", json.dumps({
            "name": "AuthService", "filePath": "src/index.ts",
            "startLine": 10, "endLine": 50, "language": "typescript",
            "isExported": True, "visibility": "public",
            "parameterCount": 0, "level": 0, "isStatic": False, "isAsync": False,
        })),
        ("src/index.ts:authenticate", "Method", json.dumps({
            "name": "authenticate", "filePath": "src/index.ts",
            "startLine": 15, "endLine": 30, "language": "typescript",
            "isExported": False, "visibility": "public",
            "parameterCount": 2, "level": 1, "isStatic": False, "isAsync": True,
            "returnType": "Promise<boolean>",
        })),
        ("src/index.ts:login", "Function", json.dumps({
            "name": "login", "filePath": "src/index.ts",
            "startLine": 55, "endLine": 70, "language": "typescript",
            "isExported": True, "visibility": "public",
            "parameterCount": 1, "level": 0, "isStatic": False, "isAsync": True,
        })),
        ("src/utils.ts:hashPassword", "Function", json.dumps({
            "name": "hashPassword", "filePath": "src/utils.ts",
            "startLine": 5, "endLine": 15, "language": "typescript",
            "isExported": True, "visibility": "public",
            "parameterCount": 1, "level": 0, "isStatic": False, "isAsync": False,
        })),
    ]
    conn.executemany("INSERT INTO nodes (id, label, properties) VALUES (?, ?, ?)", nodes)

    # -- relationships --
    conn.execute("""
        CREATE TABLE IF NOT EXISTS relationships (
            id          TEXT   PRIMARY KEY,
            source_id   TEXT   NOT NULL,
            target_id   TEXT   NOT NULL,
            type        TEXT   NOT NULL,
            confidence  REAL   NOT NULL DEFAULT 1.0,
            reason      TEXT   NOT NULL DEFAULT '',
            step        INTEGER,
            evidence    TEXT
        )
    """)
    conn.execute("CREATE INDEX IF NOT EXISTS idx_rel_source ON relationships(source_id)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_rel_target ON relationships(target_id)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_rel_type   ON relationships(type)")

    edges = [
        ("src/index.ts:AuthService-HAS_METHOD-src/index.ts:authenticate",
         "src/index.ts:AuthService", "src/index.ts:authenticate", "HAS_METHOD",
         0.95, "Class defines method", None, None),
        ("src/index.ts:login-CALLS-src/index.ts:authenticate",
         "src/index.ts:login", "src/index.ts:authenticate", "CALLS",
         0.9, "Direct call", None, json.dumps([{"kind": "ast-parser", "weight": 0.9}])),
        ("src/index.ts:authenticate-CALLS-src/utils.ts:hashPassword",
         "src/index.ts:authenticate", "src/utils.ts:hashPassword", "CALLS",
         0.85, "Calls utility", None, None),
        ("src/index.ts:AuthService-CONTAINS-src/index.ts:authenticate",
         "src/index.ts:AuthService", "src/index.ts:authenticate", "CONTAINS",
         1.0, "Structural containment", None, None),
    ]
    conn.executemany(
        "INSERT INTO relationships (id, source_id, target_id, type, confidence, reason, step, evidence) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        edges,
    )

    # -- embeddings --
    conn.execute("""
        CREATE TABLE IF NOT EXISTS embeddings (
            node_id    TEXT    PRIMARY KEY,
            hash       TEXT    NOT NULL,
            vector     BLOB    NOT NULL,
            dims       INTEGER NOT NULL DEFAULT 384,
            indexed_at INTEGER NOT NULL
        )
    """)
    conn.execute("CREATE INDEX IF NOT EXISTS idx_embeddings_hash ON embeddings(hash)")

    dims = 384
    rng = np.random.default_rng(42)
    for i, (nid, _, _) in enumerate(nodes):
        vec = rng.standard_normal(dims).astype(np.float32)
        conn.execute(
            "INSERT INTO embeddings (node_id, hash, vector, dims, indexed_at) VALUES (?, ?, ?, ?, ?)",
            (nid, f"sha1_{i}", vec.tobytes(), dims, 1700000000000 + i),
        )

    # -- meta --
    conn.execute("""
        CREATE TABLE IF NOT EXISTS meta (
            key   TEXT PRIMARY KEY,
            value TEXT NOT NULL
        )
    """)
    conn.execute("INSERT INTO meta (key, value) VALUES (?, ?)", ("schema_version", "1"))
    conn.execute("INSERT INTO meta (key, value) VALUES (?, ?)", (
        "health", json.dumps({"overallScore": 0.78, "cohesion": 0.82, "modularity": 0.71,
                               "complexity": 0.45, "antiPatterns": []}),
    ))
    conn.execute("INSERT INTO meta (key, value) VALUES (?, ?)", (
        "graphlets", json.dumps({"threeNode": {"motif_1": 12, "motif_2": 5},
                                  "fourNode": {"motif_1": 3}}),
    ))

    # -- file_hashes --
    conn.execute("""
        CREATE TABLE IF NOT EXISTS file_hashes (
            path       TEXT    PRIMARY KEY,
            hash       TEXT    NOT NULL,
            indexed_at INTEGER NOT NULL
        )
    """)
    conn.execute("INSERT INTO file_hashes (path, hash, indexed_at) VALUES (?, ?, ?)",
                 ("src/index.ts", "hash_idx", 1700000000000))
    conn.execute("INSERT INTO file_hashes (path, hash, indexed_at) VALUES (?, ?, ?)",
                 ("src/utils.ts", "hash_util", 1700000000001))

    # -- fts_nodes --
    conn.execute("""
        CREATE VIRTUAL TABLE IF NOT EXISTS fts_nodes USING fts5(
            node_id, label, name, filePath, keywords,
            tokenize='porter unicode61'
        )
    """)
    fts_rows = [
        ("src/index.ts:AuthService", "Class", "AuthService", "src/index.ts", "auth login"),
        ("src/index.ts:authenticate", "Method", "authenticate", "src/index.ts", "auth verify"),
        ("src/index.ts:login", "Function", "login", "src/index.ts", "login session"),
        ("src/utils.ts:hashPassword", "Function", "hashPassword", "src/utils.ts", "hash password"),
    ]
    conn.executemany("INSERT INTO fts_nodes (node_id, label, name, filePath, keywords) VALUES (?, ?, ?, ?, ?)", fts_rows)

    conn.commit()
    conn.close()
    return db_path


@pytest.fixture
def sample_nodes_df() -> pd.DataFrame:
    """Minimal nodes DataFrame matching core.py output schema."""
    return pd.DataFrame({
        "id": ["n1", "n2", "n3"],
        "label": ["Class", "Method", "Function"],
        "name": ["AuthService", "authenticate", "login"],
        "filePath": ["src/index.ts", "src/index.ts", "src/index.ts"],
        "startLine": [10, 15, 55],
        "endLine": [50, 30, 70],
        "language": ["typescript", "typescript", "typescript"],
        "isExported": [True, False, True],
        "visibility": ["public", "public", "public"],
        "parameterCount": [0, 2, 1],
        "level": [0, 1, 0],
        "isStatic": [False, False, False],
        "isAsync": [False, True, True],
    })


@pytest.fixture
def sample_edges_df() -> pd.DataFrame:
    """Minimal edges DataFrame matching core.py output schema."""
    return pd.DataFrame({
        "id": ["e1", "e2", "e3"],
        "source_id": ["n1", "n3", "n2"],
        "target_id": ["n2", "n2", "n3"],
        "type": ["HAS_METHOD", "CALLS", "CALLS"],
        "confidence": [0.95, 0.9, 0.85],
        "reason": ["Class defines method", "Direct call", "Calls utility"],
        "step": [None, None, None],
    })


@pytest.fixture
def sample_embeddings_df() -> pd.DataFrame:
    """Minimal embeddings DataFrame with vector as numpy arrays."""
    rng = np.random.default_rng(42)
    vecs = [rng.standard_normal(8).astype(np.float32) for _ in range(3)]
    return pd.DataFrame({
        "node_id": ["n1", "n2", "n3"],
        "hash": ["sha1_0", "sha1_1", "sha1_2"],
        "vector": vecs,
        "dims": [8, 8, 8],
        "indexed_at": [1700000000000, 1700000000001, 1700000000002],
    })


@pytest.fixture
def sample_metrics_df() -> pd.DataFrame:
    """Minimal metrics DataFrame."""
    return pd.DataFrame({
        "node_id": ["n1", "n2", "n3"],
        "pagerank": [0.35, 0.25, 0.40],
        "betweenness": [0.1, 0.3, 0.2],
        "community_id": [0, 0, 1],
        "cohesion": [0.8, 0.8, 0.9],
    })
