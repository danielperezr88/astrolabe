"""Tests for astrolabe_datasets.lazy — Iterator-based lazy loaders."""

from __future__ import annotations

from pathlib import Path

import pandas as pd
import pytest

from astrolabe_datasets.lazy import iter_nodes, iter_edges, iter_embeddings, stream_graph


class TestIterNodes:
    """Tests for iter_nodes batched node loader."""

    def test_yields_all_nodes(self, sample_db: Path) -> None:
        batches = list(iter_nodes(sample_db, batch_size=2))
        total = sum(len(b) for b in batches)
        assert total == 4  # 4 nodes in fixture

    def test_batch_size_respected(self, sample_db: Path) -> None:
        batches = list(iter_nodes(sample_db, batch_size=2))
        # All batches except possibly the last should have <= batch_size rows
        for b in batches[:-1]:
            assert len(b) <= 2

    def test_filter_by_label(self, sample_db: Path) -> None:
        batches = list(iter_nodes(sample_db, batch_size=100, label="Class"))
        total = sum(len(b) for b in batches)
        assert total == 1  # Only 1 Class node

    def test_returns_dataframes(self, sample_db: Path) -> None:
        for batch in iter_nodes(sample_db, batch_size=100):
            assert isinstance(batch, pd.DataFrame)
            break


class TestIterEdges:
    """Tests for iter_edges batched edge loader."""

    def test_yields_all_edges(self, sample_db: Path) -> None:
        batches = list(iter_edges(sample_db, batch_size=2))
        total = sum(len(b) for b in batches)
        assert total == 4  # 4 edges in fixture

    def test_filter_by_type(self, sample_db: Path) -> None:
        batches = list(iter_edges(sample_db, batch_size=100, edge_type="CALLS"))
        total = sum(len(b) for b in batches)
        assert total == 2  # 2 CALLS edges


class TestIterEmbeddings:
    """Tests for iter_embeddings batched embedding loader."""

    def test_yields_all_embeddings(self, sample_db: Path) -> None:
        batches = list(iter_embeddings(sample_db, batch_size=2))
        total = sum(len(b) for b in batches)
        assert total == 4

    def test_vector_decoded(self, sample_db: Path) -> None:
        import numpy as np
        for batch in iter_embeddings(sample_db, batch_size=100):
            vec = batch.iloc[0]["vector"]
            assert isinstance(vec, np.ndarray)
            assert vec.dtype == np.float32
            break


class TestStreamGraph:
    """Tests for stream_graph single-record iterator."""

    def test_yields_dicts(self, sample_db: Path) -> None:
        records = list(stream_graph(sample_db))
        assert len(records) > 0
        assert isinstance(records[0], dict)

    def test_contains_node_and_edge_records(self, sample_db: Path) -> None:
        records = list(stream_graph(sample_db))
        record_types = {r.get("record_type") or r.get("kind") for r in records}
        # Should have both node and edge records
        assert "node" in record_types or "Node" in record_types
        assert "edge" in record_types or "Edge" in record_types or "relationship" in record_types
