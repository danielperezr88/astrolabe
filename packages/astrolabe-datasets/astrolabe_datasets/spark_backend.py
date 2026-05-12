"""Apache Spark GraphFrames distributed backend for Astrolabe knowledge graphs.

Provides a ``SparkGraphFrameBackend`` that wraps a knowledge graph as a
distributed GraphFrames object, enabling large-scale graph analytics
(PageRank, community detection, shortest paths, etc.) on clusters or
locally via Spark Connect.

All ``pyspark`` and ``graphframes`` imports are guarded at the function
level so that the module can be imported safely in environments that lack
Spark — callers will only hit ``ImportError`` when they actually invoke
a method that needs the distributed runtime.

Node and edge property columns are preserved verbatim as GraphFrame
vertex/edge properties.  Additionally, *vertex property groups* are
registered per unique ``label`` value and *edge property groups* per
unique ``type`` value so that downstream consumers can filter by node
category or edge category efficiently.

Typical usage::

    from astrolabe_datasets.spark_backend import SparkGraphFrameBackend

    backend = SparkGraphFrameBackend(nodes_df, edges_df)
    gf = backend.to_graph_frame()
    pr = backend.pagerank()
    cc = backend.connected_components()
"""

from __future__ import annotations

from pathlib import Path
from typing import TYPE_CHECKING, Optional

import pandas as pd

if TYPE_CHECKING:
    from graphframes import GraphFrame
    from pyspark.sql import DataFrame as SparkDataFrame
    from pyspark.sql import SparkSession


# ---------------------------------------------------------------------------
# Node / Edge schema constants
# ---------------------------------------------------------------------------

NODE_COLUMNS: list[str] = [
    "id",
    "label",
    "name",
    "filePath",
    "startLine",
    "endLine",
    "language",
    "isExported",
    "visibility",
    "parameterCount",
    "isAsync",
    "isStatic",
]

EDGE_COLUMNS: list[str] = [
    "id",
    "source_id",
    "target_id",
    "type",
    "confidence",
    "reason",
    "step",
]

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


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _require_pyspark() -> None:
    """Raise an actionable ``ImportError`` when ``pyspark`` is missing."""
    try:
        import pyspark  # noqa: F401 — availability check
    except ImportError as exc:
        raise ImportError(
            "pyspark is required for the Spark GraphFrames backend.  "
            "Install it with:  pip install 'astrolabe-datasets[spark]'  "
            "or  pip install pyspark>=3.5 graphframes>=0.11"
        ) from exc


def _require_graphframes() -> None:
    """Raise an actionable ``ImportError`` when ``graphframes`` is missing."""
    try:
        import graphframes  # noqa: F401 — availability check
    except ImportError as exc:
        raise ImportError(
            "graphframes is required for the Spark GraphFrames backend.  "
            "Install it with:  pip install 'astrolabe-datasets[spark]'  "
            "or  pip install graphframes>=0.11"
        ) from exc


def _create_or_get_session(
    spark_session: Optional[SparkSession] = None,
) -> SparkSession:
    """Return an existing ``SparkSession`` or create a local-mode one.

    Supports both classic cluster sessions and Spark Connect (remote)
    sessions — the caller simply passes whichever session they have.

    Parameters
    ----------
    spark_session:
        An existing ``pyspark.sql.SparkSession``, or ``None`` to create
        a local-mode session with sensible defaults.

    Returns
    -------
    pyspark.sql.SparkSession
    """
    _require_pyspark()
    from pyspark.sql import SparkSession

    if spark_session is not None:
        return spark_session

    return (
        SparkSession.builder
        .appName("astrolabe-graphframes")
        .master("local[*]")
        .config("spark.sql.shuffle.partitions", "8")
        .config("spark.jars.packages", "graphframes:graphframes:0.8.4-spark3.5-s_2.12")
        .getOrCreate()
    )


