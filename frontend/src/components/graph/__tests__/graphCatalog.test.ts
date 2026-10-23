import { describe, it, expect } from "vitest";
import { GraphCatalog, syncForceData } from "@/components/graph/graphCatalog";
import {
  explorationReducer,
  initialExplorationState,
  type ExplorationState,
  type PendingRange,
} from "@/components/graph/graphExploration";
import { EMPTY_GRAPH, linkKey } from "@/components/graph/mergeGraph";
import type { GraphEdge, GraphNode, GraphResponse, PaperDetail, PaperMetadata, RelatedRangeResponse } from "@/types";

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

/** A node served with list data only: its version's title is its key. */
function pendingNode(id: string, extra: PaperMetadata[] = []): GraphNode {
  const listData: PaperMetadata = { ...version(id), canonical_key: `doi:10.1/${id}`, title: `doi:10.1/${id}`, cited_by_count: 42 };
  const versions = [listData, ...extra];
  return { ...node(id, versions), label: null, details_pending: true };
}

/** The full record of a pending node's version. */
function fullNode(id: string, extra: PaperMetadata[] = []): GraphNode {
  const full: PaperMetadata = { ...version(id), canonical_key: `doi:10.1/${id}`, title: `Title of ${id}` };
  return node(id, [full, ...extra]);
}

