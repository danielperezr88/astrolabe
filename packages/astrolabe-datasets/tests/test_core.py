"""Tests for astrolabe_datasets.core — CodeGraph dataclass and SQLite loader."""

from __future__ import annotations

import sqlite3
from pathlib import Path

import numpy as np
import pandas as pd
import pytest

from astrolabe_datasets.core import (
    NODE_LABELS,
    RELATIONSHIP_TYPES,
    CodeGraph,
    load_graph,
    load_graphs,
    list_available_graphs,
)


# ---------------------------------------------------------------------------
# CodeGraph dataclass
# ---------------------------------------------------------------------------

class TestCodeGraph:
    """Tests for the CodeGraph dataclass."""

    def test_construct_with_minimal_fields(self) -> None:
        nodes = pd.DataFrame({"id": ["n1"], "label": ["Class"]})
        edges = pd.DataFrame({"id": [], "source_id": [], "target_id": [], "type": []})
        embeddings = pd.DataFrame({"node_id": [], "vector": []})
        metrics = pd.DataFrame({"node_id": [], "pagerank": []})
        g = CodeGraph(
            nodes=nodes, edges=edges, embeddings=embeddings,
            metrics=metrics, health={}, graphlets={}, metadata={},
        )
        assert len(g.nodes) == 1
        assert len(g.edges) == 0

    def test_node_labels_constant(self) -> None:
        assert "Class" in NODE_LABELS
        assert "Function" in NODE_LABELS
        assert len(NODE_LABELS) >= 30

    def test_relationship_types_constant(self) -> None:
        assert "CALLS" in RELATIONSHIP_TYPES
        assert "CONTAINS" in RELATIONSHIP_TYPES
        assert len(RELATIONSHIP_TYPES) >= 25


# ---------------------------------------------------------------------------
# load_graph
# ---------------------------------------------------------------------------

class TestLoadGraph:
    """Tests for load_graph SQLite loader."""

    def test_load_from_valid_db(self, sample_db: Path) -> None:
        graph = load_graph(sample_db)
        assert isinstance(graph, CodeGraph)
        assert len(graph.nodes) == 4
        assert len(graph.edges) == 4
        assert len(graph.embeddings) == 4
        assert graph.health.get("overallScore") is not None
        assert graph.graphlets is not None

    def test_nodes_have_flattened_properties(self, sample_db: Path) -> None:
        graph = load_graph(sample_db)
        # Properties should be flattened into DataFrame columns
        assert "name" in graph.nodes.columns
        assert "filePath" in graph.nodes.columns
        assert "language" in graph.nodes.columns

    def test_embeddings_vector_decoded(self, sample_db: Path) -> None:
        graph = load_graph(sample_db)
        # Vector column should contain numpy arrays
        first_vec = graph.embeddings.iloc[0]["vector"]
        assert isinstance(first_vec, np.ndarray)
        assert first_vec.dtype == np.float32

    def test_metadata_loaded(self, sample_db: Path) -> None:
        graph = load_graph(sample_db)
        assert "schema_version" in graph.metadata

    def test_load_nonexistent_path_raises(self, tmp_path: Path) -> None:
        with pytest.raises(FileNotFoundError):
            load_graph(tmp_path / "nonexistent.db")

    def test_load_db_missing_tables(self, tmp_path: Path) -> None:
        """DB file exists but has no Astrolabe tables — should return empty DataFrames."""
        db_path = tmp_path / "empty.db"
        conn = sqlite3.connect(str(db_path))
        conn.execute("PRAGMA journal_mode = WAL")
        conn.commit()
        conn.close()
        graph = load_graph(db_path)
        assert len(graph.nodes) == 0
        assert len(graph.edges) == 0

    def test_edge_confidence_is_float(self, sample_db: Path) -> None:
        graph = load_graph(sample_db)
        assert graph.edges["confidence"].dtype in (np.float64, np.float32)


# ---------------------------------------------------------------------------
# load_graphs
# ---------------------------------------------------------------------------

class TestLoadGraphs:
    """Tests for load_graphs multi-DB loader."""

    def test_load_multiple(self, sample_db: Path) -> None:
        graphs = load_graphs([sample_db, sample_db])
        assert len(graphs) == 2
        assert all(isinstance(g, CodeGraph) for g in graphs)

    def test_load_empty_list(self) -> None:
        graphs = load_graphs([])
        assert graphs == []


# ---------------------------------------------------------------------------
# list_available_graphs
# ---------------------------------------------------------------------------

class TestListAvailableGraphs:
    """Tests for list_available_graphs metadata query."""

    def test_returns_metadata(self, sample_db: Path) -> None:
        info = list_available_graphs(sample_db)
        assert isinstance(info, dict)
        assert "node_count" in info or "nodes" in info

    def test_returns_schema_version(self, sample_db: Path) -> None:
        info = list_available_graphs(sample_db)
        # Should include metadata from the meta table
        assert "schema_version" in info or "metadata" in info
