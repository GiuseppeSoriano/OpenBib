import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { GitFork } from "lucide-react";
import api, { graph as graphApi, library } from "@/lib/api";
import { apiStatus } from "@/lib/apiError";
import { COMPACT_QUERY, PHONE_MAX } from "@/lib/breakpoints";
import { collectionRead, useCollectionAccess } from "@/lib/collection-access";
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
import { errorText, noticeText, rankingStallText } from "@/components/graph/GraphStatus";
import type { RangeSelection } from "@/components/graph/RangeNavigator";
import { GraphCatalog, syncForceData } from "@/components/graph/graphCatalog";
import {
  currentBranch,
  modeSwitchAutoLoad,
  planTopUp,
  rangeControls,
  type ExplorationError,
  type Notice,
  type RankingStall,
} from "@/components/graph/graphExploration";
import { EMPTY_GRAPH, type ForceGraphData } from "@/components/graph/mergeGraph";
import { isUnresolved, paperDoi, paperTitle } from "@/components/graph/paperText";
import { useGraphExploration } from "@/components/graph/useGraphExploration";
import PaperDetailsPanel from "@/components/paper/PaperDetailsPanel";
import EmptyState from "@/components/ui/EmptyState";
import { useToast } from "@/components/ui/Toast";
import type { CitingOrder, Collection, GraphNode, GraphResponse, RelationDirection } from "@/types";
import "@/components/graph/graph.css";
import "./GraphPage.css";

export type GraphMode = "manual" | "paper" | "collection" | "library";
type SeededMode = Exclude<GraphMode, "manual">;
type CollectionAccess = ReturnType<typeof useCollectionAccess>;

export default function GraphPage({ mode }: { mode: GraphMode }) {
  const { paperKey, collectionId } = useParams<{ paperKey: string; collectionId: string }>();
  const { user } = useAuth();
  const access = useCollectionAccess(collectionId);
  if (mode === "manual") return <ManualGraph />;
  const paramKey =
    mode === "paper" ? (paperKey ? decodeURIComponent(paperKey) : "") : mode === "collection" ? collectionId ?? "" : "";
  // A collection graph belongs to its read capability and viewer (a new
  // share link, sign-in or sign-out changes the scope); the others to the viewer.
  const scope = mode === "collection" ? access.scope : user?.id ?? "anonymous";
  // A new seed or scope is a new session: exploration state, pins and layout reset.
  return <GraphExplorer key={`${mode}:${paramKey}:${scope}`} mode={mode} paramKey={paramKey} scope={scope} access={access} />;
}

/**
 * The /graph route has no seed: the graph header (home mark and title, no
 * Back since nothing precedes it) and the entry points.
 */