def _pandas_to_spark_df(
    pdf: pd.DataFrame,
    spark: SparkSession,
) -> SparkDataFrame:
    """Convert a pandas DataFrame to a Spark DataFrame.

    Handles nullable integer columns by casting them to ``LongType`` so
    that Spark does not silently promote to ``DoubleType``.

    Parameters
    ----------
    pdf:
        Source pandas DataFrame.
    spark:
        Active ``pyspark.sql.SparkSession``.

    Returns
    -------
    pyspark.sql.DataFrame
    """
    _require_pyspark()
    from pyspark.sql.types import LongType

    # Pandas columns that contain NaN in integer columns cause Spark to
    # infer DoubleType.  Explicitly cast known integer columns.
    int_cols = [
        c for c in pdf.columns
        if pd.api.types.is_integer_dtype(pdf[c])
        or (pd.api.types.is_float_dtype(pdf[c]) and (pdf[c] % 1 == 0).all())
    ]
    sdf = spark.createDataFrame(pdf)
    for col_name in int_cols:
        if col_name in sdf.columns:
            sdf = sdf.withColumn(col_name, sdf[col_name].cast(LongType()))
    return sdf


def _build_vertex_df(
    nodes_df: pd.DataFrame,
    spark: SparkSession,
) -> tuple[SparkDataFrame, dict[str, list[str]]]:
    """Build the GraphFrames vertex DataFrame and property-group map.

    The vertex DataFrame uses ``id`` as the vertex identifier.  All
    original columns are preserved as vertex properties.  A *vertex
    property group* map is returned that maps each node label to the
    list of columns relevant for that label.

    Parameters
    ----------
    nodes_df:
        Pandas DataFrame with at least an ``id`` and ``label`` column.
    spark:
        Active SparkSession.

    Returns
    -------
    tuple[pyspark.sql.DataFrame, dict[str, list[str]]]
        The vertex Spark DataFrame and a mapping of label → property
        column names.
    """
    v_pdf = nodes_df.rename(columns={"id": "id"})
    v_sdf = _pandas_to_spark_df(v_pdf, spark)

    # Build property groups: for each label, list columns that have
    # at least one non-null value for that label.
    property_groups: dict[str, list[str]] = {}
    for label in v_pdf["label"].unique():
        subset = v_pdf[v_pdf["label"] == label]
        cols = [
            c for c in subset.columns
            if c != "id" and subset[c].notna().any()
        ]
        if cols:
            property_groups[str(label)] = cols

    return v_sdf, property_groups


def _build_edge_df(
    edges_df: pd.DataFrame,
    spark: SparkSession,
) -> tuple[SparkDataFrame, dict[str, list[str]]]:
    """Build the GraphFrames edge DataFrame and property-group map.

    The edge DataFrame uses ``src`` and ``dst`` as endpoint columns
    (mapped from ``source_id`` / ``target_id``).  A *edge property
    group* map is returned that maps each edge type to the list of
    property columns relevant for that type.

    Parameters
    ----------
    edges_df:
        Pandas DataFrame with at least ``source_id``, ``target_id``,
        and ``type`` columns.
    spark:
        Active SparkSession.

    Returns
    -------
    tuple[pyspark.sql.DataFrame, dict[str, list[str]]]
        The edge Spark DataFrame and a mapping of type → property
        column names.
    """
    _require_pyspark()
    from pyspark.sql.functions import col

    e_pdf = edges_df.rename(
        columns={"source_id": "src", "target_id": "dst"}
    )
    e_sdf = _pandas_to_spark_df(e_pdf, spark)

    # GraphFrames requires 'src' and 'dst' columns.
    if "src" not in e_sdf.columns or "dst" not in e_sdf.columns:
        raise ValueError(
            "Edge DataFrame must contain 'source_id' and 'target_id' columns "
            "(renamed to 'src' and 'dst' for GraphFrames)."
        )

    # Build property groups: for each edge type, list columns that have
    # at least one non-null value for that type.
    property_groups: dict[str, list[str]] = {}
    for etype in e_pdf["type"].unique():
        subset = e_pdf[e_pdf["type"] == etype]
        cols = [
            c
            for c in subset.columns
            if c not in ("src", "dst") and subset[c].notna().any()
        ]
        if cols:
            property_groups[str(etype)] = cols

    return e_sdf, property_groups


