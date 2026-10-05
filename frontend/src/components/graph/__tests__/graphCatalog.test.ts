import { describe, it, expect } from "vitest";
import { GraphCatalog, syncForceData } from "@/components/graph/graphCatalog";
import {
  explorationReducer,
  initialExplorationState,
  type ExplorationState,
  type PendingRange,
} from "@/components/graph/graphExploration";
import { EMPTY_GRAPH, linkKey } from "@/components/graph/mergeGraph";
import type { GraphEdge, GraphNode, GraphResponse, PaperMetadata, RelatedRangeResponse } from "@/types";

function version(id: string, suffix = "", provider = "openalex"): PaperMetadata {
  return {
    canonical_key: `hash:${id}${suffix}`,
    paper_group_key: id,
    title: `${id}${suffix}`,
    authors: [],
    abstract: null,
    publication_date: null,
    doi: null,
    arxiv_id: null,
    venue: null,
    paper_type: null,
    topics: [],
    keywords: [],
    open_access: null,
    pdf_url: null,
    cited_by_count: 1,
    reference_count: null,
    provider_source: provider,
    provider_sources: [provider],
  };
}

function node(id: string, versions: PaperMetadata[] = [version(id)], isSeed = false): GraphNode {
  return {
    id,
    label: id,
    type: versions.length > 1 ? "paper_group" : "paper",
    paper_group_key: id,
    version_count: versions.length,
    selected_version: versions[0]!,
    versions,
    is_seed: isSeed,
  };
}

const citer = (item: string, source: string): GraphEdge => ({ source: item, target: source, relation_type: "cited_by" });

function rangeOf(source: string, keys: string[], nodes = keys.map((id) => node(id))): RelatedRangeResponse {
  return {
    source_key: `hash:${source}`,
    source_group_key: source,
    direction: "cited_by",
    order: "cited_by_count",
    nodes,
    edges: keys.map((id) => citer(id, source)),
    group_keys: keys,
    range_start: 0,
    range_end: keys.length,
    range_size: 30,
    max_results: 10000,
    total_available: keys.length,
    total_exact: true,
    total_capped: false,
    provider_total: keys.length,
    scanned: keys.length,
    has_more: false,
    exhausted: true,
    clamped: false,
    scan_incomplete: false,
    snapshot_id: null,
    reason: null,
  };
}

let seq = 0;

function applyRange(state: ExplorationState, catalog: GraphCatalog, response: RelatedRangeResponse): ExplorationState {
  const id = ++seq;
  const pending: PendingRange = {
    kind: "range",
    id,
    sourceId: response.source_group_key,
    sourceKey: response.source_key,
    mode: state.mode,
    rangeIndex: 0,
    last: false,
    pinEpoch: state.pinEpoch,
    unpinEpoch: state.unpinEpoch,
    autoContinue: 0,
    scanned: null,
    providerTotal: null,
  };
  catalog.add(response);
  const started = explorationReducer(state, { type: "requestStarted", pending, exclusionsCapped: false });
  return explorationReducer(started, { type: "rangeLoaded", id, response });
}

function setup(base: GraphResponse): { state: ExplorationState; catalog: GraphCatalog } {
  const catalog = new GraphCatalog();
  catalog.add(base);
  return { state: explorationReducer(initialExplorationState(), { type: "baseLoaded", base }), catalog };
}

const baseOf = (nodes: GraphNode[], edges: GraphEdge[] = []): GraphResponse => ({
  active_paper_key: nodes[0]!.selected_version.canonical_key,
  active_paper_group_key: nodes[0]!.id,
  nodes,
  edges,
});

