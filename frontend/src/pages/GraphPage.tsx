import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { GitFork } from "lucide-react";
import { graph as graphApi, library } from "@/lib/api";
import { apiStatus } from "@/lib/apiError";
import { COMPACT_QUERY, PHONE_MAX } from "@/lib/breakpoints";
import { useMediaQuery } from "@/hooks/useMediaQuery";
import { useAuth } from "@/contexts/AuthContext";
import CitationGraph, { type CitationGraphHandle } from "@/components/graph/CitationGraph";
import GraphBaseState from "@/components/graph/GraphBaseState";
import GraphBottomBar from "@/components/graph/GraphBottomBar";
import GraphControlsSheet, { GraphSheetControls, type GraphSheetTab } from "@/components/graph/GraphControlsSheet";
import GraphHeader from "@/components/graph/GraphHeader";
import GraphLegend from "@/components/graph/GraphLegend";
import GraphNodePopup from "@/components/graph/GraphNodePopup";
import GraphPaperList from "@/components/graph/GraphPaperList";
import GraphSelectionSummary from "@/components/graph/GraphSelectionSummary";
import { errorText, noticeText } from "@/components/graph/GraphStatus";
import type { RangeSelection } from "@/components/graph/RangeNavigator";
import { GraphCatalog, syncForceData } from "@/components/graph/graphCatalog";
import {
  currentBranch,
  modeSwitchAutoLoad,
  planTopUp,
  rangeControls,
  type ExplorationError,
  type Notice,
} from "@/components/graph/graphExploration";
import { EMPTY_GRAPH, type ForceGraphData } from "@/components/graph/mergeGraph";
import { isUnresolved, paperDoi, paperTitle } from "@/components/graph/paperText";
import { useGraphExploration } from "@/components/graph/useGraphExploration";
import PaperDetailsPanel from "@/components/paper/PaperDetailsPanel";
import EmptyState from "@/components/ui/EmptyState";
import { useToast } from "@/components/ui/Toast";
import type { CitingOrder, GraphNode, GraphResponse, RelationDirection } from "@/types";
import "@/components/graph/graph.css";
import "./GraphPage.css";

export type GraphMode = "manual" | "paper" | "collection" | "library";
type SeededMode = Exclude<GraphMode, "manual">;

export default function GraphPage({ mode }: { mode: GraphMode }) {
  const { paperKey, collectionId } = useParams<{ paperKey: string; collectionId: string }>();
  if (mode === "manual") return <ManualGraph />;
  const paramKey =
    mode === "paper" ? (paperKey ? decodeURIComponent(paperKey) : "") : mode === "collection" ? collectionId ?? "" : "";
  // A new seed is a new session: exploration state, pins and layout reset.
  return <GraphExplorer key={`${mode}:${paramKey}`} mode={mode} paramKey={paramKey} />;
}