function ManualGraph() {
  const { t } = useTranslation();
  const compact = useMediaQuery(COMPACT_QUERY);
  return (
    <div className="graph-empty">
      <GraphHeader title={null} hasGraph={false} nodeCount={0} edgeCount={0} pinnedCount={0} compact={compact} />
      <EmptyState
        icon={GitFork}
        title={t("graph.manualTitle")}
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

function GraphExplorer({
  mode,
  paramKey,
  scope,
  access,
}: {
  mode: SeededMode;
  paramKey: string;
  scope: string;
  access: CollectionAccess;
}) {
  const { t } = useTranslation();
  const { user, isLoading: authLoading } = useAuth();
  const navigate = useNavigate();
  const compact = useMediaQuery(COMPACT_QUERY);
  const phone = useMediaQuery(`(max-width: ${PHONE_MAX}px)`);
  const { toast } = useToast();
  const baseEnabled = mode === "library" || !!paramKey;

  // The base graph is the seeds and the edges among them; ordering only
  // applies to related ranges, so switching it never refetches this.
  // A collection graph that is no longer readable resolves to null.
  const baseQuery = useQuery<GraphResponse | null>({
    queryKey: ["graph-base", mode, paramKey, scope],
    queryFn: () => {
      if (mode === "paper") return graphApi.buildPaper(paramKey);
      if (mode === "collection") return collectionRead(() => graphApi.buildCollection(paramKey, access.headers));
      return graphApi.buildLibrary();
    },
    enabled: baseEnabled && !authLoading,
    staleTime: Infinity,
    // A capability-scoped graph is never kept once the page leaves it.
    ...(mode === "collection" ? { gcTime: 0 } : {}),
    refetchOnWindowFocus: false,
    retry: (failureCount, error) => (apiStatus(error) ?? 0) >= 500 && failureCount < 1,
  });

  // Access to a shared collection can be withdrawn while its graph is open.
  // Rebuilding the graph on every focus would cost a rate-limited request, so
  // a light read of the collection checks it instead.
  const accessProbe = useQuery({
    queryKey: ["collection", paramKey, scope],
    queryFn: () =>
      collectionRead(
        async () =>
          (await api.get<Collection>(`/collections/${encodeURIComponent(paramKey)}`, { headers: access.headers })).data,
      ),
    enabled: mode === "collection" && baseEnabled && !authLoading,
    staleTime: 0,
    gcTime: 0,
    refetchOnWindowFocus: "always",
    retry: false,
  });
  const unavailable = mode === "collection" && (accessProbe.data === null || baseQuery.data === null);
  // Withdrawing the base aborts in-flight ranges and drops the exploration.
  const base = unavailable ? undefined : baseQuery.data ?? undefined;

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

  // The paper list opens beside the canvas only from the header's Papers
  // button (closed on arrival at every width) and stays as it was left
  // while the page is open, across desktop and compact layouts.
  const [papersOpen, setPapersOpen] = useState(false);
  const papersTriggerRef = useRef<HTMLButtonElement>(null);
  const closePapers = () => {
    setPapersOpen(false);
    papersTriggerRef.current?.focus();
  };
  // Compact "Graph controls" sheet. Its tab and every choice made in it live
  // here (or in the exploration), so reopening shows them unchanged.
  const [controlsOpen, setControlsOpen] = useState(false);
  const [sheetTab, setSheetTab] = useState<GraphSheetTab>("controls");
  const controlsTriggerRef = useRef<HTMLButtonElement>(null);
  const summaryTitleRef = useRef<HTMLButtonElement>(null);
  const sheetReturnRef = useRef<HTMLElement | null>(null);
  const [detailsKey, setDetailsKey] = useState<string | null>(null);
  const papersListId = useId();
  useEffect(() => {
    if (unavailable) setDetailsKey(null);
  }, [unavailable]);

  const selectedId = state.selectedId;
  const selectedNode = selectedId ? catalog.getNode(selectedId) ?? null : null;
  const selectedTitle = selectedNode ? paperTitle(selectedNode.selected_version, t) : null;
  const controls = selectedId ? rangeControls(state, selectedId) : null;
  const branch = selectedId ? currentBranch(state, selectedId) : undefined;
  const currentRangeIds = branch && branch.rangeIndex !== null ? branch.memberIds : [];
  const currentItem = controls?.loaded ? controls.items.find((item) => item.kind === "range" && item.current) : undefined;
  const currentRange = currentItem?.kind === "range" ? { start: currentItem.start, end: currentItem.end } : null;
  const visibleNodes = forceData.nodes.map((forceNode) => forceNode.node);
  const nodeCount = forceData.nodes.length;
  const edgeCount = forceData.links.length;
  const baseHasNodes = !!base && base.nodes.length > 0;
  // The exploration adopts the base in an effect: wait for it so pins and
  // counts never flash empty.
  const hasGraph = baseHasNodes && state.baseIds.size > 0;

  const seedNode = mode === "paper" && base ? base.nodes.find((node) => node.is_seed) ?? base.nodes[0] : undefined;
  const seedTitle = seedHeading(seedNode ? catalog.getNode(seedNode.id) ?? seedNode : undefined);
  // The serif title under "Citation graph": the seed, the collection or the library.
  let headerTitle: string | null = seedTitle;
  if (mode === "library") headerTitle = t("graph.titleLibrary");
  else if (mode === "collection") headerTitle = accessProbe.data?.name || t("graph.modeCollection");
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

  // "Explore from here": the paper's first range, 1–30. Loads it the first
  // time, goes back to it from a later range (or after pins changed) and
  // otherwise leaves the list as it is.
  const exploreFrom = (id: string) => {
    const paperControls = rangeControls(state, id);
    const shown = paperControls.items.find((item) => item.kind === "range" && item.current);
    if (!paperControls.loaded) exploration.loadFirstRangeFor(id);
    else if (paperControls.pinsChanged || (shown?.kind === "range" && shown.index !== 0)) exploration.loadRange({ index: 0 });
  };

  const sheetOpen = compact && controlsOpen;
  // Leaving compact unmounts the sheet: close it too, so it never reopens
  // (and takes focus) by itself when the screen turns compact again.
  useEffect(() => {
    if (!compact) setControlsOpen(false);
  }, [compact]);
  const openSheet =(opener: HTMLElement | null, tab?: GraphSheetTab) => {
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
  const lastStatusRef = useRef<{ error: ExplorationError | null; notice: Notice | null; stall: RankingStall | null }>({
    error: null,
    notice: null,
    stall: null,
  });
  useEffect(() => {
    const { error, notice, rankingStall: stall } = state;
    const last = lastStatusRef.current;
    lastStatusRef.current = { error, notice, stall };
    if (!sheetOpen) return;
    if (error && error !== last.error) toast(errorText(error, t, error.retryAfter ?? 0), "error");
    else if (stall && stall !== last.stall) toast(rankingStallText(stall, t), "info");
    else if (notice && notice !== last.notice) toast(noticeText(notice, t), "info");
  }, [state, sheetOpen, toast, t]);

  const expandActive = !!state.expand && state.expand.phase !== "confirm";
  const showSummary =
    !!selectedNode || !!state.pending || !!state.error || !!state.rankingStall || !!state.notice || expandActive;

  let baseState = null;
  if (unavailable) {
    baseState = <GraphBaseState status="unavailable" backTo={`/collections/${paramKey}${access.fragment}`} />;
  } else if (baseQuery.isError) {
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
        title={headerTitle}
        hasGraph={hasGraph}
        nodeCount={nodeCount}
        edgeCount={edgeCount}
        pinnedCount={state.pinned.size}
        compact={compact}
        onBack={() => (mode === "collection" ? navigate(`/collections/${paramKey}${access.fragment}`) : navigate(-1))}
        onZoomIn={() => graphRef.current?.zoomIn()}
        onZoomOut={() => graphRef.current?.zoomOut()}
        onFit={() => graphRef.current?.fit()}
        papersOpen={papersOpen}
        papersListId={papersListId}
        papersTriggerRef={papersTriggerRef}
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
            variant="drawer"
            nodes={visibleNodes}
            pinOrder={state.pinOrder}
            pinned={state.pinned}
            saved={savedGroupKeys}
            currentRangeIds={currentRangeIds}
            currentRange={currentRange}
            selectedId={selectedId}
            onSelect={selectFromList}
            onTogglePin={togglePin}
            onClose={closePapers}
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
              ariaLabel={canvasLabel}
              onNodeClick={exploration.select}
              onNodeDoubleClick={exploration.loadFirstRangeFor}
              onBackgroundClick={() => exploration.select(null)}
              onNodeDragPin={exploration.pinFromDrag}
            />
          )}
          {baseState}
          {!compact && hasGraph && selectedNode && (
            <GraphNodePopup
              node={selectedNode}
              pinned={state.pinned.has(selectedNode.id)}
              onTogglePin={() => togglePin(selectedNode.id)}
              onSelectVersion={(version) => exploration.versionChanged(selectedNode.id, version.canonical_key)}
              onViewDetails={() => setDetailsKey(selectedNode.selected_version.canonical_key)}
              onExplore={() => exploreFrom(selectedNode.id)}
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
          onContinueRanking={exploration.continueRanking}
        />
      )}

      {compact && hasGraph && showSummary && (
        <GraphSelectionSummary
          state={state}
          node={selectedNode}
          saved={!!selectedNode && savedGroupKeys.has(selectedNode.id)}
          rangeControls={controls}
          titleRef={summaryTitleRef}
          onTogglePin={() => selectedNode && togglePin(selectedNode.id)}
          onOpenPaper={() => openSheet(summaryTitleRef.current, "controls")}
          onRange={exploration.loadRange}
          onViewDetails={() => selectedNode && setDetailsKey(selectedNode.selected_version.canonical_key)}
          onRetry={exploration.retry}
          onDismiss={exploration.dismissNotice}
          onContinueRanking={exploration.continueRanking}
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
              onExplore={() => {
                if (!selectedNode) return;
                closeSheet();
                exploreFrom(selectedNode.id);
              }}
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
              saved={savedGroupKeys}
              currentRangeIds={currentRangeIds}
              currentRange={currentRange}
              selectedId={selectedId}
              onSelect={selectFromList}
              onTogglePin={togglePin}
            />
          }
        />
      )}

      <PaperDetailsPanel paperKey={unavailable ? null : detailsKey} onClose={() => setDetailsKey(null)} />
    </div>
  );
}