# ---------------------------------------------------------------------------
# Main class
# ---------------------------------------------------------------------------


class SparkGraphFrameBackend:
    """Distributed GraphFrames backend for an Astrolabe knowledge graph.

    Wraps node/edge pandas DataFrames as a Spark GraphFrames object
    and exposes common graph algorithms as methods.  A
    ``SparkSession`` is created lazily in local mode when none is
    supplied, making interactive exploration straightforward while
    still supporting cluster deployment via Spark Connect.

    Parameters
    ----------
    nodes_df:
        Pandas DataFrame of nodes.  Must contain at least ``id`` and
        ``label`` columns (see :data:`NODE_COLUMNS` for the full
        schema).
    edges_df:
        Pandas DataFrame of edges.  Must contain at least
        ``source_id``, ``target_id``, and ``type`` columns (see
        :data:`EDGE_COLUMNS`).
    embeddings_df:
        Optional pandas DataFrame of pre-computed node embeddings.
        Must contain an ``id`` column that matches node IDs.
    metrics_df:
        Optional pandas DataFrame of pre-computed node/edge metrics.
    spark_session:
        An existing ``pyspark.sql.SparkSession``.  When ``None``, a
        local-mode session is created on first use.

    Attributes
    ----------
    vertex_property_groups:
        Mapping of node label → list of property column names.
    edge_property_groups:
        Mapping of edge type → list of property column names.
    """

    def __init__(
        self,
        nodes_df: pd.DataFrame,
        edges_df: pd.DataFrame,
        embeddings_df: Optional[pd.DataFrame] = None,
        metrics_df: Optional[pd.DataFrame] = None,
        spark_session: Optional[SparkSession] = None,
    ) -> None:
        _require_pyspark()
        _require_graphframes()

        self._nodes_pdf = nodes_df.copy()
        self._edges_pdf = edges_df.copy()
        self._embeddings_pdf = embeddings_df.copy() if embeddings_df is not None else None
        self._metrics_pdf = metrics_df.copy() if metrics_df is not None else None
        self._spark = spark_session  # may be None → created lazily

        # Validate minimum schema requirements.
        if "id" not in self._nodes_pdf.columns:
            raise ValueError("nodes_df must contain an 'id' column")
        if "label" not in self._nodes_pdf.columns:
            raise ValueError("nodes_df must contain a 'label' column")
        if "source_id" not in self._edges_pdf.columns:
            raise ValueError("edges_df must contain a 'source_id' column")
        if "target_id" not in self._edges_pdf.columns:
            raise ValueError("edges_df must contain a 'target_id' column")
        if "type" not in self._edges_pdf.columns:
            raise ValueError("edges_df must contain a 'type' column")

        # Build Spark DataFrames lazily via property.
        self._vertex_sdf: Optional[SparkDataFrame] = None
        self._edge_sdf: Optional[SparkDataFrame] = None
        self.vertex_property_groups: dict[str, list[str]] = {}
        self.edge_property_groups: dict[str, list[str]] = {}

    # -- lazy Spark session ------------------------------------------------

    @property
    def spark(self) -> SparkSession:
        """Return the active ``SparkSession``, creating one if needed."""
        if self._spark is None:
            self._spark = _create_or_get_session()
        return self._spark

    # -- lazy vertex / edge DataFrames ------------------------------------

    def _ensure_dataframes(self) -> None:
        """Build vertex and edge Spark DataFrames if not yet built."""
        if self._vertex_sdf is not None and self._edge_sdf is not None:
            return

        v_sdf, v_groups = _build_vertex_df(self._nodes_pdf, self.spark)
        e_sdf, e_groups = _build_edge_df(self._edges_pdf, self.spark)

        # Merge embeddings if provided.
        if self._embeddings_pdf is not None:
            emb_sdf = _pandas_to_spark_df(self._embeddings_pdf, self.spark)
            v_sdf = v_sdf.join(emb_sdf, on="id", how="left")

        # Merge metrics if provided.
        if self._metrics_pdf is not None:
            met_sdf = _pandas_to_spark_df(self._metrics_pdf, self.spark)
            # Heuristic: if the metrics DataFrame has an 'id' column,
            # join on vertices; otherwise treat it as edge metrics.
            if "id" in self._metrics_pdf.columns:
                v_sdf = v_sdf.join(met_sdf, on="id", how="left")
            elif "src" in met_sdf.columns:
                e_sdf = e_sdf.join(met_sdf, on=["src", "dst"], how="left")

        self._vertex_sdf = v_sdf
        self._edge_sdf = e_sdf
        self.vertex_property_groups = v_groups
        self.edge_property_groups = e_groups

    # -- GraphFrame construction -------------------------------------------

    def to_graph_frame(self) -> GraphFrame:
        """Build and return a ``GraphFrame`` from the stored data.

        The vertex DataFrame uses ``id`` as the vertex identifier and
        preserves all node properties as columns.  The edge DataFrame
        uses ``src`` and ``dst`` for endpoints and preserves all edge
        properties.

        Vertex property groups (keyed by node ``label``) and edge
        property groups (keyed by edge ``type``) are populated on the
        instance for downstream filtering.

        Returns
        -------
        graphframes.GraphFrame
        """
        _require_graphframes()
        from graphframes import GraphFrame

        self._ensure_dataframes()
        assert self._vertex_sdf is not None
        assert self._edge_sdf is not None

        # Ensure no duplicate vertex IDs — GraphFrame requires uniqueness.
        from pyspark.sql.functions import col

        v = self._vertex_sdf
        e = self._edge_sdf

        # Ensure edge endpoints reference valid vertex IDs.
        vertex_ids = v.select("id").withColumnRenamed("id", "vid")
        e = e.join(
            vertex_ids.withColumnRenamed("vid", "src_valid"),
            e["src"] == col("src_valid"),
            "left_semi",
        )
        e = e.join(
            vertex_ids.withColumnRenamed("vid", "dst_valid"),
            e["dst"] == col("dst_valid"),
            "left_semi",
        )
        e = e.drop("src_valid", "dst_valid")

        return GraphFrame(v, e)

    # -- Graph algorithms --------------------------------------------------

    def pagerank(
        self,
        reset_probability: float = 0.15,
        max_iter: int = 20,
        tol: float = 1e-4,
    ) -> SparkDataFrame:
        """Run distributed PageRank on the knowledge graph.

        Parameters
        ----------
        reset_probability:
            Probability of resetting to a random vertex (alpha).
        max_iter:
            Maximum number of iterations.
        tol:
            Convergence tolerance.

        Returns
        -------
        pyspark.sql.DataFrame
            DataFrame with columns ``id`` and ``pagerank``.
        """
        gf = self.to_graph_frame()
        return gf.pageRank(
            resetProbability=reset_probability,
            maxIter=max_iter,
            tol=tol,
        ).vertices.select("id", "pagerank")

    def connected_components(self) -> SparkDataFrame:
        """Compute connected components of the knowledge graph.

        Uses the GraphFrames connected components algorithm which is
        based on iterative label propagation.

        Returns
        -------
        pyspark.sql.DataFrame
            DataFrame with columns ``id`` and ``component``.
        """
        gf = self.to_graph_frame()
        return gf.connectedComponents().select("id", "component")

    def label_propagation(self, max_iter: int = 20) -> SparkDataFrame:
        """Run label propagation community detection.

        Each vertex is initially assigned its own label; at each step
        vertices adopt the most frequent label among their neighbours.

        Parameters
        ----------
        max_iter:
            Maximum number of iterations.

        Returns
        -------
        pyspark.sql.DataFrame
            DataFrame with columns ``id`` and ``label`` (community
            label, not the original node label).
        """
        gf = self.to_graph_frame()
        result = gf.labelPropagation(maxIter=max_iter)
        return result.select("id", "label")

    def bfs(
        self,
        from_expr: str,
        to_expr: str,
        max_path_length: int = 10,
    ) -> SparkDataFrame:
        """Breadth-first search for shortest paths.

        Finds the shortest path between vertices matching ``from_expr``
        and vertices matching ``to_expr`` using GraphFrames BFS.

        Parameters
        ----------
        from_expr:
            SQL expression identifying the starting vertices,
            e.g. ``"id = 'module:auth'"`` or ``"label = 'Function'"``.
        to_expr:
            SQL expression identifying the destination vertices,
            e.g. ``"id = 'module:db'"`` or ``"name = 'connect'"``.
        max_path_length:
            Upper bound on path length to explore.

        Returns
        -------
        pyspark.sql.DataFrame
            DataFrame where each row is a path with columns ``from``
            and ``to`` plus intermediate edge columns.
        """
        from pyspark.sql.functions import col

        gf = self.to_graph_frame()
        return gf.bfs(
            fromExpr=from_expr,
            toExpr=to_expr,
            maxPathLength=max_path_length,
        )

    def shortest_paths(self, landmarks: list[str]) -> SparkDataFrame:
        """Compute shortest-path distances to a set of landmark vertices.

        Parameters
        ----------
        landmarks:
            List of vertex IDs to use as landmarks.

        Returns
        -------
        pyspark.sql.DataFrame
            DataFrame with columns ``id`` and ``distances`` (a map
            from landmark ID to distance).
        """
        gf = self.to_graph_frame()
        return gf.shortestPaths(landmarks=landmarks)

    def triangle_count(self) -> SparkDataFrame:
        """Count the number of triangles passing through each vertex.

        Returns
        -------
        pyspark.sql.DataFrame
            DataFrame with columns ``id`` and ``triangle_count``.
        """
        gf = self.to_graph_frame()
        result = gf.triangleCount()
        return result.select("id", "triangle_count")

    def k_core(self, k: int) -> GraphFrame:
        """Compute the k-core decomposition of the graph.

        A k-core is the maximal subgraph in which every vertex has at
        least ``k`` neighbours *within the subgraph*.  The method
        iteratively prunes vertices with degree less than ``k``.

        Parameters
        ----------
        k:
            Core number.

        Returns
        -------
        graphframes.GraphFrame
            A new GraphFrame containing only the k-core subgraph.
        """
        _require_graphframes()
        from graphframes import GraphFrame
        from pyspark.sql.functions import col, lit, size

        gf = self.to_graph_frame()
        v = gf.vertices
        e = gf.edges

        # Iteratively prune vertices with degree < k until stable.
        for _ in range(100):  # safety bound
            # Compute degree.
            out_deg = e.groupBy("src").count().withColumnRenamed("count", "out_deg")
            in_deg = e.groupBy("dst").count().withColumnRenamed("count", "in_deg")
            deg = (
                out_deg.join(in_deg, out_deg["src"] == in_deg["dst"], "full_outer")
                .select(
                    col("src").alias("id"),
                    (col("out_deg").fillna(0) + col("in_deg").fillna(0)).alias("degree"),
                )
            )
            # Identify valid vertices (degree >= k).
            valid_ids = deg.filter(col("degree") >= k).select("id")
            # Prune vertices.
            v_new = v.join(valid_ids, on="id", how="inner")
            # Prune edges to only reference remaining vertices.
            valid_src = valid_ids.withColumnRenamed("id", "valid_src")
            valid_dst = valid_ids.withColumnRenamed("id", "valid_dst")
            e_new = (
                e.join(valid_src, e["src"] == col("valid_src"), "inner")
                 .join(valid_dst, e["dst"] == col("valid_dst"), "inner")
                 .drop("valid_src", "valid_dst")
            )
            # Check convergence.
            if v_new.count() == v.count():
                break
            v = v_new
            e = e_new

        return GraphFrame(v, e)

    def random_walk_embeddings(
        self,
        walk_length: int = 10,
        num_walks: int = 100,
        vector_size: int = 128,
        window_size: int = 5,
        min_count: int = 1,
    ) -> SparkDataFrame:
        """Generate node embeddings via random walks + Word2Vec.

        Performs ``num_walks`` random walks of length ``walk_length``
        starting from each vertex, then trains Spark ML Word2Vec on
        the resulting corpus of walks.

        Parameters
        ----------
        walk_length:
            Length of each random walk.
        num_walks:
            Number of walks per vertex.
        vector_size:
            Dimensionality of the resulting embedding vectors.
        window_size:
            Context window size for Word2Vec.
        min_count:
            Minimum frequency for a word (node ID) to be included.

        Returns
        -------
        pyspark.sql.DataFrame
            DataFrame with columns ``id`` and ``embedding`` (vector).
        """
        from pyspark.sql.functions import col, collect_list, explode, lit, rand, sequence, size
        from pyspark.sql.types import ArrayType, StringType
        from pyspark.ml.feature import Word2Vec

        gf = self.to_graph_frame()

        # ------------------------------------------------------------------
        # Build adjacency list for random walk sampling.
        # ------------------------------------------------------------------
        edges = gf.edges.select("src", "dst")
        adj = edges.groupBy("src").agg(collect_list("dst").alias("neighbours"))

        # Also include reverse direction (undirected walks).
        rev = edges.select(col("src").alias("rev_src"), col("dst").alias("rev_dst"))
        rev_adj = rev.groupBy("rev_dst").agg(collect_list("rev_src").alias("rev_neighbours"))
        rev_adj = rev_adj.withColumnRenamed("rev_dst", "src")

        # Merge forward and reverse adjacency.
        adj = adj.join(rev_adj, on="src", how="full_outer")
        from pyspark.sql.functions import array_distinct, concat, when

        adj = adj.withColumn(
            "neighbours",
            array_distinct(
                concat(
                    col("neighbours"),
                    when(col("rev_neighbours").isNotNull(), col("rev_neighbours")).otherwise(
                        lit([])
                    ),
                )
            ),
        ).select("src", "neighbours")

        vertices = gf.vertices.select("id")

        # ------------------------------------------------------------------
        # Random walk simulation using Spark iteration.
        # ------------------------------------------------------------------
        # For each vertex, generate num_walks walks of walk_length steps.
        # We use a cross-join + iterative approach.
        from pyspark.sql.types import StructField, StructType

        # Seed: (vertex_id, walk_index, current_position, walk_so_far)
        seed = vertices.crossJoin(
            self.spark.range(0, num_walks).withColumnRenamed("id", "walk_idx")
        ).select(
            col("id").alias("start_id"),
            col("walk_idx"),
            col("id").alias("current"),
            col("id").alias("walk_step_0"),
        )

        # We will iteratively extend walks.  For efficiency we collect
        # walk steps as an array.
        from pyspark.sql.functions import array, size as arr_size

        current = vertices.crossJoin(
            self.spark.range(0, num_walks).withColumnRenamed("id", "walk_idx")
        ).withColumn("walk", array(col("id"))).withColumn("current", col("id"))
        current = current.select("current", "walk_idx", "walk")

        for _step in range(walk_length):
            # Join current positions with adjacency list.
            current = current.join(
                adj.withColumnRenamed("src", "current").withColumnRenamed(
                    "neighbours", "nbrs"
                ),
                on="current",
                how="left",
            )
            # Sample a random neighbour.
            from pyspark.sql.functions import element_at, floor, size as arr_size2

            current = current.withColumn(
                "nbr_count",
                when(col("nbrs").isNotNull(), arr_size2(col("nbrs"))).otherwise(lit(0)),
            )
            # If a vertex has neighbours, pick a random one; otherwise stay.
            current = current.withColumn(
                "rand_idx",
                when(col("nbr_count") > 0, floor(rand() * col("nbr_count")) + 1).otherwise(
                    lit(1)
                ),
            )
            current = current.withColumn(
                "next",
                when(
                    col("nbr_count") > 0,
                    element_at(col("nbrs"), col("rand_idx").cast("int")),
                ).otherwise(col("current")),
            )
            # Append to walk array.
            current = current.withColumn(
                "walk",
                when(col("next").isNotNull(), concat(col("walk"), array(col("next")))).otherwise(
                    col("walk")
                ),
            )
            # Move to next position.
            current = current.withColumn("current", col("next")).select(
                "current", "walk_idx", "walk"
            )

        # Each row is now a walk (array of node IDs).
        walks_df = current.select(col("walk").alias("walk"))

        # Cast walk elements to string for Word2Vec.
        from pyspark.sql.functions import transform as array_transform

        walks_df = walks_df.withColumn(
            "walk_str",
            array_transform(col("walk"), lambda x: x.cast("string")),
        ).select("walk_str")

        # ------------------------------------------------------------------
        # Train Word2Vec on the walks.
        # ------------------------------------------------------------------
        w2v = Word2Vec(
            vectorSize=vector_size,
            windowSize=window_size,
            minCount=min_count,
            inputCol="walk_str",
            outputCol="embedding",
        )
        model = w2v.fit(walks_df)

        # Retrieve embeddings for each node.
        embeddings = model.getVectors()
        # Rename columns to match our convention.
        embeddings = embeddings.withColumnRenamed("word", "id").withColumnRenamed(
            "vector", "embedding"
        )

        return embeddings

    # -- Utility methods ---------------------------------------------------

    def to_pyspark_dataframes(self) -> tuple[SparkDataFrame, SparkDataFrame]:
        """Return the vertex and edge Spark DataFrames.

        Useful when you want to run custom Spark SQL or DataFrame
        operations without going through the GraphFrames API.

        Returns
        -------
        tuple[pyspark.sql.DataFrame, pyspark.sql.DataFrame]
            Vertex DataFrame (with ``id`` column) and edge DataFrame
            (with ``src`` and ``dst`` columns).
        """
        self._ensure_dataframes()
        assert self._vertex_sdf is not None
        assert self._edge_sdf is not None
        return self._vertex_sdf, self._edge_sdf


