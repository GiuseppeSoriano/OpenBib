import { useState, useCallback, useRef } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import CytoscapeComponent from "react-cytoscapejs";
import type { Core, EventObject } from "cytoscape";
import api from "@/lib/api";
import type { GraphResponse } from "@/types";
import { Maximize2, ZoomIn, ZoomOut, RotateCcw } from "lucide-react";
import "./GraphPage.css";

const LAYOUT_OPTIONS = {
  name: "cose",
  animate: true,
  animationDuration: 500,
  nodeRepulsion: () => 8000,
  idealEdgeLength: () => 120,
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
      "background-color": "#E0AFA0",
      "border-color": "#d49a8a",
      "border-width": 2,
      width: 40,
      height: 40,
      "font-size": "10px",
      "text-wrap": "ellipsis",
      "text-max-width": "120px",
      "text-margin-y": 8,
      "text-valign": "bottom",
      "text-halign": "center",
      color: "#463F3A",
    },
  },
  {
    selector: "node.seed",
    style: {
      "background-color": "#463F3A",
      "border-color": "#463F3A",
      width: 55,
      height: 55,
      "font-size": "11px",
      "font-weight": "bold" as const,
      color: "#463F3A",
    },
  },
  {
    selector: "node:selected",
    style: {
      "background-color": "#d49a8a",
      "border-color": "#463F3A",
      "border-width": 3,
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
      "arrow-scale": 0.8,
    },
  },
  {
    selector: "edge[relation_type = 'cites']",
    style: {
      "line-color": "#8A817C",
      "target-arrow-color": "#8A817C",
    },
  },
  {
    selector: "edge[relation_type = 'similar_to']",
    style: {
      "line-style": "dashed",
      "line-color": "#E0AFA0",
      "target-arrow-shape": "none",
    },
  },
];