describe("GraphCatalog details", () => {
  it("replaces a node whose details are pending with one that has them", () => {
    const catalog = new GraphCatalog();
    catalog.add({ nodes: [{ ...pendingNode("g"), is_seed: true }], edges: [] });
    catalog.add({ nodes: [fullNode("g")], edges: [] });
    const merged = catalog.getNode("g")!;
    expect(merged.selected_version.title).toBe("Title of g");
    expect(merged.details_pending).toBeFalsy();
    expect(merged.is_seed).toBe(true);
    expect(catalog.hasPendingDetails("g")).toBe(false);
  });

  it("keeps the selected version when the details arrive", () => {
    const catalog = new GraphCatalog();
    const preprint = version("g", "-preprint");
    catalog.add({ nodes: [pendingNode("g", [preprint])], edges: [] });
    catalog.selectVersion("g", preprint.canonical_key);
    catalog.add({ nodes: [fullNode("g", [preprint])], edges: [] });
    expect(catalog.getNode("g")!.selected_version.canonical_key).toBe(preprint.canonical_key);
    expect(catalog.getNode("g")!.versions[0]!.title).toBe("Title of g");
  });

  it("never lets list data replace full details, even with more versions", () => {
    const catalog = new GraphCatalog();
    const full = fullNode("g");
    catalog.add({ nodes: [full], edges: [] });
    catalog.add({ nodes: [pendingNode("g", [version("g", "-v2")])], edges: [] });
    expect(catalog.getNode("g")).toBe(full);
  });

  it("merges a refresh into pending nodes only, adding nothing", () => {
    const catalog = new GraphCatalog();
    const done = fullNode("done");
    catalog.add({ nodes: [pendingNode("a"), done], edges: [] });
    const changed = catalog.mergeDetails([fullNode("a"), fullNode("done"), fullNode("stranger"), pendingNode("b")]);
    expect(changed).toBe(true);
    expect(catalog.getNode("a")!.selected_version.title).toBe("Title of a");
    expect(catalog.getNode("done")).toBe(done);
    expect(catalog.getNode("stranger")).toBeUndefined();
    expect(catalog.getNode("b")).toBeUndefined();
    expect(catalog.mergeDetails([pendingNode("a")])).toBe(false);
  });

  it("marks pending nodes unavailable and clears the mark, with a new payload each time", () => {
    const catalog = new GraphCatalog();
    catalog.add({ nodes: [pendingNode("a"), fullNode("b")], edges: [] });
    const before = catalog.getNode("a");
    expect(catalog.markDetailsUnavailable(["a", "b", "missing"], true)).toBe(true);
    expect(catalog.getNode("a")).not.toBe(before);
    expect(catalog.getNode("a")!.detailsUnavailable).toBe(true);
    expect(catalog.getNode("b")!.detailsUnavailable).toBeUndefined();
    expect(catalog.markDetailsUnavailable(["a"], true)).toBe(false);
    expect(catalog.markDetailsUnavailable(["a"], false)).toBe(true);
    expect(catalog.getNode("a")!.detailsUnavailable).toBe(false);
  });

  it("patches a pending node with the record the details panel loaded", () => {
    const catalog = new GraphCatalog();
    catalog.add({ nodes: [{ ...pendingNode("a"), is_seed: false }], edges: [] });
    catalog.markDetailsUnavailable(["a"], true);
    const record: PaperDetail = {
      ...version("stored"),
      canonical_key: "doi:10.1/a-stored",
      title: "The real title",
      cited_by_count: 7,
      versions: [version("other")],
    };
    expect(catalog.patchDetails("doi:10.1/elsewhere", record)).toBe(false);
    expect(catalog.patchDetails("doi:10.1/a", record)).toBe(true);
    const patched = catalog.getNode("a")!;
    expect(patched.selected_version.title).toBe("The real title");
    // The node's key, group and ranking count (its size) stay.
    expect(patched.selected_version.canonical_key).toBe("doi:10.1/a");
    expect(patched.selected_version.paper_group_key).toBe("a");
    expect(patched.selected_version.cited_by_count).toBe(42);
    expect(patched.selected_version).not.toHaveProperty("versions");
    expect(patched.versions).toHaveLength(1);
    expect(patched.label).toBe("The real title");
    expect(patched.details_pending).toBe(false);
    expect(catalog.hasPendingDetails("a")).toBe(false);
    // A node that has its details is left alone.
    expect(catalog.patchDetails("doi:10.1/a", { ...record, title: "Other" })).toBe(false);
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
    const bigger = { ...version("g", "-v3"), cited_by_count: 5000 };
    const { state, catalog } = setup(baseOf([node("g", [version("g", "-v1"), version("g", "-v2"), bigger], true)]));
    const first = syncForceData(EMPTY_GRAPH, state, catalog, null);
    const forceNode = first.nodes[0]!;
    // Same size: the data stays (no re-heat), the node shows the version.
    catalog.selectVersion("g", "hash:g-v2");
    expect(syncForceData(first, state, catalog, null)).toBe(first);
    expect(forceNode.node.selected_version.canonical_key).toBe("hash:g-v2");
    // Another size: new data, so the engine sizes the node's collisions anew.
    catalog.selectVersion("g", "hash:g-v3");
    const second = syncForceData(first, state, catalog, null);
    expect(second).not.toBe(first);
    expect(second.nodes[0]).toBe(forceNode);
    expect(forceNode.node.selected_version.canonical_key).toBe("hash:g-v3");
  });

  it("keeps the data itself when details arrive, so the layout is never re-heated", () => {
    const { state: initial, catalog } = setup(baseOf([node("s", undefined, true)]));
    const state = applyRange(initial, catalog, rangeOf("s", ["a", "b", "c"], [pendingNode("a"), pendingNode("b"), pendingNode("c")]));
    const first = syncForceData(EMPTY_GRAPH, state, catalog, "s");
    const [a, b, c] = ["a", "b", "c"].map((id) => first.nodes.find((n) => n.id === id)!);
    // The server sizes a node by its ranking count, list data or not.
    const ranked = (item: GraphNode): GraphNode => {
      const versions = item.versions.map((v) => ({ ...v, cited_by_count: 42 }));
      return { ...item, selected_version: versions[0]!, versions };
    };

    expect(catalog.mergeDetails([ranked(fullNode("a"))])).toBe(true);
    expect(catalog.markDetailsUnavailable(["b"], true)).toBe(true);
    expect(
      catalog.patchDetails("doi:10.1/c", { ...version("c"), title: "Title of c", cited_by_count: 9, versions: [] } as PaperDetail),
    ).toBe(true);

    expect(syncForceData(first, state, catalog, "s")).toBe(first);
    expect(a!.node.selected_version.title).toBe("Title of a");
    expect(b!.node).toBe(catalog.getNode("b"));
    expect(c!.node.selected_version.title).toBe("Title of c");
    expect(first.nodes.every((forceNode) => forceNode.node === catalog.getNode(forceNode.id))).toBe(true);
  });
});