/** The /graph route has no seed: point the user at the entry points. */
function ManualGraph() {
  const { t } = useTranslation();
  return (
    <div className="graph-empty">
      <h1 className="sr-only">{t("graph.title")}</h1>
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

/** The seed's title for the page heading; a DOI (never a raw key) when unresolved. */
function seedHeading(node: GraphNode | undefined): string | null {
  if (!node) return null;
  const paper = node.selected_version;
  if (!isUnresolved(paper)) return paper.title || null;
  const doi = paperDoi(paper);
  return doi ? `DOI ${doi}` : null;
}

function GraphExplorer({ mode, paramKey }: { mode: SeededMode; paramKey: string }) {
  const { t } = useTranslation();
  const { user } = useAuth();
  const navigate = useNavigate();
  const compact = useMediaQuery(COMPACT_QUERY);
  const phone = useMediaQuery(`(max-width: ${PHONE_MAX}px)`);
  const { toast } = useToast();
  const baseEnabled = mode === "library" || !!paramKey;

  // The base graph is the seeds and the edges among them; ordering only
  // applies to related ranges, so switching it never refetches this.
  const baseQuery = useQuery<GraphResponse>({
    queryKey: ["graph-base", mode, paramKey],
    queryFn: () => {
      if (mode === "paper") return graphApi.buildPaper(paramKey);
      if (mode === "collection") return graphApi.buildCollection(paramKey);
      return graphApi.buildLibrary();
    },
    enabled: baseEnabled,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    retry: (failureCount, error) => (apiStatus(error) ?? 0) >= 500 && failureCount < 1,
  });
  const base = baseQuery.data;

  // Library membership colors saved nodes (signed-in users only).
  const { data: libraryKeys } = useQuery({
    queryKey: ["library-keys"],
    queryFn: () => library.listKeys(),
    enabled: !!user,
    staleTime: 30_000,
  });
  const savedGroupKeys = useMemo(() => new Set(libraryKeys ?? []), [libraryKeys]);

  const [catalog] = useState(() => new GraphCatalog());
  const exploration = useGraphExploration(base, catalog);
  const { state, catalogRevision } = exploration;

  // The force-graph data lives in a ref: d3 mutates node objects in place
  // (positions, pins) and syncForceData keeps surviving objects, so nodes
  // never jump when ranges change.
  const dataRef = useRef<ForceGraphData>(EMPTY_GRAPH);
  const forceData = useMemo(() => {
    void catalogRevision;
    dataRef.current = syncForceData(dataRef.current, state, catalog, state.anchorId);
    return dataRef.current;
  }, [state, catalogRevision, catalog]);

  const graphRef = useRef<CitationGraphHandle>(null);
  const nodeCountRef = useRef(0);
  useEffect(() => {
    // Gentle local relaxation when papers arrive; the rest stays put.
    if (nodeCountRef.current > 0 && forceData.nodes.length > nodeCountRef.current) graphRef.current?.reheat();
    nodeCountRef.current = forceData.nodes.length;
  }, [forceData]);

  const [papersOpen, setPapersOpen] = useState(false);
  // Compact "Graph controls" sheet. Its tab and every choice made in it live
  // here (or in the exploration), so reopening shows them unchanged.
  const [controlsOpen, setControlsOpen] = useState(false);
  const [sheetTab, setSheetTab] = useState<GraphSheetTab>("controls");
  const controlsTriggerRef = useRef<HTMLButtonElement>(null);
  const summaryTitleRef = useRef<HTMLButtonElement>(null);
  const sheetReturnRef = useRef<HTMLElement | null>(null);
  const [detailsKey, setDetailsKey] = useState<string | null>(null);
  const papersListId = useId();

  const selectedId = state.selectedId;
  const selectedNode = selectedId ? catalog.getNode(selectedId) ?? null : null;
  const selectedTitle = selectedNode ? paperTitle(selectedNode.selected_version, t) : null;
  const controls = selectedId ? rangeControls(state, selectedId) : null;
  const branch = selectedId ? currentBranch(state, selectedId) : undefined;
  const currentRangeIds = branch && branch.rangeIndex !== null ? branch.memberIds : [];
  const visibleNodes = forceData.nodes.map((forceNode) => forceNode.node);
  const nodeCount = forceData.nodes.length;
  const edgeCount = forceData.links.length;
  const baseHasNodes = !!base && base.nodes.length > 0;
  // The exploration adopts the base in an effect: wait for it so pins and
  // counts never flash empty.
  const hasGraph = baseHasNodes && state.baseIds.size > 0;

  // The selection, plus the pins while there are few, keep their labels at
  // every zoom level (small screens rarely zoom in far enough otherwise).
  const alwaysLabelIds = useMemo(() => {
    const ids = new Set<string>(state.pinned.size <= 5 ? state.pinned : []);
    if (selectedId) ids.add(selectedId);
    return ids;
  }, [state.pinned, selectedId]);

  const seedNode = mode === "paper" && base ? base.nodes.find((node) => node.is_seed) ?? base.nodes[0] : undefined;
  const seedTitle = seedHeading(seedNode ? catalog.getNode(seedNode.id) ?? seedNode : undefined);
  const canvasLabel = seedTitle
    ? t("graph.canvasLabelSeed", { title: seedTitle, nodes: nodeCount, edges: edgeCount })
    : t("graph.canvasLabel", { nodes: nodeCount, edges: edgeCount });

  // Pins are fixed in place on the canvas as well as in the state.
  const togglePin = (id: string) => {
    const wasPinned = state.pinned.has(id);
    exploration.togglePin(id);
    if (wasPinned) graphRef.current?.unpinNode(id);
    else graphRef.current?.pinNode(id);
  };

  const selectFromList = (id: string) => {
    exploration.select(id);
    graphRef.current?.focusNode(id);
  };

  const sheetOpen = compact && controlsOpen;
  const openSheet = (opener: HTMLElement | null, tab?: GraphSheetTab) => {
    sheetReturnRef.current = opener;
    if (tab) setSheetTab(tab);
    setControlsOpen(true);
  };
  const closeSheet = () => setControlsOpen(false);

  // Anything that loads data closes the sheet, so the canvas gets its space
  // back while the results arrive; the summary row shows the status.
  const loadRange = (selection: RangeSelection) => {
    closeSheet();
    exploration.loadRange(selection);
  };
  const setDirection = (direction: RelationDirection) => {
    if (direction !== state.mode.direction && modeSwitchAutoLoad(state)) closeSheet();
    exploration.setDirection(direction);
  };
  const setOrder = (order: CitingOrder) => {
    if (order !== state.mode.order && modeSwitchAutoLoad(state)) closeSheet();
    exploration.setOrder(order);
  };
  const expandPinned = () => {
    // A large run asks first, inside the sheet.
    if (!planTopUp(state).needsConfirmation) closeSheet();
    exploration.expandPinned();
  };
  const confirmExpand = () => {
    closeSheet();
    exploration.confirmExpand();
  };

  // The page behind an open sheet is inert, so the summary's live status is
  // not announced there: report new errors and notices as toasts instead.
  const lastStatusRef = useRef<{ error: ExplorationError | null; notice: Notice | null }>({
    error: null,
    notice: null,
  });
  useEffect(() => {
    const { error, notice } = state;
    const last = lastStatusRef.current;
    lastStatusRef.current = { error, notice };
    if (!sheetOpen) return;
    if (error && error !== last.error) toast(errorText(error, t, error.retryAfter ?? 0), "error");
    else if (notice && notice !== last.notice) toast(noticeText(notice, t), "info");
  }, [state, sheetOpen, toast, t]);

  const expandActive = !!state.expand && state.expand.phase !== "confirm";
  const showSummary = !!selectedNode || !!state.pending || !!state.error || !!state.notice || expandActive;

  let baseState = null;
  if (baseQuery.isError) {
    baseState = (
      <GraphBaseState
        status="error"
        error={baseQuery.error}
        retrying={baseQuery.isFetching}
        onRetry={() => void baseQuery.refetch()}
      />
    );
  } else if (!base || (baseHasNodes && !hasGraph)) {
    baseState = baseEnabled ? <GraphBaseState status="loading" /> : null;
  } else if (!hasGraph) {
    baseState = (
      <GraphBaseState
        status="empty"
        description={mode === "paper" ? t("graph.emptyPaper") : t("graph.emptyCollection")}
      />
    );
  }

  return (
    <div className="graph-screen" data-testid="graph-screen">
      <GraphHeader
        mode={mode}
        seedTitle={seedTitle}
        hasGraph={hasGraph}
        nodeCount={nodeCount}
        edgeCount={edgeCount}
        pinnedCount={state.pinned.size}
        compact={compact}
        onBack={() => navigate(-1)}
        onZoomIn={() => graphRef.current?.zoomIn()}
        onZoomOut={() => graphRef.current?.zoomOut()}
        onFit={() => graphRef.current?.fit()}
        papersOpen={papersOpen}
        papersListId={papersListId}
        onTogglePapers={() => setPapersOpen((open) => !open)}
        controlsOpen={sheetOpen}
        controlsTriggerRef={controlsTriggerRef}
        onOpenControls={() => openSheet(controlsTriggerRef.current)}
      />

      <div className="graph-stage">
        {!compact && hasGraph && papersOpen && (
          <GraphPaperList
            id={papersListId}
            className="graph-drawer"
            nodes={visibleNodes}
            pinOrder={state.pinOrder}
            pinned={state.pinned}
            currentRangeIds={currentRangeIds}
            selectedId={selectedId}
            onSelect={selectFromList}
            onTogglePin={togglePin}
          />
        )}
        <div className="graph-canvas-wrap">
          {hasGraph && (
            <CitationGraph
              ref={graphRef}
              data={forceData}
              selectedId={selectedId}
              savedGroupKeys={savedGroupKeys}
              pinnedIds={state.pinned}
              alwaysLabelIds={alwaysLabelIds}
              ariaLabel={canvasLabel}
              onNodeClick={exploration.select}
              onNodeDoubleClick={exploration.loadFirstRangeFor}
              onBackgroundClick={() => exploration.select(null)}
              onNodeDragPin={exploration.pinFromDrag}
            />
          )}
          {baseState}
          {!compact && selectedNode && (
            <GraphNodePopup
              node={selectedNode}
              pinned={state.pinned.has(selectedNode.id)}
              onTogglePin={() => togglePin(selectedNode.id)}
              onSelectVersion={(version) => exploration.versionChanged(selectedNode.id, version.canonical_key)}
              onViewDetails={() => setDetailsKey(selectedNode.selected_version.canonical_key)}
            />
          )}
          {!compact && hasGraph && <GraphLegend />}
        </div>
      </div>

      {!compact && hasGraph && (
        <GraphBottomBar
          state={state}
          selectedTitle={selectedTitle}
          rangeControls={controls}
          onDirection={exploration.setDirection}
          onOrder={exploration.setOrder}
          onRange={exploration.loadRange}
          onExpand={exploration.expandPinned}
          onConfirmExpand={exploration.confirmExpand}
          onCancelExpand={exploration.cancelExpand}
          onRetry={exploration.retry}
          onDismiss={exploration.dismissNotice}
        />
      )}

      {compact && hasGraph && showSummary && (
        <GraphSelectionSummary
          state={state}
          node={selectedNode}
          rangeControls={controls}
          titleRef={summaryTitleRef}
          onTogglePin={() => selectedNode && togglePin(selectedNode.id)}
          onOpenPaper={() => openSheet(summaryTitleRef.current, "controls")}
          onRange={exploration.loadRange}
          onViewDetails={() => selectedNode && setDetailsKey(selectedNode.selected_version.canonical_key)}
          onRetry={exploration.retry}
          onDismiss={exploration.dismissNotice}
          onCancelExpand={exploration.cancelExpand}
        />
      )}

      {compact && hasGraph && (
        <GraphControlsSheet
          open={controlsOpen}
          onClose={closeSheet}
          placement={phone ? "bottom" : "auto"}
          returnFocusRef={sheetReturnRef}
          tab={sheetTab}
          onTabChange={setSheetTab}
          papersCount={nodeCount}
          controls={
            <GraphSheetControls
              state={state}
              node={selectedNode}
              rangeControls={controls}
              onTogglePin={() => selectedNode && togglePin(selectedNode.id)}
              onSelectVersion={(version) => selectedNode && exploration.versionChanged(selectedNode.id, version.canonical_key)}
              onViewDetails={() => selectedNode && setDetailsKey(selectedNode.selected_version.canonical_key)}
              onDirection={setDirection}
              onOrder={setOrder}
              onRange={loadRange}
              onExpand={expandPinned}
              onConfirmExpand={confirmExpand}
              onCancelExpand={exploration.cancelExpand}
              onZoomIn={() => graphRef.current?.zoomIn()}
              onZoomOut={() => graphRef.current?.zoomOut()}
            />
          }
          papers={
            <GraphPaperList
              className="graph-sheet-papers"
              nodes={visibleNodes}
              pinOrder={state.pinOrder}
              pinned={state.pinned}
              currentRangeIds={currentRangeIds}
              selectedId={selectedId}
              onSelect={selectFromList}
              onTogglePin={togglePin}
            />
          }
        />
      )}

      <PaperDetailsPanel paperKey={detailsKey} onClose={() => setDetailsKey(null)} />
    </div>
  );
}
