import { useEffect, useRef, useState, useCallback } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import CytoscapeComponent from "react-cytoscapejs";
import type { Core, EventObject } from "cytoscape";
import api from "@/lib/api";
import type { GraphResponse, PaperMetadata } from "@/types";
import { Layers3, Maximize2, RotateCcw, ZoomIn, ZoomOut } from "lucide-react";
import "./GraphPage.css";

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
      width: 42,
      height: 42,
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
      width: 58,
      height: 46,
    },
  },
  {
    selector: "node.seed",
    style: {
      "background-color": "#463F3A",
      "border-color": "#463F3A",
      width: 60,
      height: 60,
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
  const initialKey = paperKey ? decodeURIComponent(paperKey) : "";
  const [key, setKey] = useState(initialKey);
  const [searchKey, setSearchKey] = useState(initialKey);
  const [depth, setDepth] = useState(2);
  const [maxNodes, setMaxNodes] = useState(50);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [selectedVersions, setSelectedVersions] = useState<Record<string, string>>({});
  const cyRef = useRef<Core | null>(null);

  useEffect(() => {
    const nextKey = paperKey ? decodeURIComponent(paperKey) : "";
    setKey(nextKey);
    setSearchKey(nextKey);
    setSelectedNodeId(null);
    setSelectedVersions({});
  }, [paperKey]);

  const { data, isLoading } = useQuery({
    queryKey: ["graph", searchKey, depth, maxNodes, JSON.stringify(selectedVersions)],
    queryFn: async () => {
      const { data } = await api.get<GraphResponse>(`/graph/${encodeURIComponent(searchKey)}`, {
        params: {
          depth,
          max_nodes: maxNodes,
          selected_versions:
            Object.keys(selectedVersions).length > 0 ? JSON.stringify(selectedVersions) : undefined,
        },
      });
      return data;
    },
    enabled: !!searchKey,
  });

  const selectedNode = data?.nodes.find((node) => node.id === selectedNodeId) ?? null;

  const handleExplore = () => {
    if (!key.trim()) return;
    setSelectedVersions({});
    setSelectedNodeId(null);
    setSearchKey(key.trim());
    navigate(`/graph/${encodeURIComponent(key.trim())}`, { replace: true });
  };

  const cyElements = (() => {
    if (!data) return [];
    const nodes = data.nodes.map((node) => {
      const labelBase = node.selected_version.title || node.label || node.id;
      const label =
        node.version_count > 1 ? `${truncateLabel(labelBase, 44)} (${node.version_count})` : truncateLabel(labelBase, 50);
      const classes = [
        node.is_seed ? "seed" : "",
        node.type === "paper_group" ? "grouped" : "",
      ]
        .filter(Boolean)
        .join(" ");
      return {
        data: {
          id: node.id,
          label,
          fullLabel: node.selected_version.title || node.label || node.id,
          versionCount: node.version_count,
          type: node.type,
        },
        classes,
      };
    });
    const edges = data.edges.map((edge, index) => ({
      data: {
        id: `e${index}`,
        source: edge.source,
        target: edge.target,
        relation_type: edge.relation_type,
      },
    }));
    return [...nodes, ...edges];
  })();

  const handleCyInit = useCallback((cy: Core) => {
    cyRef.current = cy;
    cy.on("tap", "node", (evt: EventObject) => {
      setSelectedNodeId(evt.target.id());
    });
    cy.on("dbltap", "node", (evt: EventObject) => {
      const nodeId = evt.target.id();
      const node = data?.nodes.find((entry) => entry.id === nodeId);
      if (!node) return;
      const nextPaperKey = node.selected_version.canonical_key;
      setSelectedVersions({});
      setKey(nextPaperKey);
      setSearchKey(nextPaperKey);
      navigate(`/graph/${encodeURIComponent(nextPaperKey)}`, { replace: true });
    });
    cy.on("tap", (evt: EventObject) => {
      if (evt.target === cy) setSelectedNodeId(null);
    });
  }, [data?.nodes, navigate]);

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
            placeholder="Enter a paper canonical key…"
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
              {[1, 2, 3, 4, 5].map((value) => (
                <option key={value} value={value}>{value}</option>
              ))}
            </select>
          </label>
          <label>
            Max nodes:
            <select value={maxNodes} onChange={(e) => setMaxNodes(Number(e.target.value))}>
              {[25, 50, 100, 150, 200].map((value) => (
                <option key={value} value={value}>{value}</option>
              ))}
            </select>
          </label>
        </div>
      </div>

      {isLoading && <p className="graph-status">Loading graph…</p>}

      {data && data.nodes.length === 0 && (
        <div className="card" style={{ padding: "2rem", textAlign: "center" }}>
          <p className="graph-status" style={{ padding: 0 }}>
            No graph data found for this paper. Try searching a paper first to populate citation data.
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
              <div className="graph-node-header">
                <h4>{selectedNode.selected_version.title}</h4>
                {selectedNode.version_count > 1 && (
                  <span className="graph-node-badge">
                    <Layers3 size={12} />
                    {selectedNode.version_count} versions
                  </span>
                )}
              </div>
              <p className="node-detail-key">{selectedNode.selected_version.authors.map((author) => author.name).join(", ") || selectedNode.selected_version.canonical_key}</p>
              <div className="node-detail-meta">
                {selectedNode.selected_version.venue && <span>{selectedNode.selected_version.venue}</span>}
                {selectedNode.selected_version.publication_date && (
                  <span>{selectedNode.selected_version.publication_date.slice(0, 4)}</span>
                )}
                {selectedNode.selected_version.version && (
                  <span>{selectedNode.selected_version.version}</span>
                )}
              </div>

              {selectedNode.versions.length > 1 && (
                <div className="graph-version-picker">
                  {selectedNode.versions.map((version: PaperMetadata) => {
                    const isActive = version.canonical_key === selectedNode.selected_version.canonical_key;
                    return (
                      <button
                        type="button"
                        key={version.canonical_key}
                        className={`graph-version-chip${isActive ? " active" : ""}`}
                        onClick={() =>
                          setSelectedVersions((current) => ({
                            ...current,
                            [selectedNode.paper_group_key]: version.canonical_key,
                          }))
                        }
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
                  onClick={() => {
                    const nextPaperKey = selectedNode.selected_version.canonical_key;
                    setSelectedVersions({});
                    setKey(nextPaperKey);
                    setSearchKey(nextPaperKey);
                    navigate(`/graph/${encodeURIComponent(nextPaperKey)}`, { replace: true });
                  }}
                >
                  Expand from here
                </button>
              </div>
            </div>
          )}

          <div className="graph-legend">
            <span><span className="legend-dot seed" /> Seed group</span>
            <span><span className="legend-dot grouped" /> Grouped paper</span>
            <span><span className="legend-dot" /> Single paper</span>
            <span><span className="legend-line solid" /> Cites</span>
            <span><span className="legend-line dashed" /> Similar</span>
          </div>
        </div>
      )}

      {!searchKey && (
        <div className="card" style={{ padding: "2rem", textAlign: "center" }}>
          <p style={{ color: "var(--color-text-secondary)" }}>
            Enter a paper key above or double-click a node to explore its citation neighborhood.
          </p>
        </div>
      )}
    </div>
  );
}

function truncateLabel(label: string, maxLength: number) {
  return label.length > maxLength ? `${label.slice(0, maxLength)}…` : label;
}