export default function GraphPage() {
  const { paperKey } = useParams<{ paperKey: string }>();
  const navigate = useNavigate();
  const [key, setKey] = useState(paperKey ? decodeURIComponent(paperKey) : "");
  const [searchKey, setSearchKey] = useState(paperKey ? decodeURIComponent(paperKey) : "");
  const [depth, setDepth] = useState(2);
  const [maxNodes, setMaxNodes] = useState(50);
  const [selectedNode, setSelectedNode] = useState<string | null>(null);
  const cyRef = useRef<Core | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ["graph", searchKey, depth, maxNodes],
    queryFn: async () => {
      const { data } = await api.get<GraphResponse>(`/graph/${encodeURIComponent(searchKey)}`, {
        params: { depth, max_nodes: maxNodes },
      });
      return data;
    },
    enabled: !!searchKey,
  });

  const handleExplore = () => {
    if (key.trim()) {
      setSearchKey(key.trim());
      navigate(`/graph/${encodeURIComponent(key.trim())}`, { replace: true });
    }
  };

  const cyElements = (() => {
    if (!data) return [];
    const nodes = data.nodes.map((n) => ({
      data: {
        id: n.id,
        label: n.label && n.label !== n.id
          ? n.label.length > 50
            ? n.label.slice(0, 50) + "…"
            : n.label
          : n.id.length > 30
            ? n.id.slice(0, 30) + "…"
            : n.id,
        fullLabel: n.label || n.id,
      },
      classes: n.id === searchKey ? "seed" : "",
    }));
    const edges = data.edges.map((e, i) => ({
      data: {
        id: `e${i}`,
        source: e.source,
        target: e.target,
        relation_type: e.relation_type,
      },
    }));
    return [...nodes, ...edges];
  })();

  const handleCyInit = useCallback(
    (cy: Core) => {
      cyRef.current = cy;
      cy.on("tap", "node", (evt: EventObject) => {
        const nodeId = evt.target.id();
        setSelectedNode(nodeId);
      });
      cy.on("dbltap", "node", (evt: EventObject) => {
        const nodeId = evt.target.id();
        setKey(nodeId);
        setSearchKey(nodeId);
        navigate(`/graph/${encodeURIComponent(nodeId)}`, { replace: true });
      });
      cy.on("tap", (evt: EventObject) => {
        if (evt.target === cy) setSelectedNode(null);
      });
    },
    [navigate],
  );

  const handleFit = () => cyRef.current?.fit(undefined, 40);
  const handleZoomIn = () => {
    const cy = cyRef.current;
    if (cy) cy.zoom({ level: cy.zoom() * 1.3, renderedPosition: { x: cy.width() / 2, y: cy.height() / 2 } });
  };
  const handleZoomOut = () => {
    const cy = cyRef.current;
    if (cy) cy.zoom({ level: cy.zoom() / 1.3, renderedPosition: { x: cy.width() / 2, y: cy.height() / 2 } });
  };
  const handleRelayout = () => {
    cyRef.current?.layout(LAYOUT_OPTIONS).run();
  };

  return (
    <div className="graph-page">
      <h1>Citation Graph</h1>

      <div className="graph-controls">
        <div className="graph-search">
          <input
            className="input"
            placeholder="Enter a DOI or canonical key…"
            value={key}
            onChange={(e) => setKey(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleExplore()}
          />
          <button className="btn btn-primary" onClick={handleExplore}>
            Explore
          </button>
        </div>

        <div className="graph-params">
          <label>
            Depth:
            <select value={depth} onChange={(e) => setDepth(Number(e.target.value))}>
              {[1, 2, 3, 4, 5].map((d) => (
                <option key={d} value={d}>{d}</option>
              ))}
            </select>
          </label>
          <label>
            Max nodes:
            <select value={maxNodes} onChange={(e) => setMaxNodes(Number(e.target.value))}>
              {[25, 50, 100, 150, 200].map((n) => (
                <option key={n} value={n}>{n}</option>
              ))}
            </select>
          </label>
        </div>
      </div>

      {isLoading && <p className="graph-status">Loading graph…</p>}

      {data && data.nodes.length === 0 && (
        <div className="card" style={{ padding: "2rem", textAlign: "center" }}>
          <p className="graph-status" style={{ padding: 0 }}>
            No graph data found for this paper. Try searching a paper first to
            populate citation data.
          </p>
        </div>
      )}

      {data && data.nodes.length > 0 && (
        <div className="graph-viewport">
          <div className="graph-toolbar">
            <button onClick={handleZoomIn} title="Zoom in"><ZoomIn size={16} /></button>
            <button onClick={handleZoomOut} title="Zoom out"><ZoomOut size={16} /></button>
            <button onClick={handleFit} title="Fit to view"><Maximize2 size={16} /></button>
            <button onClick={handleRelayout} title="Re-layout"><RotateCcw size={16} /></button>
            <span className="graph-info-badge">
              {data.nodes.length} nodes · {data.edges.length} edges
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
              <h4>Selected node</h4>
              <p className="node-detail-key">{selectedNode}</p>
              <div className="node-detail-actions">
                <button
                  className="btn btn-secondary"
                  onClick={() => {
                    setKey(selectedNode);
                    setSearchKey(selectedNode);
                    navigate(`/graph/${encodeURIComponent(selectedNode)}`, { replace: true });
                  }}
                >
                  Expand from here
                </button>
              </div>
            </div>
          )}

          <div className="graph-legend">
            <span><span className="legend-dot seed" /> Seed paper</span>
            <span><span className="legend-dot" /> Connected paper</span>
            <span><span className="legend-line solid" /> Cites</span>
            <span><span className="legend-line dashed" /> Similar</span>
          </div>
        </div>
      )}

      {!searchKey && (
        <div className="card" style={{ padding: "2rem", textAlign: "center" }}>
          <p style={{ color: "var(--color-text-secondary)" }}>
            Enter a paper key above or double-click a node to explore its
            citation neighborhood.
          </p>
        </div>
      )}
    </div>
  );
}
