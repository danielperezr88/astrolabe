"""NVIDIA RAPIDS cuGraph GPU backend for Astrolabe knowledge graphs.

This module provides :class:`CugraphBackend`, a GPU-accelerated graph analytics
backend that wraps `cuGraph <https://docs.rapids.ai/api/cugraph/stable/>`_
algorithms around Astrolabe knowledge-graph DataFrames.

All ``cudf`` / ``cugraph`` imports are deferred to function level so the module
can be imported safely on CPU-only machines.  Calling any GPU method without the
required packages raises :class:`ImportError` with installation instructions.

Typical usage
-------------
::

    from astrolabe_datasets.core import load_graph
    from astrolabe_datasets.cugraph_backend import CugraphBackend

    cg = load_graph("path/to/graph.db")
    backend = CugraphBackend(nodes_df=cg.nodes, edges_df=cg.edges,
                             embeddings_df=cg.embeddings, metrics_df=cg.metrics)

    pr = backend.pagerank()
    communities = backend.leiden(resolution=1.5)
"""

from __future__ import annotations

import sqlite3
from pathlib import Path
from typing import TYPE_CHECKING

import numpy as np
import pandas as pd

if TYPE_CHECKING:
    import cudf
    import cugraph

# ---------------------------------------------------------------------------
# Availability guard helper
# ---------------------------------------------------------------------------

_CUGRAPH_INSTALL_MSG = (
    "cuGraph/cuDF is not installed. "
    "Install with:  pip install cudf>=24.0 cugraph>=24.0  "
    "(requires NVIDIA GPU + RAPIDS environment). "
    "See https://rapids.ai/ for setup instructions."
)


def _require_cugraph() -> None:
    """Raise ImportError if ``cudf`` or ``cugraph`` is not available."""
    try:
        import cudf  # noqa: F401
        import cugraph  # noqa: F401
    except ImportError as exc:
        raise ImportError(_CUGRAPH_INSTALL_MSG) from exc


# ---------------------------------------------------------------------------
# Backend class
# ---------------------------------------------------------------------------


