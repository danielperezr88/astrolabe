"""Astrolabe Datasets — Python Graph Dataset API for Astrolabe knowledge graphs.

Exposes Astrolabe SQLite knowledge graph data as rich graph datasets consumable
by major Data Science and ML frameworks: PyTorch-Geometric, cuGraph, Spark
GraphFrames, igraph, graph-tool, and NetworkX.
"""

from astrolabe_datasets.core import (
    NODE_LABELS,
    RELATIONSHIP_TYPES,
    CodeGraph,
    list_available_graphs,
    load_graph,
    load_graphs,
)

__version__ = "0.1.0"

__all__ = [
    "NODE_LABELS",
    "RELATIONSHIP_TYPES",
    "CodeGraph",
    "list_available_graphs",
    "load_graph",
    "load_graphs",
]
