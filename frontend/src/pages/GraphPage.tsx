import { useCollectionAccess, collectionRead } from "@/lib/collection-access";
import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import type { AxiosError } from "axios";
import { graph as graphApi, library } from "@/lib/api";
import { useAuth } from "@/contexts/AuthContext";
import CitationGraph, { type CitationGraphHandle } from "@/components/graph/CitationGraph";
import {
  EMPTY_GRAPH,
  mergeGraph,
  type ForceGraphData,
} from "@/components/graph/mergeGraph";
import PaperDetailsPanel from "@/components/paper/PaperDetailsPanel";
import EmptyState from "@/components/ui/EmptyState";
import VersionPicker from "@/components/search/VersionPicker";
import type {
  CitingOrder,
  ExpandRequest,
  GraphResponse,
  PaperMetadata,
  RelationDirection,
} from "@/types";
import {
  ArrowLeft,
  FileText,
  GitFork,
  Loader2,
  Maximize2,
  Plus,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import "./GraphPage.css";

export type GraphMode = "manual" | "paper" | "collection" | "library";

export default function GraphPage({ mode }: { mode: GraphMode }) {
  const { t } = useTranslation();
  const { user, isLoading: authLoading } = useAuth();
  const { paperKey, collectionId } = useParams<{ paperKey: string; collectionId: string }>();
  const navigate = useNavigate();
  const access = useCollectionAccess(collectionId);
  const currentScope = useRef<string>(access.scope);

  const paramKey =
    mode === "paper"
      ? paperKey
        ? decodeURIComponent(paperKey)
        : ""
      : mode === "collection"
        ? collectionId ?? ""
        : "";

  const [direction, setDirection] = useState<RelationDirection>("cited_by");
  const [order, setOrder] = useState<CitingOrder>("cited_by_count");
  const [limitPerNode, setLimitPerNode] = useState(25);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [detailsKey, setDetailsKey] = useState<string | null>(null);

  // The force-graph data lives in a ref: d3 mutates node objects in place
  // (positions, pins) and mergeGraph reuses them, so existing nodes never
  // jump on expansion. A version counter triggers React re-renders.
  const dataRef = useRef<ForceGraphData>(EMPTY_GRAPH);
  const [dataVersion, setDataVersion] = useState(0);
  const loadedScope = useRef("");
  const graphRef = useRef<CitationGraphHandle>(null);

  // ── Base graph load (paper / collection / library) ───────
  const baseEnabled =
    (mode === "paper" && !!paramKey) ||
    (mode === "collection" && !!paramKey) ||
    mode === "library";

  const baseQuery = useQuery<GraphResponse | null>({
    queryKey: ["graph-base", mode, paramKey, order, mode === "collection" ? access.scope : user?.id ?? "anonymous"],
    queryFn: () => {
      if (mode === "paper") return graphApi.buildPaper(paramKey, order);
      if (mode === "collection") return collectionRead(() => graphApi.buildCollection(paramKey, order, access.headers));
      return graphApi.buildLibrary(order);
    },
    enabled: baseEnabled && !authLoading,
    gcTime: 0, staleTime: 0, refetchOnWindowFocus: "always",
    // Provider retries/backoff happen on the server; don't multiply requests here.
    retry: false,
  });

  // Ignore late expansion responses after navigation or access revocation.
  currentScope.current = mode === "collection" && !baseQuery.data ? "" : access.scope;

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
    if (baseQuery.data === undefined) return;
    loadedScope.current = access.scope;
    if (baseQuery.data === null) { dataRef.current = EMPTY_GRAPH; setDataVersion((v) => v + 1); setSelectedNodeId(null); setDetailsKey(null); return; }
    dataRef.current = mergeGraph(EMPTY_GRAPH, {
      nodes: baseQuery.data.nodes,
      edges: baseQuery.data.edges,
    });
    setDataVersion((v) => v + 1);
    setSelectedNodeId(null);
  }, [baseQuery.data, access.scope]);

  // ── Expansion (from selection, or the whole graph) ───────
  const expandMutation = useMutation({
    mutationFn: async (body: ExpandRequest) => ({ data: await graphApi.expand(body), scope: access.scope }),
    onSuccess: ({ data, scope }, body) => {
      if (scope !== currentScope.current) return;
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
    (fromKeys: string[], focusKey: string | null, dir: RelationDirection) => {
      if (fromKeys.length === 0) return;
      expandMutation.mutate({
        from_keys: fromKeys,
        focus_key: focusKey,
        existing_group_keys: dataRef.current.nodes.map((n) => n.id),
        direction: dir,
        order,
        limit_per_node: limitPerNode,
      });
    },
    [expandMutation, order, limitPerNode],
  );

  const nodes = dataRef.current.nodes;
  const links = dataRef.current.links;
  const selectedNode = nodes.find((n) => n.id === selectedNodeId)?.node ?? null;
  const isExpanding = expandMutation.isPending;
  const hasGraph = nodes.length > 0 && (mode !== "collection" || (!!baseQuery.data && loadedScope.current === access.scope));
  const graphError = baseQuery.error ?? expandMutation.error;
  const errorDetail = (graphError as AxiosError<{ detail?: unknown }> | null)?.response?.data?.detail;
  const errorMessage = typeof errorDetail === "string" ? errorDetail : t("graph.errorFallback");
  void dataVersion; // re-render trigger

  const handleExpand = () => {
    if (selectedNode) {
      const key = selectedNode.selected_version.canonical_key;
      expandFromKeys([key], key, direction);
    } else {
      expandFromKeys(
        nodes.map((n) => n.node.selected_version.canonical_key),
        null,
        direction,
      );
    }
  };

  const handleSelectVersion = (groupKey: string, version: PaperMetadata) => {
    const node = dataRef.current.nodes.find((n) => n.id === groupKey);
    if (node) {
      node.node = { ...node.node, selected_version: version };
      setDataVersion((v) => v + 1);
    }
  };

  const modeLabel =
    mode === "paper"
      ? t("graph.modePaper")
      : mode === "collection"
        ? t("graph.modeCollection")
        : mode === "library"
          ? t("graph.modeLibrary")
          : "";

  // Manual /graph route: no seed — point the user at the entry points.
  if (mode === "manual") {
    return (
      <div className="graph-empty">
        <EmptyState
          icon={GitFork}
          title={t("graph.title")}
          description={t("graph.manualHint")}
          action={
            <Link to="/search" className="btn btn-primary">
              {t("nav.search")}
            </Link>
          }
        />
      </div>
    );
  }

  if (mode === "collection" && baseQuery.data === null) return <div role="alert"><p>{t("sharing.unavailable")}</p><Link to={`/collections/${collectionId}${access.fragment}`}>{t("graph.back")}</Link></div>;

  return (
    <div className="graph-screen" data-testid="graph-screen">
      {hasGraph && (
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
              expandFromKeys([key], key, direction);
            }
          }}
          onBackgroundClick={() => setSelectedNodeId(null)}
        />
      )}

      {baseQuery.isLoading && (
        <div className="graph-center-status">
          <Loader2 size={18} className="spin" /> {t("graph.loading")}
        </div>
      )}

      {graphError && (
        <div className="graph-error" role="alert">
          <span>{errorMessage}</span>
          <button
            type="button"
            className="btn btn-secondary"
            disabled={baseQuery.isFetching || isExpanding}
            onClick={() => {
              if (baseQuery.error) void baseQuery.refetch();
              else if (expandMutation.variables) expandMutation.mutate(expandMutation.variables);
            }}
          >
            {t("graph.retry")}
          </button>
        </div>
      )}

      {baseQuery.data && !hasGraph && !baseQuery.isLoading && (
        <div className="graph-empty">
          <EmptyState
            icon={GitFork}
            title={t("graph.title")}
            description={
              mode === "collection" || mode === "library"
                ? t("graph.emptyCollection")
                : t("graph.emptyPaper")
            }
          />
        </div>
      )}

      {/* Top-left: back + context */}
      <div className="graph-overlay graph-overlay--tl">
        <button
          type="button"
          className="btn-ghost graph-back"
          onClick={() => mode === "collection" ? navigate(`/collections/${collectionId}${access.fragment}`) : navigate(-1)}
          title={t("graph.back")}
        >
          <ArrowLeft size={16} />
        </button>
        <span className="graph-chip">
          {t("graph.title")}
          {modeLabel && <span className="graph-chip-mode">{modeLabel}</span>}
        </span>
        {hasGraph && (
          <span className="graph-counts">
            {t("graph.nodesEdges", { nodes: nodes.length, edges: links.length })}
          </span>
        )}
      </div>

      {/* Top-right: view controls */}
      {hasGraph && (
        <div className="graph-overlay graph-overlay--tr">
          <button onClick={() => graphRef.current?.zoomIn()} title={t("graph.zoomIn")}>
            <ZoomIn size={15} />
          </button>
          <button onClick={() => graphRef.current?.zoomOut()} title={t("graph.zoomOut")}>
            <ZoomOut size={15} />
          </button>
          <button onClick={() => graphRef.current?.fit()} title={t("graph.fit")}>
            <Maximize2 size={15} />
          </button>
        </div>
      )}

      {/* Bottom-center: expansion bar */}
      {hasGraph && (
        <div className="graph-expandbar" data-testid="expand-bar">
          <div className="segmented" role="group" aria-label={t("graph.expandCiters")}>
            <button
              type="button"
              className={direction === "cited_by" ? "active" : ""}
              onClick={() => setDirection("cited_by")}
              title={t("graph.citersTitle")}
            >
              {t("graph.citers")}
            </button>
            <button
              type="button"
              className={direction === "cites" ? "active" : ""}
              onClick={() => setDirection("cites")}
              title={t("graph.referencesTitle")}
            >
              {t("graph.references")}
            </button>
          </div>

          <div className="segmented" role="group" aria-label={t("graph.topCited")}>
            <button
              type="button"
              className={order === "cited_by_count" ? "active" : ""}
              onClick={() => setOrder("cited_by_count")}
              title={t("graph.topCitedTitle")}
            >
              {t("graph.topCited")}
            </button>
            <button
              type="button"
              className={order === "recent" ? "active" : ""}
              onClick={() => setOrder("recent")}
              title={t("graph.mostRecentTitle")}
            >
              {t("graph.mostRecent")}
            </button>
          </div>

          <select
            className="input graph-limit"
            value={limitPerNode}
            onChange={(e) => setLimitPerNode(Number(e.target.value))}
            aria-label={t("graph.perExpansion")}
          >
            {[10, 25, 50].map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>

          <button
            type="button"
            className="btn btn-primary graph-expand-btn"
            onClick={handleExpand}
            disabled={isExpanding}
          >
            {isExpanding ? <Loader2 size={14} className="spin" /> : <Plus size={14} />}
            {selectedNode ? t("graph.expandSelection") : t("graph.expandAll")}
          </button>
        </div>
      )}

      {/* Right: selected node card */}
      {hasGraph && selectedNode && (
        <div className="graph-node-card card">
          <h4>{selectedNode.selected_version.title}</h4>
          <p className="graph-node-authors">
            {selectedNode.selected_version.authors.map((a) => a.name).join(", ")}
          </p>
          <p className="graph-node-meta">
            {[
              selectedNode.selected_version.venue,
              selectedNode.selected_version.publication_date?.slice(0, 4),
              typeof selectedNode.selected_version.cited_by_count === "number"
                ? t("paper.citations", { count: selectedNode.selected_version.cited_by_count })
                : null,
            ]
              .filter(Boolean)
              .join(" · ")}
          </p>

          {selectedNode.versions.length > 1 && (
            <VersionPicker
              versions={selectedNode.versions}
              selectedKey={selectedNode.selected_version.canonical_key}
              onSelect={(version) =>
                handleSelectVersion(selectedNode.paper_group_key, version)
              }
            />
          )}

          <div className="graph-node-actions">
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => setDetailsKey(selectedNode.selected_version.canonical_key)}
            >
              <FileText size={13} />
              {t("paper.viewDetails")}
            </button>
          </div>
        </div>
      )}

      {/* Bottom-left: collapsible legend */}
      {hasGraph && (
        <details className="graph-legend">
          <summary>{t("graph.legend")}</summary>
          <div className="graph-legend-body">
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
              <span className="legend-line" /> {t("graph.legendEdge")}
            </span>
            <span className="legend-hint">{t("graph.dragHint")}</span>
          </div>
        </details>
      )}

      <PaperDetailsPanel paperKey={hasGraph ? detailsKey : null} onClose={() => setDetailsKey(null)} />
    </div>
  );
}