class CugraphBackend:
    """GPU-accelerated cuGraph backend for an Astrolabe knowledge graph.

    Wraps a collection of ``pandas`` DataFrames (nodes, edges, embeddings,
    metrics) and exposes cuGraph analytics as methods that return ``cudf``
    objects.

    Parameters
    ----------
    nodes_df:
        DataFrame with one row per graph node.  Expected columns include
        ``id``, ``label``, ``name``, ``filePath``, ``startLine``, ``endLine``,
        ``language``, ``isExported``, ``visibility``, ``parameterCount``,
        ``isAsync``, ``isStatic``.
    edges_df:
        DataFrame with one row per directed edge.  Expected columns include
        ``id``, ``source_id``, ``target_id``, ``type``, ``confidence``,
        ``reason``, ``step``.
    embeddings_df:
        Optional DataFrame with one row per embedded node.  Expected columns:
        ``node_id``, ``hash``, ``vector``, ``dims``.
    metrics_df:
        Optional DataFrame with one row per node metric entry.  Expected
        columns: ``node_id``, ``pagerank``, ``betweenness``, ``community_id``,
        ``cohesion``.

    Notes
    -----
    Construction does **not** require a GPU — DataFrames are stored as regular
    ``pandas`` objects and only converted to ``cudf`` when a GPU method is
    called.
    """

    def __init__(
        self,
        nodes_df: pd.DataFrame,
        edges_df: pd.DataFrame,
        embeddings_df: pd.DataFrame | None = None,
        metrics_df: pd.DataFrame | None = None,
    ) -> None:
        self._nodes_df: pd.DataFrame = nodes_df.reset_index(drop=True)
        self._edges_df: pd.DataFrame = edges_df.reset_index(drop=True)
        self._embeddings_df: pd.DataFrame | None = (
            embeddings_df.reset_index(drop=True) if embeddings_df is not None else None
        )
        self._metrics_df: pd.DataFrame | None = (
            metrics_df.reset_index(drop=True) if metrics_df is not None else None
        )

        # Build a stable mapping from string node IDs to integer indices.
        # cuGraph requires integer vertex identifiers.
        self._node_id_map: dict[str, int] = {}
        self._int_to_node_id: dict[int, str] = {}
        self._build_id_map()

        # Lazily-constructed cuGraph graph (rebuilt after mutations).
        self._graph: cugraph.Graph | None = None

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    def _build_id_map(self) -> None:
        """Create bi-directional string↔int ID mapping from the nodes DataFrame."""
        if self._nodes_df.empty or "id" not in self._nodes_df.columns:
            return
        for idx, node_id in enumerate(self._nodes_df["id"].astype(str)):
            self._node_id_map[str(node_id)] = idx
            self._int_to_node_id[idx] = str(node_id)

    def _ensure_id_columns(self) -> None:
        """Guarantee that ``src`` and ``dst`` integer columns exist on the edge DataFrame."""
        if "src" in self._edges_df.columns and "dst" in self._edges_df.columns:
            return
        if self._edges_df.empty:
            self._edges_df = self._edges_df.copy()
            self._edges_df["src"] = pd.Series(dtype="int32")
            self._edges_df["dst"] = pd.Series(dtype="int32")
            return

        src_col = self._edges_df["source_id"].astype(str).map(self._node_id_map)
        dst_col = self._edges_df["target_id"].astype(str).map(self._node_id_map)

        # Edges referencing unknown nodes are dropped.
        valid_mask = src_col.notna() & dst_col.notna()
        self._edges_df = self._edges_df.loc[valid_mask].copy()
        self._edges_df["src"] = src_col.loc[valid_mask].astype("int32")
        self._edges_df["dst"] = dst_col.loc[valid_mask].astype("int32")

    def _vertices_cudf(self) -> cudf.DataFrame:
        """Return a ``cudf`` DataFrame of vertices with a ``NODETYPE`` column."""
        import cudf as cudf_mod

        if self._nodes_df.empty:
            return cudf_mod.DataFrame({"vertex": pd.Series(dtype="int32")})

        df = self._nodes_df.copy()
        df["vertex"] = df["id"].astype(str).map(self._node_id_map)
        df = df.dropna(subset=["vertex"])
        df["vertex"] = df["vertex"].astype("int32")

        # NODETYPE column — uses the ``label`` column if present.
        if "label" in df.columns:
            df = df.rename(columns={"label": "NODETYPE"})
        else:
            df["NODETYPE"] = pd.Series(dtype="str")

        keep_cols = ["vertex", "NODETYPE"] + [
            c for c in ["name", "filePath", "startLine", "endLine", "language"]
            if c in df.columns
        ]
        return cudf_mod.DataFrame(df[keep_cols])

    def _edges_cudf(self) -> cudf.DataFrame:
        """Return a ``cudf`` DataFrame of edges with ``src``, ``dst``, and ``EDGETYPE``."""
        import cudf as cudf_mod

        self._ensure_id_columns()

        if self._edges_df.empty:
            return cudf_mod.DataFrame({
                "src": pd.Series(dtype="int32"),
                "dst": pd.Series(dtype="int32"),
                "EDGETYPE": pd.Series(dtype="str"),
            })

        df = self._edges_df[["src", "dst"]].copy()

        # EDGETYPE column — uses the ``type`` column if present.
        if "type" in self._edges_df.columns:
            df["EDGETYPE"] = self._edges_df["type"].values
        else:
            df["EDGETYPE"] = pd.Series(dtype="str", index=df.index)

        return cudf_mod.DataFrame(df)

    # ------------------------------------------------------------------
    # Graph construction
    # ------------------------------------------------------------------

    def to_cugraph(self) -> cugraph.Graph:
        """Build a ``cugraph.Graph`` property graph from the stored DataFrames.

        The returned graph has:

        * **Vertex properties** — a ``NODETYPE`` column derived from the
          ``label`` column of the nodes DataFrame.
        * **Edge properties** — an ``EDGETYPE`` column derived from the
          ``type`` column of the edges DataFrame.

        The graph is cached and reused on subsequent calls unless the
        underlying DataFrames have been mutated (in which case call this
        method again to rebuild).

        Returns
        -------
        cugraph.Graph
            A directed property graph suitable for cuGraph algorithms.

        Raises
        ------
        ImportError
            If ``cudf`` or ``cugraph`` is not installed.
        """
        _require_cugraph()
        import cugraph as cugraph_mod

        if self._graph is not None:
            return self._graph

        verts = self._vertices_cudf()
        edgs = self._edges_cudf()

        g = cugraph_mod.Graph(directed=True)
        g.from_cudf_edgelist(
            edgs,
            source="src",
            destination="dst",
            edge_attr="EDGETYPE" if "EDGETYPE" in edgs.columns else None,
        )

        # Add isolated vertices that have no edges.
        if not verts.empty and "vertex" in verts.columns:
            existing = set(g.nodes().to_arrow().to_pylist()) if g.number_of_nodes() > 0 else set()
            all_verts = set(verts["vertex"].to_arrow().to_pylist())
            isolated = all_verts - existing
            if isolated:
                import cudf as cudf_mod

                iso_df = cudf_mod.DataFrame({
                    "src": list(isolated),
                    "dst": list(isolated),
                })
                g.add_edge_list(iso_df)

        self._graph = g
        return g

    # ------------------------------------------------------------------
    # Community detection
    # ------------------------------------------------------------------

    def leiden(self, resolution: float = 1.0) -> cudf.Series:
        """Leiden community detection on the knowledge graph.

        Parameters
        ----------
        resolution:
            Resolution parameter controlling community granularity.
            Higher values produce more, smaller communities.

        Returns
        -------
        cudf.Series
            Community partition assignment indexed by vertex integer ID.

        Raises
        ------
        ImportError
            If ``cudf`` or ``cugraph`` is not installed.
        ValueError
            If the graph has fewer than two vertices.
        """
        _require_cugraph()
        import cugraph as cugraph_mod

        g = self.to_cugraph()
        if g.number_of_nodes() < 2:
            import cudf as cudf_mod

            return cudf_mod.Series(dtype="int32")

        parts = cugraph_mod.leiden(g, resolution=resolution)
        return parts.sort_values("vertex").set_index("vertex")["partition"]

    def louvain(self, resolution: float = 1.0) -> cudf.Series:
        """Louvain community detection on the knowledge graph.

        Parameters
        ----------
        resolution:
            Resolution parameter controlling community granularity.
            Higher values produce more, smaller communities.

        Returns
        -------
        cudf.Series
            Community partition assignment indexed by vertex integer ID.

        Raises
        ------
        ImportError
            If ``cudf`` or ``cugraph`` is not installed.
        ValueError
            If the graph has fewer than two vertices.
        """
        _require_cugraph()
        import cugraph as cugraph_mod

        g = self.to_cugraph()
        if g.number_of_nodes() < 2:
            import cudf as cudf_mod

            return cudf_mod.Series(dtype="int32")

        parts, _mod = cugraph_mod.louvain(g, resolution=resolution)
        return parts.sort_values("vertex").set_index("vertex")["partition"]

    # ------------------------------------------------------------------
    # Centrality
    # ------------------------------------------------------------------

    def pagerank(
        self,
        damping: float = 0.85,
        max_iter: int = 100,
    ) -> cudf.Series:
        """PageRank centrality on the knowledge graph.

        Parameters
        ----------
        damping:
            Damping (teleportation) factor.  Typical value is 0.85.
        max_iter:
            Maximum number of iterations.

        Returns
        -------
        cudf.Series
            PageRank scores indexed by vertex integer ID.

        Raises
        ------
        ImportError
            If ``cudf`` or ``cugraph`` is not installed.
        """
        _require_cugraph()
        import cugraph as cugraph_mod

        g = self.to_cugraph()
        if g.number_of_nodes() == 0:
            import cudf as cudf_mod

            return cudf_mod.Series(dtype="float64")

        pr = cugraph_mod.pagerank(g, damping=damping, max_iter=max_iter)
        return pr.sort_values("vertex").set_index("vertex")["pagerank"]

    def katz_centrality(self, alpha: float = 0.1) -> cudf.Series:
        """Katz centrality on the knowledge graph.

        Parameters
        ----------
        alpha:
            Attenuation factor.  Must be smaller than the reciprocal of the
            largest eigenvalue of the adjacency matrix.

        Returns
        -------
        cudf.Series
            Katz centrality scores indexed by vertex integer ID.

        Raises
        ------
        ImportError
            If ``cudf`` or ``cugraph`` is not installed.
        """
        _require_cugraph()
        import cugraph as cugraph_mod

        g = self.to_cugraph()
        if g.number_of_nodes() == 0:
            import cudf as cudf_mod

            return cudf_mod.Series(dtype="float64")

        kc = cugraph_mod.katz_centrality(g, alpha=alpha)
        return kc.sort_values("vertex").set_index("vertex")["katz_centrality"]

    def hits(
        self,
        max_iter: int = 100,
    ) -> tuple[cudf.Series, cudf.Series]:
        """HITS (Hyperlink-Induced Topic Search) hubs and authorities.

        Parameters
        ----------
        max_iter:
            Maximum number of iterations.

        Returns
        -------
        tuple[cudf.Series, cudf.Series]
            ``(hubs, authorities)`` — each indexed by vertex integer ID.

        Raises
        ------
        ImportError
            If ``cudf`` or ``cugraph`` is not installed.
        """
        _require_cugraph()
        import cugraph as cugraph_mod

        g = self.to_cugraph()
        if g.number_of_nodes() == 0:
            import cudf as cudf_mod

            empty = cudf_mod.Series(dtype="float64")
            return empty, empty

        hubs_df, auth_df = cugraph_mod.hits(g, max_iter=max_iter)
        hubs = hubs_df.sort_values("vertex").set_index("vertex")["hits_hub"]
        auth = auth_df.sort_values("vertex").set_index("vertex")["hits_auth"]
        return hubs, auth

    # ------------------------------------------------------------------
    # Shortest path
    # ------------------------------------------------------------------

    def sssp(self, source: int | str) -> cudf.DataFrame:
        """Single-source shortest path from *source*.

        Parameters
        ----------
        source:
            Source vertex.  Pass either an integer vertex ID or a string
            node identifier (which is mapped to the internal integer index).

        Returns
        -------
        cudf.DataFrame
            DataFrame with columns ``vertex``, ``distance``, ``predecessor``.

        Raises
        ------
        ImportError
            If ``cudf`` or ``cugraph`` is not installed.
        KeyError
            If *source* is a string that does not map to a known node ID.
        """
        _require_cugraph()
        import cugraph as cugraph_mod

        g = self.to_cugraph()
        if g.number_of_nodes() == 0:
            import cudf as cudf_mod

            return cudf_mod.DataFrame({
                "vertex": pd.Series(dtype="int32"),
                "distance": pd.Series(dtype="float64"),
                "predecessor": pd.Series(dtype="int32"),
            })

        src_int = self._resolve_vertex(source)
        return cugraph_mod.sssp(g, source=src_int)

    # ------------------------------------------------------------------
    # Link prediction
    # ------------------------------------------------------------------

    def jaccard(self, pairs: cudf.DataFrame | None = None) -> cudf.DataFrame:
        """Jaccard similarity coefficient for link prediction.

        Parameters
        ----------
        pairs:
            Optional ``cudf`` DataFrame with ``first`` and ``second`` columns
            specifying vertex pairs.  When ``None``, Jaccard is computed for
            all vertex pairs connected by at least one edge in the graph.

        Returns
        -------
        cudf.DataFrame
            DataFrame with columns ``first``, ``second``, ``jaccard_coeff``.

        Raises
        ------
        ImportError
            If ``cudf`` or ``cugraph`` is not installed.
        """
        _require_cugraph()
        import cugraph as cugraph_mod

        g = self.to_cugraph()
        if g.number_of_nodes() < 2:
            import cudf as cudf_mod

            return cudf_mod.DataFrame({
                "first": pd.Series(dtype="int32"),
                "second": pd.Series(dtype="int32"),
                "jaccard_coeff": pd.Series(dtype="float64"),
            })

        if pairs is not None:
            return cugraph_mod.jaccard(g, input_df=pairs)

        return cugraph_mod.jaccard(g)

    # ------------------------------------------------------------------
    # Random walks
    # ------------------------------------------------------------------

    def node2vec(
        self,
        start_vertices: list[int] | list[str],
        max_depth: int = 5,
        walk_length: int = 100,
    ) -> cudf.DataFrame:
        """Node2Vec-biased random walks for graph embedding.

        Parameters
        ----------
        start_vertices:
            List of starting vertices (integer IDs or string node identifiers).
        max_depth:
            Maximum walk depth.
        walk_length:
            Number of steps per walk.

        Returns
        -------
        cudf.DataFrame
            DataFrame with one row per walk, columns ``vertex``, ``path``.

        Raises
        ------
        ImportError
            If ``cudf`` or ``cugraph`` is not installed.
        KeyError
            If any start vertex string does not map to a known node ID.
        """
        _require_cugraph()
        import cudf as cudf_mod
        import cugraph as cugraph_mod

        g = self.to_cugraph()
        if g.number_of_nodes() == 0:
            return cudf_mod.DataFrame({
                "vertex": pd.Series(dtype="int32"),
                "path": pd.Series(dtype="object"),
            })

        resolved = [self._resolve_vertex(v) for v in start_vertices]
        starts = cudf_mod.Series(resolved, dtype="int32")

        return cugraph_mod.node2vec(
            g,
            start_vertices=starts,
            max_depth=max_depth,
            walk_length=walk_length,
        )

    # ------------------------------------------------------------------
    # PyG integration
    # ------------------------------------------------------------------

    def to_pyg_feature_store(self) -> object:
        """Create a ``cugraph_pyg`` FeatureStore + GraphStore for PyG training.

        Returns an object with ``feature_store`` and ``graph_store`` attributes
        suitable for use with PyTorch-Geometric data loading pipelines.

        Returns
        -------
        object
            A namespace with ``feature_store`` and ``graph_store`` attributes.

        Raises
        ------
        ImportError
            If ``cugraph_pyg``, ``cudf``, or ``cugraph`` is not installed.
        """
        try:
            import cugraph_pyg  # noqa: F401
        except ImportError as exc:
            raise ImportError(
                "cugraph_pyg is not installed. "
                "Install with:  pip install cugraph-pyg>=24.0  "
                "(requires NVIDIA GPU + RAPIDS environment). "
                "See https://docs.rapids.ai/api/cugraph/stable/pyg.html"
            ) from exc

        _require_cugraph()

        import cugraph_pyg as cugraph_pyg_mod
        import cudf as cudf_mod

        g = self.to_cugraph()

        # Build the PyG GraphStore from the cuGraph graph.
        graph_store = cugraph_pyg_mod.GraphStore()
        graph_store.add_cugraph_graph(g)

        # Build the FeatureStore from the embeddings DataFrame if available.
        feature_store = cugraph_pyg_mod.FeatureStore()

        if self._embeddings_df is not None and not self._embeddings_df.empty:
            emb_df = self._embeddings_df.copy()
            if "node_id" in emb_df.columns and "vector" in emb_df.columns:
                emb_df["vertex"] = (
                    emb_df["node_id"].astype(str).map(self._node_id_map)
                )
                emb_df = emb_df.dropna(subset=["vertex"])
                emb_df["vertex"] = emb_df["vertex"].astype("int32")

                # Stack vector arrays into a 2-D tensor representation.
                vectors = np.stack(emb_df["vector"].values)
                feat_gdf = cudf_mod.DataFrame(vectors)
                feat_gdf["vertex"] = emb_df["vertex"].values
                feature_store.add_data(
                    feat_gdf,
                    type_name="node",
                    feat_name="embedding",
                )

        class _PyGBundle:
            """Simple namespace returned by :meth:`to_pyg_feature_store`."""

            __slots__ = ("feature_store", "graph_store")

            def __init__(
                self,
                feature_store: object,
                graph_store: object,
            ) -> None:
                self.feature_store = feature_store
                self.graph_store = graph_store

        return _PyGBundle(feature_store=feature_store, graph_store=graph_store)

    # ------------------------------------------------------------------
    # Vertex resolution helper
    # ------------------------------------------------------------------

    def _resolve_vertex(self, vertex: int | str) -> int:
        """Map a string node ID or integer to the internal integer index.

        Parameters
        ----------
        vertex:
            Integer vertex index (returned as-is) or string node identifier
            looked up in ``_node_id_map``.

        Returns
        -------
        int
            The integer vertex index used by cuGraph.

        Raises
        ------
        KeyError
            If *vertex* is a string with no mapping.
        """
        if isinstance(vertex, int):
            return vertex
        if isinstance(vertex, str):
            if vertex not in self._node_id_map:
                raise KeyError(f"Unknown node ID: {vertex!r}")
            return self._node_id_map[vertex]
        msg = f"vertex must be int or str, got {type(vertex).__name__}"
        raise TypeError(msg)

    # ------------------------------------------------------------------
    # Convenience: translate integer IDs back to string IDs
    # ------------------------------------------------------------------

    def int_to_node_id(self, vertex: int) -> str | None:
        """Return the original string node ID for an integer vertex index.

        Parameters
        ----------
        vertex:
            Integer vertex index as used internally by cuGraph.

        Returns
        -------
        str | None
            Original string node ID, or ``None`` if the integer has no mapping.
        """
        return self._int_to_node_id.get(vertex)

    def node_id_to_int(self, node_id: str) -> int | None:
        """Return the integer vertex index for a string node ID.

        Parameters
        ----------
        node_id:
            Original string node identifier.

        Returns
        -------
        int | None
            Integer index, or ``None`` if the node ID has no mapping.
        """
        return self._node_id_map.get(node_id)


# ---------------------------------------------------------------------------
# Convenience loader
# ---------------------------------------------------------------------------


def from_sqlite(db_path: str | Path) -> CugraphBackend:
    """Load an Astrolabe SQLite database into a :class:`CugraphBackend`.

    This is a convenience function that reads the database via
    :func:`astrolabe_datasets.core.load_graph` and wraps the result.

    Parameters
    ----------
    db_path:
        Filesystem path to the ``.db`` file produced by ``astrolabe analyze``.

    Returns
    -------
    CugraphBackend
        A backend instance ready for GPU-accelerated graph analytics.

    Raises
    ------
    FileNotFoundError
        When *db_path* does not point to an existing file.
    ImportError
        If ``cudf`` or ``cugraph`` is not available (raised lazily when a
        GPU method is called, not at construction time).
    """
    from astrolabe_datasets.core import load_graph

    cg = load_graph(db_path)
    return CugraphBackend(
        nodes_df=cg.nodes,
        edges_df=cg.edges,
        embeddings_df=cg.embeddings if not cg.embeddings.empty else None,
        metrics_df=cg.metrics if not cg.metrics.empty else None,
    )
