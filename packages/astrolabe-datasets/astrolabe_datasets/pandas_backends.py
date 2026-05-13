"""Conversions between Astrolabe DataFrames and graph libraries.

This module provides bidirectional conversion functions for three popular
Python graph libraries:

- **igraph** — fast C-core library with rich community detection algorithms.
- **graph-tool** — efficient C++-backed library with stochastic block models.
- **NetworkX** — pure-Python library with the broadest algorithm coverage.

All library imports are deferred to function level so this module can be
imported safely on machines where one or more of these libraries are not
installed.  Calling a function that wraps a missing library raises
:class:`ImportError` with installation instructions.

Typical usage
-------------
::

    from astrolabe_datasets.core import load_graph
    from astrolabe_datasets.pandas_backends import (
        to_igraph, from_igraph,
        to_networkx, from_networkx,
    )

    cg = load_graph("path/to/graph.db")
    ig = to_igraph(cg.nodes, cg.edges)
    communities = detect_communities_igraph(cg.nodes, cg.edges, method="leiden")
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING

import pandas as pd

if TYPE_CHECKING:
    import graph_tool as gt
    import igraph as ig
    import networkx as nx

# ---------------------------------------------------------------------------
# Availability guard helpers
# ---------------------------------------------------------------------------

_IGRAPH_INSTALL_MSG = (
    "python-igraph is not installed. "
    "Install with:  pip install python-igraph"
)

_GRAPHTOOL_INSTALL_MSG = (
    "graph-tool is not installed. "
    "Install with:  pip install graph-tool  "
    "(or see https://graph-tool.skewed.de/ for conda-based installs)."
)

_NETWORKX_INSTALL_MSG = (
    "NetworkX is not installed. "
    "Install with:  pip install networkx"
)


def _require_igraph() -> None:
    """Raise :class:`ImportError` if ``igraph`` is not available."""
    try:
        import igraph  # noqa: F401
    except ImportError as exc:
        raise ImportError(_IGRAPH_INSTALL_MSG) from exc


def _require_graphtool() -> None:
    """Raise :class:`ImportError` if ``graph_tool`` is not available."""
    try:
        import graph_tool  # noqa: F401
    except ImportError as exc:
        raise ImportError(_GRAPHTOOL_INSTALL_MSG) from exc


def _require_networkx() -> None:
    """Raise :class:`ImportError` if ``networkx`` is not available."""
    try:
        import networkx  # noqa: F401
    except ImportError as exc:
        raise ImportError(_NETWORKX_INSTALL_MSG) from exc


# ---------------------------------------------------------------------------
# Community result dataclass
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class CommunityResult:
    """Immutable result container for community detection algorithms.

    Attributes
    ----------
    membership:
        List mapping each node index to its community identifier.
        The *i*-th element gives the community id of node *i*.
    modularity:
        Modularity score of the partition (higher is better; ranges
        approximately from −0.5 to 1.0 for unweighted graphs).
    method:
        Human-readable name of the community detection method used
        (e.g. ``"leiden"``, ``"louvain"``, ``"walktrap"``, ``"sbm"``).
    num_communities:
        Number of distinct communities found.
    """

    membership: list[int]
    modularity: float
    method: str
    num_communities: int


# ---------------------------------------------------------------------------
# igraph conversions
# ---------------------------------------------------------------------------


def to_igraph(
    nodes_df: pd.DataFrame,
    edges_df: pd.DataFrame,
    directed: bool = True,
) -> ig.Graph:
    """Build an :class:`igraph.Graph` from Astrolabe DataFrames.

    The ``id`` column of *nodes_df* is mapped to igraph vertex names
    (the ``name`` vertex attribute).  All remaining columns in
    *nodes_df* are added as vertex attributes.  All columns in
    *edges_df* except ``source_id`` and ``target_id`` are added as edge
    attributes.

    Parameters
    ----------
    nodes_df:
        DataFrame with one row per node.  Must contain an ``id`` column.
        Other columns become vertex attributes.
    edges_df:
        DataFrame with one row per edge.  Must contain ``source_id`` and
        ``target_id`` columns referencing node ids present in *nodes_df*.
    directed:
        Whether the graph should be directed.  Defaults to ``True``.

    Returns
    -------
    igraph.Graph
        A graph object with vertex and edge attributes populated from
        the input DataFrames.

    Raises
    ------
    ImportError
        If ``python-igraph`` is not installed.
    KeyError
        If required columns are missing from the input DataFrames.
    """
    _require_igraph()
    import igraph as ig_mod

    # Build vertex list preserving the order of nodes_df.
    node_ids: list[str] = nodes_df["id"].astype(str).tolist()
    vertex_attrs: dict[str, list[object]] = {"name": list(node_ids)}

    # Add all other node columns as vertex attributes.
    for col in nodes_df.columns:
        if col == "id":
            continue
        vertex_attrs[col] = nodes_df[col].tolist()

    n_vertices = len(node_ids)

    # Map string node IDs to 0-based indices for edge construction.
    id_to_index: dict[str, int] = {nid: idx for idx, nid in enumerate(node_ids)}

    # Build edge list — skip edges referencing unknown nodes.
    sources: list[int] = []
    targets: list[int] = []
    edge_attrs: dict[str, list[object]] = {}
    edge_attr_cols: list[str] = [
        col for col in edges_df.columns if col not in ("source_id", "target_id")
    ]
    for col in edge_attr_cols:
        edge_attrs[col] = []

    for row_idx, row in edges_df.iterrows():
        src = str(row["source_id"])
        tgt = str(row["target_id"])
        if src not in id_to_index or tgt not in id_to_index:
            continue
        sources.append(id_to_index[src])
        targets.append(id_to_index[tgt])
        for col in edge_attr_cols:
            edge_attrs[col].append(row[col])

    edges = list(zip(sources, targets))

    graph = ig_mod.Graph(
        n=n_vertices,
        edges=edges,
        directed=directed,
        vertex_attrs=vertex_attrs,
        edge_attrs=edge_attrs if edge_attrs else None,
    )

    return graph


def from_igraph(graph: ig.Graph) -> tuple[pd.DataFrame, pd.DataFrame]:
    """Convert an :class:`igraph.Graph` back to Astrolabe DataFrames.

    The returned DataFrames conform to the Astrolabe schema:

    - **nodes** — columns ``id``, ``label``, ``name``, etc.  The igraph
      ``name`` vertex attribute (if present) is mapped to ``id``; otherwise
      string representations of vertex indices are used.
    - **edges** — columns ``id``, ``source_id``, ``target_id``, ``type``,
      etc.  Edge ids are generated from igraph edge indices.

    Parameters
    ----------
    graph:
        An :class:`igraph.Graph` instance (directed or undirected).

    Returns
    -------
    tuple[pd.DataFrame, pd.DataFrame]
        ``(nodes_df, edges_df)`` matching the Astrolabe DataFrame schema.

    Raises
    ------
    ImportError
        If ``python-igraph`` is not installed.
    """
    _require_igraph()
    import igraph as ig_mod

    # --- Vertices ---
    n_vertices = graph.vcount()
    vertex_data: dict[str, list[object]] = {}
    vertex_attrs = graph.vertex_attributes()

    # Determine the id column: prefer "name" attribute, fall back to index.
    if "name" in vertex_attrs:
        vertex_data["id"] = [str(v["name"]) for v in graph.vs]
    else:
        vertex_data["id"] = [str(v.index) for v in graph.vs]

    for attr in vertex_attrs:
        if attr == "name":
            continue
        vertex_data[attr] = [v[attr] for v in graph.vs]

    # Ensure "label" column exists — default to "Unknown" if absent.
    if "label" not in vertex_data:
        vertex_data["label"] = ["Unknown"] * n_vertices

    nodes_df = pd.DataFrame(vertex_data)

    # --- Edges ---
    n_edges = graph.ecount()
    edge_data: dict[str, list[object]] = {}
    edge_attrs = graph.edge_attributes()

    edge_data["id"] = [str(e.index) for e in graph.es]

    # Resolve source_id and target_id from vertex names or indices.
    if "name" in vertex_attrs:
        edge_data["source_id"] = [str(graph.es[e.index].source_vertex["name"]) for e in graph.es]
        edge_data["target_id"] = [str(graph.es[e.index].target_vertex["name"]) for e in graph.es]
    else:
        edge_data["source_id"] = [str(e.source) for e in graph.es]
        edge_data["target_id"] = [str(e.target) for e in graph.es]

    for attr in edge_attrs:
        edge_data[attr] = [e[attr] for e in graph.es]

    # Ensure "type" column exists — default to "UNKNOWN" if absent.
    if "type" not in edge_data:
        edge_data["type"] = ["UNKNOWN"] * n_edges

    edges_df = pd.DataFrame(edge_data)

    return nodes_df, edges_df


# ---------------------------------------------------------------------------
# graph-tool conversions
# ---------------------------------------------------------------------------


def to_graphtool(
    nodes_df: pd.DataFrame,
    edges_df: pd.DataFrame,
    directed: bool = True,
) -> gt.Graph:
    """Build a :class:`graph_tool.Graph` from Astrolabe DataFrames.

    All columns from *nodes_df* are added as vertex property maps
    (``vprop``) and all columns from *edges_df* (except ``source_id``
    and ``target_id``) are added as edge property maps (``eprop``).

    The ``id`` column of *nodes_df* is stored as the ``name`` vertex
    property so that string-based node identifiers can be recovered later.

    Parameters
    ----------
    nodes_df:
        DataFrame with one row per node.  Must contain an ``id`` column.
    edges_df:
        DataFrame with one row per edge.  Must contain ``source_id`` and
        ``target_id`` columns.
    directed:
        Whether the graph should be directed.  Defaults to ``True``.

    Returns
    -------
    graph_tool.Graph
        A graph object with property maps for all attributes.

    Raises
    ------
    ImportError
        If ``graph-tool`` is not installed.
    """
    _require_graphtool()
    import graph_tool as gt_mod

    g = gt_mod.Graph(directed=directed)

    node_ids: list[str] = nodes_df["id"].astype(str).tolist()
    n_vertices = len(node_ids)

    # Create vertices in order.
    vlist = [g.add_vertex() for _ in range(n_vertices)]
    id_to_vertex: dict[str, gt_mod.Vertex] = {
        nid: v for nid, v in zip(node_ids, vlist)
    }

    # Add vertex property maps.
    for col in nodes_df.columns:
        values = nodes_df[col].tolist()
        # Determine the property type from the first non-null value.
        sample = next((v for v in values if v is not None and not (isinstance(v, float) and pd.isna(v))), "")
        if isinstance(sample, (int, bool)):
            prop = g.new_vp("int")
        elif isinstance(sample, float):
            prop = g.new_vp("double")
        else:
            prop = g.new_vp("string")

        for idx, val in enumerate(values):
            if val is None or (isinstance(val, float) and pd.isna(val)):
                continue
            prop[vlist[idx]] = val

        # Store id column as "name" for identity, all others by their column name.
        prop_name = "name" if col == "id" else col
        g.vp[prop_name] = prop

    # Add edges and their property maps.
    edge_attr_cols: list[str] = [
        col for col in edges_df.columns if col not in ("source_id", "target_id")
    ]

    # Pre-create edge property maps.
    eprop_objects: dict[str, gt_mod.PropertyMap] = {}
    for col in edge_attr_cols:
        values = edges_df[col].tolist()
        sample = next((v for v in values if v is not None and not (isinstance(v, float) and pd.isna(v))), "")
        if isinstance(sample, (int, bool)):
            eprop_objects[col] = g.new_ep("int")
        elif isinstance(sample, float):
            eprop_objects[col] = g.new_ep("double")
        else:
            eprop_objects[col] = g.new_ep("string")

    for row_idx, row in edges_df.iterrows():
        src_id = str(row["source_id"])
        tgt_id = str(row["target_id"])
        if src_id not in id_to_vertex or tgt_id not in id_to_vertex:
            continue
        e = g.add_edge(id_to_vertex[src_id], id_to_vertex[tgt_id])
        for col in edge_attr_cols:
            val = row[col]
            if val is None or (isinstance(val, float) and pd.isna(val)):
                continue
            eprop_objects[col][e] = val

    for col, eprop in eprop_objects.items():
        g.ep[col] = eprop

    return g


def from_graphtool(graph: gt.Graph) -> tuple[pd.DataFrame, pd.DataFrame]:
    """Convert a :class:`graph_tool.Graph` back to Astrolabe DataFrames.

    Vertex property maps become columns of the nodes DataFrame, and edge
    property maps become columns of the edges DataFrame.  If a ``name``
    vertex property exists it is used as the ``id`` column; otherwise
    vertex indices are cast to strings.

    Parameters
    ----------
    graph:
        A :class:`graph_tool.Graph` instance.

    Returns
    -------
    tuple[pd.DataFrame, pd.DataFrame]
        ``(nodes_df, edges_df)`` matching the Astrolabe DataFrame schema.

    Raises
    ------
    ImportError
        If ``graph-tool`` is not installed.
    """
    _require_graphtool()
    import graph_tool as gt_mod

    # --- Vertices ---
    vertex_data: dict[str, list[object]] = {}

    # Determine the id column: prefer "name" vprop if it exists.
    if "name" in graph.vp:
        vertex_data["id"] = [str(graph.vp["name"][v]) for v in graph.vertices()]
    else:
        vertex_data["id"] = [str(int(v)) for v in graph.vertices()]

    # Collect all other vertex property maps.
    for prop_name in graph.vp:
        if prop_name == "name":
            continue
        prop = graph.vp[prop_name]
        vertex_data[prop_name] = [
            prop[v] for v in graph.vertices()
        ]

    # Ensure "label" exists.
    if "label" not in vertex_data:
        vertex_data["label"] = ["Unknown"] * graph.num_vertices()

    nodes_df = pd.DataFrame(vertex_data)

    # --- Edges ---
    edge_data: dict[str, list[object]] = {}
    edge_data["id"] = [str(int(e)) for e in graph.edges()]

    # Resolve source_id / target_id from vertex "name" vprop or indices.
    if "name" in graph.vp:
        edge_data["source_id"] = [
            str(graph.vp["name"][e.source()]) for e in graph.edges()
        ]
        edge_data["target_id"] = [
            str(graph.vp["name"][e.target()]) for e in graph.edges()
        ]
    else:
        edge_data["source_id"] = [str(int(e.source())) for e in graph.edges()]
        edge_data["target_id"] = [str(int(e.target())) for e in graph.edges()]

    for prop_name in graph.ep:
        prop = graph.ep[prop_name]
        edge_data[prop_name] = [
            prop[e] for e in graph.edges()
        ]

    # Ensure "type" exists.
    if "type" not in edge_data:
        edge_data["type"] = ["UNKNOWN"] * graph.num_edges()

    edges_df = pd.DataFrame(edge_data)

    return nodes_df, edges_df


# ---------------------------------------------------------------------------
# NetworkX conversions
# ---------------------------------------------------------------------------


def to_networkx(
    nodes_df: pd.DataFrame,
    edges_df: pd.DataFrame,
    directed: bool = True,
) -> nx.Graph:
    """Build a NetworkX graph from Astrolabe DataFrames.

    Uses :func:`networkx.from_pandas_edgelist` for the edge structure and
    then sets node attributes from *nodes_df*.

    Parameters
    ----------
    nodes_df:
        DataFrame with one row per node.  Must contain an ``id`` column.
        All columns (including ``id``) are attached as node attributes.
    edges_df:
        DataFrame with one row per edge.  Must contain ``source_id`` and
        ``target_id`` columns.  All other columns are attached as edge
        attributes.
    directed:
        Whether to build a :class:`nx.DiGraph` (True) or
        :class:`nx.Graph` (False).

    Returns
    -------
    nx.Graph | nx.DiGraph
        The constructed NetworkX graph.

    Raises
    ------
    ImportError
        If ``networkx`` is not installed.
    """
    _require_networkx()
    import networkx as nx_mod

    # Determine edge attribute columns.
    edge_attr_cols: list[str] = [
        col for col in edges_df.columns
        if col not in ("source_id", "target_id", "id")
    ]

    # Build graph from edge list.
    if edge_attr_cols:
        graph = nx_mod.from_pandas_edgelist(
            edges_df,
            source="source_id",
            target="target_id",
            edge_attr=list(edge_attr_cols),
            create_using=nx_mod.DiGraph if directed else nx_mod.Graph,
        )
    else:
        graph = nx_mod.from_pandas_edgelist(
            edges_df,
            source="source_id",
            target="target_id",
            edge_attr=True,
            create_using=nx_mod.DiGraph if directed else nx_mod.Graph,
        )

    # Attach node attributes from nodes_df.
    node_ids: set[str] = set(nodes_df["id"].astype(str))
    for _, row in nodes_df.iterrows():
        node_id = str(row["id"])
        if node_id in graph:
            for col in nodes_df.columns:
                val = row[col]
                # Skip NaN values.
                if isinstance(val, float) and pd.isna(val):
                    continue
                graph.nodes[node_id][col] = val
        else:
            # Add isolated nodes that have no edges.
            attrs: dict[str, object] = {}
            for col in nodes_df.columns:
                val = row[col]
                if not (isinstance(val, float) and pd.isna(val)):
                    attrs[col] = val
            graph.add_node(node_id, **attrs)

    # Ensure edge "id" attribute is populated from the DataFrame index
    # if the column exists in edges_df.
    if "id" in edges_df.columns:
        edge_id_map: dict[tuple[str, str], str] = {}
        for _, row in edges_df.iterrows():
            src = str(row["source_id"])
            tgt = str(row["target_id"])
            eid = str(row["id"])
            edge_id_map[(src, tgt)] = eid

        for u, v, data in graph.edges(data=True):
            if "id" not in data and (u, v) in edge_id_map:
                data["id"] = edge_id_map[(u, v)]

    return graph


def from_networkx(graph: nx.Graph) -> tuple[pd.DataFrame, pd.DataFrame]:
    """Convert a NetworkX graph back to Astrolabe DataFrames.

    Edges are extracted with :func:`networkx.to_pandas_edgelist`.  Node
    attributes are collected into the nodes DataFrame.  If the graph
    does not have a ``label`` node attribute, it defaults to ``"Unknown"``.

    Parameters
    ----------
    graph:
        A :class:`nx.Graph` or :class:`nx.DiGraph` instance.

    Returns
    -------
    tuple[pd.DataFrame, pd.DataFrame]
        ``(nodes_df, edges_df)`` matching the Astrolabe DataFrame schema.

    Raises
    ------
    ImportError
        If ``networkx`` is not installed.
    """
    _require_networkx()
    import networkx as nx_mod

    # --- Nodes ---
    node_records: list[dict[str, object]] = []
    for node_id, node_data in graph.nodes(data=True):
        record: dict[str, object] = {"id": str(node_id)}
        record.update(node_data)
        node_records.append(record)

    nodes_df = pd.DataFrame(node_records)

    # Ensure "label" column exists.
    if "label" not in nodes_df.columns:
        nodes_df["label"] = "Unknown"
    elif nodes_df["label"].isna().all():
        nodes_df["label"] = "Unknown"

    # --- Edges ---
    edges_df = nx_mod.to_pandas_edgelist(graph, source="source_id", target="target_id")

    # Ensure required columns exist.
    if "source_id" not in edges_df.columns:
        edges_df = pd.DataFrame(columns=["source_id", "target_id"])
    elif "id" not in edges_df.columns:
        edges_df["id"] = [str(i) for i in range(len(edges_df))]

    if "type" not in edges_df.columns:
        edges_df["type"] = "UNKNOWN"

    return nodes_df, edges_df


# ---------------------------------------------------------------------------
# Community detection — igraph
# ---------------------------------------------------------------------------


def detect_communities_igraph(
    nodes_df: pd.DataFrame,
    edges_df: pd.DataFrame,
    method: str = "leiden",
    **kwargs: object,
) -> CommunityResult:
    """Run community detection on an igraph graph built from Astrolabe DataFrames.

    Supported methods:

    - ``"leiden"`` — :meth:`igraph.Graph.community_leiden` (default).
    - ``"louvain"`` — :meth:`igraph.Graph.community_multilevel`.
    - ``"walktrap"`` — :meth:`igraph.Graph.community_walktrap`.
    - ``"fastgreedy"`` — :meth:`igraph.Graph.community_fastgreedy`.
    - ``"betweenness"`` — :meth:`igraph.Graph.community_edge_betweenness`.
    - ``"infomap"`` — :meth:`igraph.Graph.community_infomap`.
    - ``"label_propagation"`` — :meth:`igraph.Graph.community_label_propagation`.

    Extra keyword arguments are forwarded to the underlying igraph method.

    Parameters
    ----------
    nodes_df:
        DataFrame with one row per node (must contain ``id``).
    edges_df:
        DataFrame with one row per edge (must contain ``source_id`` and
        ``target_id``).
    method:
        Community detection algorithm name.  Defaults to ``"leiden"``.
    **kwargs:
        Additional keyword arguments forwarded to the igraph method.

    Returns
    -------
    CommunityResult
        Frozen dataclass with membership, modularity, method name, and
        community count.

    Raises
    ------
    ImportError
        If ``python-igraph`` is not installed.
    ValueError
        If *method* is not recognised.
    """
    _require_igraph()
    import igraph as ig_mod

    graph = to_igraph(nodes_df, edges_df, directed=True)

    method_dispatch = {
        "leiden": ig_mod.Graph.community_leiden,
        "louvain": ig_mod.Graph.community_multilevel,
        "walktrap": ig_mod.Graph.community_walktrap,
        "fastgreedy": ig_mod.Graph.community_fastgreedy,
        "betweenness": ig_mod.Graph.community_edge_betweenness,
        "infomap": ig_mod.Graph.community_infomap,
        "label_propagation": ig_mod.Graph.community_label_propagation,
    }

    if method not in method_dispatch:
        supported = ", ".join(sorted(method_dispatch.keys()))
        raise ValueError(
            f"Unknown igraph community method: {method!r}. "
            f"Supported methods: {supported}"
        )

    # Some methods return dendrograms that need .as_clustering().
    clustering_obj = method_dispatch[method](graph, **kwargs)

    # Walktrap and betweenness return VertexDendrogram; call .as_clustering().
    if hasattr(clustering_obj, "as_clustering"):
        membership = list(clustering_obj.as_clustering())
    else:
        membership = list(clustering_obj.membership)

    modularity: float = graph.modularity(membership)
    num_communities: int = len(set(membership))

    return CommunityResult(
        membership=membership,
        modularity=float(modularity),
        method=f"igraph_{method}",
        num_communities=num_communities,
    )


# ---------------------------------------------------------------------------
# Community detection — graph-tool (SBM)
# ---------------------------------------------------------------------------


def detect_communities_graphtool(
    nodes_df: pd.DataFrame,
    edges_df: pd.DataFrame,
    method: str = "sbm",
) -> CommunityResult:
    """Run community detection on a graph-tool graph built from Astrolabe DataFrames.

    The primary method is stochastic block model (SBM) via
    :func:`graph_tool.inference.minimize_blockmodel_dl`.

    Parameters
    ----------
    nodes_df:
        DataFrame with one row per node (must contain ``id``).
    edges_df:
        DataFrame with one row per edge (must contain ``source_id`` and
        ``target_id``).
    method:
        Community detection algorithm.  Currently only ``"sbm"`` (stochastic
        block model) is supported.  Defaults to ``"sbm"``.

    Returns
    -------
    CommunityResult
        Frozen dataclass with membership, modularity, method name, and
        community count.

    Raises
    ------
    ImportError
        If ``graph-tool`` is not installed.
    ValueError
        If *method* is not recognised.
    """
    _require_graphtool()
    import graph_tool as gt_mod
    from graph_tool.inference import minimize_blockmodel_dl

    if method != "sbm":
        raise ValueError(
            f"Unknown graph-tool community method: {method!r}. "
            f"Supported methods: sbm"
        )

    g = to_graphtool(nodes_df, edges_df, directed=True)

    # Minimise the description length to find the optimal partition.
    state = minimize_blockmodel_dl(g)

    # Extract block membership — state.get_blocks() returns a vertex property map.
    block_membership = state.get_blocks()
    membership: list[int] = [int(block_membership[v]) for v in g.vertices()]

    # Compute modularity via graph_tool.inference.modularity.
    from graph_tool.inference import modularity

    mod_score: float = modularity(g, block_membership)
    num_communities: int = len(set(membership))

    return CommunityResult(
        membership=membership,
        modularity=float(mod_score),
        method=f"graphtool_{method}",
        num_communities=num_communities,
    )