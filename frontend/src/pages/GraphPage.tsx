import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { graph as graphApi, library } from "@/lib/api";
import { useAuth } from "@/contexts/AuthContext";
import CitationGraph, { type CitationGraphHandle } from "@/components/graph/CitationGraph";
import {
  EMPTY_GRAPH,
  mergeGraph,
  type ForceGraphData,
} from "@/components/graph/mergeGraph";
import PaperDetailsPanel from "@/components/paper/PaperDetailsPanel";
import { providerLabel } from "@/components/paper/PaperCard";
import type {
  CitingOrder,
  ExpandRequest,
  GraphResponse,
  PaperMetadata,
  RelationDirection,
} from "@/types";
import {
  FileText,
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

export default function GraphPage({ mode }: { mode: GraphMode }) {
  const { t } = useTranslation();
  const { user } = useAuth();
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
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [detailsKey, setDetailsKey] = useState<string | null>(null);

  // The force-graph data lives in a ref: d3 mutates node objects in place
  // (positions, pins) and mergeGraph reuses them, so existing nodes never
  // jump on expansion. A version counter triggers React re-renders.
  const dataRef = useRef<ForceGraphData>(EMPTY_GRAPH);
  const [dataVersion, setDataVersion] = useState(0);
  const graphRef = useRef<CitationGraphHandle>(null);

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

  // Library membership colors saved nodes green (authed only).
  const { data: libraryKeys } = useQuery({
    queryKey: ["library-keys"],
    queryFn: () => library.listKeys(),
    enabled: !!user,
    staleTime: 30_000,
  });
  const savedGroupKeys = new Set(libraryKeys ?? []);

  // Reset the accumulated graph whenever a fresh base arrives (also on
  // order change). Seeds load un-expanded — the user picks a direction.
  useEffect(() => {
    if (!baseQuery.data) return;
    dataRef.current = mergeGraph(EMPTY_GRAPH, {
      nodes: baseQuery.data.nodes,
      edges: baseQuery.data.edges,
    });
    setDataVersion((v) => v + 1);
    setSelectedNodeId(null);
  }, [baseQuery.data]);

  // ── Expansion (focused or global) ────────────────────────
  const expandMutation = useMutation({
    mutationFn: (body: ExpandRequest) => graphApi.expand(body),
    onSuccess: (data, body) => {
      const anchorGroup = body.focus_key
        ? dataRef.current.nodes.find(
            (n) => n.node.selected_version.canonical_key === body.focus_key,
          )?.id
        : null;
      dataRef.current = mergeGraph(dataRef.current, data, anchorGroup);
      setDataVersion((v) => v + 1);
      // Gentle local relaxation only — the rest of the map stays put.
      graphRef.current?.reheat();
    },
  });

  const expandFromKeys = useCallback(
    (fromKeys: string[], focusKey: string | null, direction: RelationDirection) => {
      if (fromKeys.length === 0) return;
      expandMutation.mutate({
        from_keys: fromKeys,
        focus_key: focusKey,
        existing_group_keys: dataRef.current.nodes.map((n) => n.id),
        direction,
        order,
        limit_per_node: limitPerNode,
      });
    },
    [expandMutation, order, limitPerNode],
  );

  const handleExploreKey = () => {
    const trimmed = keyInput.trim();
    if (!trimmed) return;
    navigate(`/graph/${encodeURIComponent(trimmed)}`);
  };

  const handleSelectVersion = (groupKey: string, version: PaperMetadata) => {
    const node = dataRef.current.nodes.find((n) => n.id === groupKey);
    if (node) {
      node.node = { ...node.node, selected_version: version };
      setDataVersion((v) => v + 1);
    }
  };

  const nodes = dataRef.current.nodes;
  const links = dataRef.current.links;
  const selectedNode = nodes.find((n) => n.id === selectedNodeId)?.node ?? null;
  const isExpanding = expandMutation.isPending;
  const hasGraph = nodes.length > 0;
  void dataVersion; // re-render trigger

  const modeLabel =
    mode === "paper"
      ? t("graph.modePaper")
      : mode === "collection"
        ? t("graph.modeCollection")
        : mode === "library"
          ? t("graph.modeLibrary")
          : "";

  return (
    <div className="graph-page">
      <h1>
        {t("graph.title")}
        {modeLabel && <span className="graph-mode-badge">{modeLabel}</span>}
      </h1>

      <div className="graph-controls">
        <div className="graph-search">
          <input
            className="input"
            placeholder={t("graph.keyPlaceholder")}
            value={keyInput}
            onChange={(e) => setKeyInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleExploreKey()}
          />
          <button className="btn btn-primary" onClick={handleExploreKey}>
            {t("graph.explore")}
          </button>
        </div>

        <div className="graph-params">
          <div className="graph-order-toggle" role="group" aria-label={t("graph.perExpansion")}>
            <button
              className={order === "cited_by_count" ? "active" : ""}
              onClick={() => setOrder("cited_by_count")}
              title={t("graph.topCitedTitle")}
            >
              {t("graph.topCited")}
            </button>
            <button
              className={order === "recent" ? "active" : ""}
              onClick={() => setOrder("recent")}
              title={t("graph.mostRecentTitle")}
            >
              {t("graph.mostRecent")}
            </button>
          </div>
          <label>
            {t("graph.perExpansion")}
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
              expandFromKeys(
                nodes.map((n) => n.node.selected_version.canonical_key),
                null,
                "cited_by",
              )
            }
            disabled={!hasGraph || isExpanding}
            title={t("graph.expandCitersTitle")}
          >
            {isExpanding ? <Loader2 size={14} className="spin" /> : <Plus size={14} />}
            {t("graph.expandCiters")}
          </button>
          <button
            className="btn btn-secondary"
            onClick={() =>
              expandFromKeys(
                nodes.map((n) => n.node.selected_version.canonical_key),
                null,
                "cites",
              )
            }
            disabled={!hasGraph || isExpanding}
            title={t("graph.expandReferencesTitle")}
          >
            {isExpanding ? <Loader2 size={14} className="spin" /> : <Plus size={14} />}
            {t("graph.expandReferences")}
          </button>
        </div>
      </div>

      {baseQuery.isLoading && <p className="graph-status">{t("graph.loading")}</p>}

      {baseQuery.data && !hasGraph && !baseQuery.isLoading && (
        <div className="card" style={{ padding: "2rem", textAlign: "center" }}>
          <p className="graph-status" style={{ padding: 0 }}>
            {mode === "collection" || mode === "library"
              ? t("graph.emptyCollection")
              : t("graph.emptyPaper")}
          </p>
        </div>
      )}

      {hasGraph && (
        <div className="graph-viewport">
          <div className="graph-toolbar">
            <button onClick={() => graphRef.current?.zoomIn()} title={t("graph.zoomIn")}>
              <ZoomIn size={16} />
            </button>
            <button onClick={() => graphRef.current?.zoomOut()} title={t("graph.zoomOut")}>
              <ZoomOut size={16} />
            </button>
            <button onClick={() => graphRef.current?.fit()} title={t("graph.fit")}>
              <Maximize2 size={16} />
            </button>
            <button onClick={() => graphRef.current?.reheat()} title={t("graph.reheat")}>
              <RotateCcw size={16} />
            </button>
            <span className="graph-info-badge">
              {isExpanding && `${t("graph.expanding")} · `}
              {t("graph.nodesEdges", { nodes: nodes.length, edges: links.length })}
            </span>
          </div>

          <CitationGraph
            ref={graphRef}
            data={dataRef.current}
            selectedId={selectedNodeId}
            savedGroupKeys={savedGroupKeys}
            onNodeClick={setSelectedNodeId}
            onNodeDoubleClick={(id) => {
              const node = dataRef.current.nodes.find((n) => n.id === id);
              if (node) {
                const key = node.node.selected_version.canonical_key;
                expandFromKeys([key], key, "cited_by");
              }
            }}
            onBackgroundClick={() => setSelectedNodeId(null)}
          />

          {selectedNode && (
            <div className="graph-node-detail card">
              <div className="graph-node-header">
                <h4>{selectedNode.selected_version.title}</h4>
                {selectedNode.version_count > 1 && (
                  <span className="graph-node-badge">
                    <Layers3 size={12} />
                    {t("paper.versions", { count: selectedNode.version_count })}
                  </span>
                )}
              </div>
              <p className="node-detail-key">
                {selectedNode.selected_version.authors.map((a) => a.name).join(", ") ||
                  selectedNode.selected_version.canonical_key}
              </p>
              <div className="node-detail-meta">
                {selectedNode.selected_version.venue && (
                  <span>{selectedNode.selected_version.venue}</span>
                )}
                {selectedNode.selected_version.publication_date && (
                  <span>{selectedNode.selected_version.publication_date.slice(0, 4)}</span>
                )}
                {typeof selectedNode.selected_version.cited_by_count === "number" && (
                  <span>
                    {t("paper.citations", {
                      count: selectedNode.selected_version.cited_by_count,
                    })}
                  </span>
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
                        <span>
                          {version.version ||
                            version.publication_date?.slice(0, 4) ||
                            t("paper.undated")}
                        </span>
                        <span>{providerLabel(version.provider_source)}</span>
                      </button>
                    );
                  })}
                </div>
              )}

              <div className="node-detail-actions">
                <button
                  className="btn btn-secondary"
                  disabled={isExpanding}
                  title={t("graph.citersTitle")}
                  onClick={() =>
                    expandFromKeys(
                      [selectedNode.selected_version.canonical_key],
                      selectedNode.selected_version.canonical_key,
                      "cited_by",
                    )
                  }
                >
                  {isExpanding ? <Loader2 size={14} className="spin" /> : <Plus size={14} />}
                  {t("graph.citers")}
                </button>
                <button
                  className="btn btn-secondary"
                  disabled={isExpanding}
                  title={t("graph.referencesTitle")}
                  onClick={() =>
                    expandFromKeys(
                      [selectedNode.selected_version.canonical_key],
                      selectedNode.selected_version.canonical_key,
                      "cites",
                    )
                  }
                >
                  {isExpanding ? <Loader2 size={14} className="spin" /> : <Plus size={14} />}
                  {t("graph.references")}
                </button>
                <button
                  className="btn btn-secondary"
                  title={t("paper.viewDetails")}
                  onClick={() => setDetailsKey(selectedNode.selected_version.canonical_key)}
                >
                  <FileText size={14} />
                  {t("paper.viewDetails")}
                </button>
              </div>
            </div>
          )}

          <div className="graph-legend">
            <span>
              <span className="legend-dot seed" /> {t("graph.legendSeed")}
            </span>
            <span>
              <span className="legend-dot saved" /> {t("graph.legendSaved")}
            </span>
            <span>
              <span className="legend-dot" /> {t("graph.legendPaper")}
            </span>
            <span>
              <span className="legend-line solid" /> {t("graph.legendEdge")}
            </span>
            <span className="legend-hint">{t("graph.dragHint")}</span>
          </div>
        </div>
      )}

      {mode === "manual" && !hasGraph && (
        <div className="card" style={{ padding: "2rem", textAlign: "center" }}>
          <p style={{ color: "var(--color-text-secondary)" }}>{t("graph.manualHint")}</p>
        </div>
      )}

      <PaperDetailsPanel paperKey={detailsKey} onClose={() => setDetailsKey(null)} />
    </div>
  );
}
