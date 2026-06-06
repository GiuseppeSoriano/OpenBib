import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery } from "@tanstack/react-query";
import CytoscapeComponent from "react-cytoscapejs";
import type { Core, EventObject } from "cytoscape";
import { graph as graphApi } from "@/lib/api";
import type {
  CitingOrder,
  ExpandRequest,
  GraphEdge,
  GraphNode,
  GraphResponse,
  PaperMetadata,
  RelationDirection,
} from "@/types";
import {
  Layers3,
  Loader2,
  Maximize2,
  Plus,
  RotateCcw,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import "./GraphPage.css";

export type GraphMode = "manual" | "paper" | "collection" | "library";

const LAYOUT_OPTIONS = {
  name: "cose",
  animate: true,
  animationDuration: 500,
  nodeRepulsion: () => 8500,
  idealEdgeLength: () => 130,
  edgeElasticity: () => 100,
  gravity: 0.3,
  numIter: 300,
  padding: 40,
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const CYTOSCAPE_STYLE: any[] = [
  {
    selector: "node",
    style: {
      label: "data(label)",
      shape: "ellipse",
      "background-color": "#E0AFA0",
      "border-color": "#d49a8a",
      "border-width": 2,
      // Size scales with global citation count (see nodeSize()).
      width: "data(size)",
      height: "data(size)",
      "font-size": "10px",
      "text-wrap": "ellipsis",
      "text-max-width": "130px",
      "text-margin-y": 8,
      "text-valign": "bottom",
      "text-halign": "center",
      color: "#463F3A",
    },
  },
  {
    selector: "node.grouped",
    style: {
      shape: "round-rectangle",
      "background-color": "#F4E3DA",
      "border-color": "#8A817C",
      "border-style": "dashed",
      "border-width": 3,
    },
  },
  {
    selector: "node.seed",
    style: {
      "background-color": "#463F3A",
      "border-color": "#463F3A",
      "font-weight": "bold" as const,
      color: "#463F3A",
    },
  },
  {
    selector: "node:selected",
    style: {
      "background-color": "#d49a8a",
      "border-color": "#463F3A",
      "border-width": 4,
    },
  },
  {
    selector: "edge",
    style: {
      width: 1.5,
      "line-color": "#BCB8B1",
      "target-arrow-color": "#BCB8B1",
      "target-arrow-shape": "triangle",
      "curve-style": "bezier",
      "arrow-scale": 0.9,
    },
  },
  {
    // citing → cited. Arrow points at the cited paper (its in-degree =
    // citations received).
    selector: "edge[relation_type = 'cited_by']",
    style: {
      "line-color": "#8A817C",
      "target-arrow-color": "#8A817C",
      width: 2,
    },
  },
];

/** Log-scaled node diameter from a paper's global citation count. */
function nodeSize(citedByCount?: number | null): number {
  const c = citedByCount ?? 0;
  return Math.round(Math.min(96, 30 + 13 * Math.log10(1 + c)));
}

function truncateLabel(label: string, maxLength: number) {
  return label.length > maxLength ? `${label.slice(0, maxLength)}…` : label;
}

function edgeKey(e: GraphEdge) {
  return `${e.source}__${e.target}__${e.relation_type}`;
}

/** Merge expansion results into the current graph, deduping nodes by id and
 *  edges by (source, target, relation). Existing nodes are kept as-is. */
function mergeGraph(
  prev: { nodes: GraphNode[]; edges: GraphEdge[] },
  incoming: { nodes: GraphNode[]; edges: GraphEdge[] },
) {
  const nodeById = new Map(prev.nodes.map((n) => [n.id, n]));
  for (const n of incoming.nodes) if (!nodeById.has(n.id)) nodeById.set(n.id, n);
  const edges = new Map(prev.edges.map((e) => [edgeKey(e), e]));
  for (const e of incoming.edges) edges.set(edgeKey(e), e);
  return { nodes: [...nodeById.values()], edges: [...edges.values()] };
}

const MODE_LABEL: Record<GraphMode, string> = {
  manual: "",
  paper: "Paper",
  collection: "Collection",
  library: "Library",
};

export default function GraphPage({ mode }: { mode: GraphMode }) {
  const { paperKey, collectionId } = useParams<{ paperKey: string; collectionId: string }>();
  const navigate = useNavigate();

  const paramKey =
    mode === "paper"
      ? paperKey
        ? decodeURIComponent(paperKey)
        : ""
      : mode === "collection"
        ? collectionId ?? ""
        : "";

  const [keyInput, setKeyInput] = useState(mode === "paper" ? paramKey : "");
  const [order, setOrder] = useState<CitingOrder>("cited_by_count");
  const [limitPerNode, setLimitPerNode] = useState(25);
  const [graphState, setGraphState] = useState<{ nodes: GraphNode[]; edges: GraphEdge[] }>({
    nodes: [],
    edges: [],
  });
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const cyRef = useRef<Core | null>(null);
  const autoExpandedRef = useRef<string | null>(null);

  useEffect(() => {
    if (mode === "paper") setKeyInput(paramKey);
  }, [mode, paramKey]);

  // ── Base graph load (paper / collection / library) ───────
  const baseEnabled =
    (mode === "paper" && !!paramKey) ||
    (mode === "collection" && !!paramKey) ||
    mode === "library";

  const baseQuery = useQuery<GraphResponse>({
    queryKey: ["graph-base", mode, paramKey, order],
    queryFn: () => {
      if (mode === "paper") return graphApi.buildPaper(paramKey, order);
      if (mode === "collection") return graphApi.buildCollection(paramKey, order);
      return graphApi.buildLibrary(order);
    },
    enabled: baseEnabled,
  });

  // ── Expansion (focused or global) ────────────────────────
  const expandMutation = useMutation({
    mutationFn: (body: ExpandRequest) => graphApi.expand(body),
    onSuccess: (data) => setGraphState((prev) => mergeGraph(prev, data)),
  });

  const expandFromKeys = useCallback(
    (fromKeys: string[], focusKey: string | null, direction: RelationDirection) => {
      if (fromKeys.length === 0) return;
      expandMutation.mutate({
        from_keys: fromKeys,
        focus_key: focusKey,
        existing_group_keys: graphState.nodes.map((n) => n.id),
        direction,
        order,
        limit_per_node: limitPerNode,
      });
    },
    [expandMutation, graphState.nodes, order, limitPerNode],
  );

  // Keep cytoscape event handlers pointed at the latest state/handlers.
  const actionsRef = useRef<{
    nodes: GraphNode[];
    expandFocused: (node: GraphNode, direction: RelationDirection) => void;
  }>({ nodes: [], expandFocused: () => {} });
  useEffect(() => {
    actionsRef.current = {
      nodes: graphState.nodes,
      expandFocused: (node, direction) =>
        expandFromKeys(
          [node.selected_version.canonical_key],
          node.selected_version.canonical_key,
          direction,
        ),
    };
  });

  // Reset accumulated graph whenever a fresh base arrives (also on order change).
  useEffect(() => {
    if (!baseQuery.data) return;
    setGraphState({ nodes: baseQuery.data.nodes, edges: baseQuery.data.edges });
    setSelectedNodeId(null);
    autoExpandedRef.current = null;
  }, [baseQuery.data]);

  // Single-paper view: auto-expand once so the first level of citing papers shows.
  useEffect(() => {
    if (mode !== "paper" || !baseQuery.data || baseQuery.data.nodes.length === 0) return;
    const sig = `${paramKey}|${order}`;
    if (autoExpandedRef.current === sig) return;
    autoExpandedRef.current = sig;
    expandMutation.mutate({
      from_keys: baseQuery.data.nodes.map((n) => n.selected_version.canonical_key),
      focus_key: null,
      existing_group_keys: baseQuery.data.nodes.map((n) => n.id),
      direction: "cited_by",
      order,
      limit_per_node: limitPerNode,
    });
    // limitPerNode intentionally omitted — changing it shouldn't re-seed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, baseQuery.data, paramKey, order]);

  // Re-run layout whenever the node/edge count changes (base load + expansions).
  useEffect(() => {
    const cy = cyRef.current;
    if (cy && graphState.nodes.length > 0) cy.layout(LAYOUT_OPTIONS).run();
  }, [graphState.nodes.length, graphState.edges.length]);

  const selectedNode = graphState.nodes.find((n) => n.id === selectedNodeId) ?? null;

  const cyElements = useMemo(() => {
    const nodes = graphState.nodes.map((node) => {
      const labelBase = node.selected_version.title || node.label || node.id;
      const label =
        node.version_count > 1
          ? `${truncateLabel(labelBase, 44)} (${node.version_count})`
          : truncateLabel(labelBase, 50);
      const classes = [node.is_seed ? "seed" : "", node.type === "paper_group" ? "grouped" : ""]
        .filter(Boolean)
        .join(" ");
      return {
        data: {
          id: node.id,
          label,
          size: nodeSize(node.selected_version.cited_by_count),
          versionCount: node.version_count,
          type: node.type,
        },
        classes,
      };
    });
    const edges = graphState.edges.map((edge, index) => ({
      data: {
        id: `e${index}`,
        source: edge.source,
        target: edge.target,
        relation_type: edge.relation_type,
      },
    }));
    return [...nodes, ...edges];
  }, [graphState]);

  const handleCyInit = useCallback((cy: Core) => {
    cyRef.current = cy;
    cy.on("tap", "node", (evt: EventObject) => setSelectedNodeId(evt.target.id()));
    cy.on("dbltap", "node", (evt: EventObject) => {
      const node = actionsRef.current.nodes.find((n) => n.id === evt.target.id());
      if (node) actionsRef.current.expandFocused(node, "cited_by");
    });
    cy.on("tap", (evt: EventObject) => {
      if (evt.target === cy) setSelectedNodeId(null);
    });
  }, []);

  const handleExploreKey = () => {
    const trimmed = keyInput.trim();
    if (!trimmed) return;
    navigate(`/graph/${encodeURIComponent(trimmed)}`);
  };

  const handleSelectVersion = (groupKey: string, version: PaperMetadata) => {
    setGraphState((prev) => ({
      ...prev,
      nodes: prev.nodes.map((n) =>
        n.id === groupKey ? { ...n, selected_version: version } : n,
      ),
    }));
  };

  const handleFit = () => cyRef.current?.fit(undefined, 40);
  const handleZoomIn = () => {
    const cy = cyRef.current;
    if (cy) cy.zoom({ level: cy.zoom() * 1.3, renderedPosition: { x: cy.width() / 2, y: cy.height() / 2 } });
  };
  const handleZoomOut = () => {
    const cy = cyRef.current;
    if (cy) cy.zoom({ level: cy.zoom() / 1.3, renderedPosition: { x: cy.width() / 2, y: cy.height() / 2 } });
  };
  const handleRelayout = () => cyRef.current?.layout(LAYOUT_OPTIONS).run();

  const isExpanding = expandMutation.isPending;
  const hasGraph = graphState.nodes.length > 0;

  return (
    <div className="graph-page">
      <h1>
        Citation Graph
        {MODE_LABEL[mode] && <span className="graph-mode-badge">{MODE_LABEL[mode]}</span>}
      </h1>

      <div className="graph-controls">
        <div className="graph-search">
          <input
            className="input"
            placeholder="Enter a paper canonical key…"
            value={keyInput}
            onChange={(e) => setKeyInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleExploreKey()}
          />
          <button className="btn btn-primary" onClick={handleExploreKey}>
            Explore
          </button>
        </div>

        <div className="graph-params">
          <div className="graph-order-toggle" role="group" aria-label="Expansion order">
            <button
              className={order === "cited_by_count" ? "active" : ""}
              onClick={() => setOrder("cited_by_count")}
              title="Add the most-cited citing papers first"
            >
              Top cited
            </button>
            <button
              className={order === "recent" ? "active" : ""}
              onClick={() => setOrder("recent")}
              title="Add the most recent citing papers first"
            >
              Most recent
            </button>
          </div>
          <label>
            Per expansion:
            <select value={limitPerNode} onChange={(e) => setLimitPerNode(Number(e.target.value))}>
              {[10, 25, 50, 100].map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </select>
          </label>
          <button
            className="btn btn-secondary"
            onClick={() =>
              expandFromKeys(graphState.nodes.map((n) => n.selected_version.canonical_key), null, "cited_by")
            }
            disabled={!hasGraph || isExpanding}
            title="Add papers that cite any node currently shown"
          >
            {isExpanding ? <Loader2 size={14} className="spin" /> : <Plus size={14} />}
            Expand citers
          </button>
          <button
            className="btn btn-secondary"
            onClick={() =>
              expandFromKeys(graphState.nodes.map((n) => n.selected_version.canonical_key), null, "cites")
            }
            disabled={!hasGraph || isExpanding}
            title="Add the references of any node currently shown (papers it cites)"
          >
            {isExpanding ? <Loader2 size={14} className="spin" /> : <Plus size={14} />}
            Expand references
          </button>
        </div>
      </div>

      {baseQuery.isLoading && <p className="graph-status">Loading graph…</p>}

      {baseQuery.data && !hasGraph && !baseQuery.isLoading && (
        <div className="card" style={{ padding: "2rem", textAlign: "center" }}>
          <p className="graph-status" style={{ padding: 0 }}>
            {mode === "collection" || mode === "library"
              ? "No papers to graph yet. Add some papers first."
              : "No graph data found for this paper."}
          </p>
        </div>
      )}

      {hasGraph && (
        <div className="graph-viewport">
          <div className="graph-toolbar">
            <button onClick={handleZoomIn} title="Zoom in"><ZoomIn size={16} /></button>
            <button onClick={handleZoomOut} title="Zoom out"><ZoomOut size={16} /></button>
            <button onClick={handleFit} title="Fit to view"><Maximize2 size={16} /></button>
            <button onClick={handleRelayout} title="Re-layout"><RotateCcw size={16} /></button>
            <span className="graph-info-badge">
              {isExpanding && "Expanding… · "}
              {graphState.nodes.length} nodes · {graphState.edges.length} edges
            </span>
          </div>

          <CytoscapeComponent
            elements={cyElements}
            layout={LAYOUT_OPTIONS}
            stylesheet={CYTOSCAPE_STYLE}
            className="graph-canvas"
            cy={handleCyInit}
            wheelSensitivity={0.3}
          />

          {selectedNode && (
            <div className="graph-node-detail card">
              <div className="graph-node-header">
                <h4>{selectedNode.selected_version.title}</h4>
                {selectedNode.version_count > 1 && (
                  <span className="graph-node-badge">
                    <Layers3 size={12} />
                    {selectedNode.version_count} versions
                  </span>
                )}
              </div>
              <p className="node-detail-key">
                {selectedNode.selected_version.authors.map((a) => a.name).join(", ") ||
                  selectedNode.selected_version.canonical_key}
              </p>
              <div className="node-detail-meta">
                {selectedNode.selected_version.venue && <span>{selectedNode.selected_version.venue}</span>}
                {selectedNode.selected_version.publication_date && (
                  <span>{selectedNode.selected_version.publication_date.slice(0, 4)}</span>
                )}
                {typeof selectedNode.selected_version.cited_by_count === "number" && (
                  <span>{selectedNode.selected_version.cited_by_count} citations</span>
                )}
              </div>

              {selectedNode.versions.length > 1 && (
                <div className="graph-version-picker">
                  {selectedNode.versions.map((version: PaperMetadata) => {
                    const isActive =
                      version.canonical_key === selectedNode.selected_version.canonical_key;
                    return (
                      <button
                        type="button"
                        key={version.canonical_key}
                        className={`graph-version-chip${isActive ? " active" : ""}`}
                        onClick={() => handleSelectVersion(selectedNode.paper_group_key, version)}
                      >
                        <span>{version.version || version.publication_date?.slice(0, 4) || "Version"}</span>
                        <span>{version.provider_source}</span>
                      </button>
                    );
                  })}
                </div>
              )}

              <div className="node-detail-actions">
                <button
                  className="btn btn-secondary"
                  disabled={isExpanding}
                  title="Add papers that cite this one"
                  onClick={() =>
                    expandFromKeys(
                      [selectedNode.selected_version.canonical_key],
                      selectedNode.selected_version.canonical_key,
                      "cited_by",
                    )
                  }
                >
                  {isExpanding ? <Loader2 size={14} className="spin" /> : <Plus size={14} />}
                  Citers
                </button>
                <button
                  className="btn btn-secondary"
                  disabled={isExpanding}
                  title="Add the papers this one cites (its references)"
                  onClick={() =>
                    expandFromKeys(
                      [selectedNode.selected_version.canonical_key],
                      selectedNode.selected_version.canonical_key,
                      "cites",
                    )
                  }
                >
                  {isExpanding ? <Loader2 size={14} className="spin" /> : <Plus size={14} />}
                  References
                </button>
              </div>
            </div>
          )}

          <div className="graph-legend">
            <span><span className="legend-dot seed" /> Seed</span>
            <span><span className="legend-dot grouped" /> Grouped versions</span>
            <span><span className="legend-dot" /> Paper (size = citations)</span>
            <span><span className="legend-line solid" /> A → B: A cites B</span>
          </div>
        </div>
      )}

      {mode === "manual" && !hasGraph && (
        <div className="card" style={{ padding: "2rem", textAlign: "center" }}>
          <p style={{ color: "var(--color-text-secondary)" }}>
            Enter a paper key above, or open a graph from a paper, collection, or your library.
          </p>
        </div>
      )}
    </div>
  );
}