describe("GraphCatalog", () => {
  it("never replaces a richer multi-version node with a single-version record", () => {
    const catalog = new GraphCatalog();
    const rich = node("g", [version("g", "-v1"), version("g", "-v2")], true);
    catalog.add({ nodes: [rich], edges: [] });
    catalog.add({ nodes: [node("g", [version("g", "-v2")])], edges: [] });
    expect(catalog.getNode("g")).toBe(rich);
  });

  it("upgrades to a richer record, keeping the seed flag and selected version", () => {
    const catalog = new GraphCatalog();
    catalog.add({ nodes: [node("g", [version("g", "-v2")], true)], edges: [] });
    const richer = node("g", [version("g", "-v1"), version("g", "-v2")]);
    catalog.add({ nodes: [richer], edges: [] });
    const merged = catalog.getNode("g")!;
    expect(merged.version_count).toBe(2);
    expect(merged.is_seed).toBe(true);
    expect(merged.selected_version.canonical_key).toBe("hash:g-v2");

    const unresolved = new GraphCatalog();
    unresolved.add({ nodes: [node("u", [version("u", "", "unknown")])], edges: [] });
    unresolved.add({ nodes: [node("u")], edges: [] });
    expect(unresolved.getNode("u")!.selected_version.provider_source).toBe("openalex");
  });

  it("selects versions and exposes the source key", () => {
    const catalog = new GraphCatalog();
    catalog.add({ nodes: [node("g", [version("g", "-v1"), version("g", "-v2")])], edges: [] });
    expect(catalog.sourceKey("g")).toBe("hash:g-v1");
    expect(catalog.selectVersion("g", "hash:g-v2")).toBe(true);
    expect(catalog.sourceKey("g")).toBe("hash:g-v2");
    expect(catalog.selectVersion("g", "hash:missing")).toBe(false);
    expect(catalog.sourceKey("unknown")).toBe("unknown");
  });
});

describe("syncForceData", () => {
  it("prunes retired members, then merges new ones, keeping survivors' identity", () => {
    const { state: initial, catalog } = setup(baseOf([node("s", undefined, true)]));
    let state = applyRange(initial, catalog, rangeOf("s", ["a", "b"]));
    const first = syncForceData(EMPTY_GRAPH, state, catalog, "s");
    expect(first.nodes.map((n) => n.id).sort()).toEqual(["a", "b", "s"]);
    expect(first.links).toHaveLength(2);
    const seed = first.nodes.find((n) => n.id === "s")!;
    seed.x = 10;
    seed.y = 20;

    state = explorationReducer(state, { type: "togglePin", id: "a" });
    state = applyRange(state, catalog, rangeOf("s", ["c"]));
    const second = syncForceData(first, state, catalog, "s");
    expect(second.nodes.map((n) => n.id).sort()).toEqual(["a", "c", "s"]);
    expect(second.nodes.find((n) => n.id === "s")).toBe(seed);
    expect(second.links.map(linkKey).sort()).toEqual([linkKey(citer("a", "s")), linkKey(citer("c", "s"))]);
    const spawned = second.nodes.find((n) => n.id === "c")!;
    expect(Math.hypot((spawned.x ?? 0) - 10, (spawned.y ?? 0) - 20)).toBeGreaterThanOrEqual(50);
  });

  it("returns the previous data when nothing changed", () => {
    const { state, catalog } = setup(baseOf([node("s", undefined, true), node("t")], [citer("t", "s")]));
    const first = syncForceData(EMPTY_GRAPH, state, catalog, null);
    expect(syncForceData(first, explorationReducer(state, { type: "select", id: "t" }), catalog, null)).toBe(first);
  });

  it("keeps a richer multi-version base node when a range returns it again", () => {
    const rich = node("g", [version("g", "-v1"), version("g", "-v2")]);
    const { state: initial, catalog } = setup(baseOf([node("s", undefined, true), rich]));
    const state = applyRange(initial, catalog, rangeOf("s", ["g"], [node("g", [version("g", "-v2")])]));
    const data = syncForceData(EMPTY_GRAPH, state, catalog, "s");
    expect(data.nodes.find((n) => n.id === "g")!.node).toBe(rich);
  });

  it("refreshes a surviving node's payload in place after a version change", () => {
    const { state, catalog } = setup(baseOf([node("g", [version("g", "-v1"), version("g", "-v2")], true)]));
    const first = syncForceData(EMPTY_GRAPH, state, catalog, null);
    const forceNode = first.nodes[0]!;
    catalog.selectVersion("g", "hash:g-v2");
    const second = syncForceData(first, state, catalog, null);
    expect(second).not.toBe(first);
    expect(second.nodes[0]).toBe(forceNode);
    expect(forceNode.node.selected_version.canonical_key).toBe("hash:g-v2");
  });
});