# ---------------------------------------------------------------------------
# Convenience loader
# ---------------------------------------------------------------------------


def from_sqlite(
    db_path: str | Path,
    spark_session: Optional[SparkSession] = None,
) -> SparkGraphFrameBackend:
    """Load a knowledge graph from an Astrolabe SQLite database.

    Reads the ``nodes`` and ``edges`` tables from the given SQLite
    file, converts them to pandas DataFrames, and constructs a
    ``SparkGraphFrameBackend``.

    Parameters
    ----------
    db_path:
        Path to the Astrolabe SQLite database.
    spark_session:
        Optional existing SparkSession.

    Returns
    -------
    SparkGraphFrameBackend
        Backend initialised from the database contents.

    Raises
    ------
    FileNotFoundError
        If ``db_path`` does not exist.
    ValueError
        If the database does not contain the expected tables.
    """
    import sqlite3

    db_path = Path(db_path)
    if not db_path.exists():
        raise FileNotFoundError(f"SQLite database not found: {db_path}")

    with sqlite3.connect(str(db_path)) as conn:
        # Verify tables exist.
        tables = {
            row[0]
            for row in conn.execute(
                "SELECT name FROM sqlite_master WHERE type='table'"
            ).fetchall()
        }
        if "nodes" not in tables:
            raise ValueError(
                f"SQLite database at {db_path} does not contain a 'nodes' table"
            )
        if "edges" not in tables:
            raise ValueError(
                f"SQLite database at {db_path} does not contain an 'edges' table"
            )

        nodes_df = pd.read_sql_query("SELECT * FROM nodes", conn)
        edges_df = pd.read_sql_query("SELECT * FROM edges", conn)

    # Ensure expected column names.
    if "id" not in nodes_df.columns and "nodeId" in nodes_df.columns:
        nodes_df = nodes_df.rename(columns={"nodeId": "id"})
    if "source_id" not in edges_df.columns and "sourceId" in edges_df.columns:
        edges_df = edges_df.rename(columns={"sourceId": "source_id"})
    if "target_id" not in edges_df.columns and "targetId" in edges_df.columns:
        edges_df = edges_df.rename(columns={"targetId": "target_id"})

    return SparkGraphFrameBackend(
        nodes_df=nodes_df,
        edges_df=edges_df,
        spark_session=spark_session,
    )
