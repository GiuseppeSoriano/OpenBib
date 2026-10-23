import { linkKey, mergeGraph, pruneGraph, type ForceGraphData } from "@/components/graph/mergeGraph";
import { visibleEdgeKeys, visibleNodeIds, type ExplorationState } from "@/components/graph/graphExploration";
import { hasPendingDetails, isListDataOnly, type DetailsMark } from "@/components/graph/paperText";
import type { GraphEdge, GraphNode, PaperDetail, PaperMetadata } from "@/types";

/** A node as the catalog keeps it: the server's payload plus client marks. */
export type CatalogNode = GraphNode & DetailsMark;

function isRicher(incoming: GraphNode, existing: GraphNode): boolean {
  // Full details beat list data only, whatever the version counts.
  const pending = hasPendingDetails(existing);
  if (pending !== hasPendingDetails(incoming)) return pending;
  if (incoming.version_count !== existing.version_count) return incoming.version_count > existing.version_count;
  return existing.selected_version.provider_source === "unknown" && incoming.selected_version.provider_source !== "unknown";
}

/** `incoming` in place of `existing`: the seed flag and the selected version stay. */
function replacement(incoming: GraphNode, existing: GraphNode): GraphNode {
  const selectedKey = existing.selected_version.canonical_key;
  return {
    ...incoming,
    is_seed: existing.is_seed || incoming.is_seed,
    selected_version: incoming.versions.find((version) => version.canonical_key === selectedKey) ?? incoming.selected_version,
  };
}

/**
 * Every node and edge fetched during one exploration session, by id / link
 * key. The exploration state decides what is visible; the catalog keeps the
 * payloads so a node that leaves the canvas can come back unchanged.
 */
export class GraphCatalog {
  readonly nodes = new Map<string, CatalogNode>();
  readonly edges = new Map<string, GraphEdge>();

  reset(): void {
    this.nodes.clear();
    this.edges.clear();
  }

  /**
   * An existing node is replaced only by a richer record (full details where
   * it had list data only, more versions, or resolved where it was not), so
   * a multi-version base node never degrades to the single-version record a
   * related range returns, and a node whose details were pending takes them
   * as soon as any response brings them. The replacement keeps the seed flag
   * and the version the user had selected (positions and pins live outside).
   */
  add(data: { nodes: GraphNode[]; edges: GraphEdge[] }): void {
    for (const node of data.nodes) {
      const existing = this.nodes.get(node.id);
      if (!existing) {
        this.nodes.set(node.id, node);
      } else if (isRicher(node, existing)) {
        this.nodes.set(node.id, replacement(node, existing));
      }
    }
    for (const edge of data.edges) {
      const key = linkKey(edge);
      if (!this.edges.has(key)) this.edges.set(key, edge);
    }
  }

  /**
   * Payloads of a background details refresh: a node already here whose
   * details are pending takes the incoming one when it has them. Nothing
   * else changes (no new node or edge). Returns whether a node changed.
   */
  mergeDetails(nodes: readonly GraphNode[]): boolean {
    let changed = false;
    for (const node of nodes) {
      const existing = this.nodes.get(node.id);
      if (existing && hasPendingDetails(existing) && !hasPendingDetails(node)) {
        this.nodes.set(node.id, replacement(node, existing));
        changed = true;
      }
    }
    return changed;
  }

  /** Whether the node is here and its selected version still waits for details. */
  hasPendingDetails(id: string): boolean {
    const node = this.nodes.get(id);
    return !!node && hasPendingDetails(node);
  }

  /**
   * Mark pending nodes whose details no refresh will bring (or clear the
   * mark when a new refresh starts). Returns whether a node changed.
   */
  markDetailsUnavailable(ids: Iterable<string>, unavailable: boolean): boolean {
    let changed = false;
    for (const id of ids) {
      const node = this.nodes.get(id);
      if (!node || !hasPendingDetails(node) || !!node.detailsUnavailable === unavailable) continue;
      const marked: CatalogNode = { ...node, detailsUnavailable: unavailable };
      this.nodes.set(id, marked);
      changed = true;
    }
    return changed;
  }

  /**
   * The full record of `canonicalKey` arrived (the details panel fetched
   * it): every pending node's list-data version of that key takes it. The
   * node keeps its ranking count (its size). Returns whether a node changed.
   */
  patchDetails(canonicalKey: string, detail: PaperDetail): boolean {
    // The record alone: its group's versions are the node's business.
    const { versions: groupVersions, ...record } = detail;
    void groupVersions;
    const stale = (version: PaperMetadata) => version.canonical_key === canonicalKey && isListDataOnly(version);
    let changed = false;
    for (const [id, node] of this.nodes) {
      const pending = node.versions.find(stale) ?? (stale(node.selected_version) ? node.selected_version : undefined);
      if (!hasPendingDetails(node) || !pending) continue;
      // The node's key and group stay (the record may be stored under older
      // ones), and so does the ranking count that sizes the node.
      const full: PaperMetadata = {
        ...record,
        canonical_key: pending.canonical_key,
        paper_group_key: pending.paper_group_key,
        cited_by_count: pending.cited_by_count ?? record.cited_by_count,
      };
      const swap = (version: PaperMetadata) => (stale(version) ? full : version);
      const selected = swap(node.selected_version);
      const patched: CatalogNode = {
        ...node,
        label: selected.title,
        selected_version: selected,
        versions: node.versions.map(swap),
        details_pending: false,
        detailsUnavailable: false,
      };
      this.nodes.set(id, patched);
      changed = true;
    }
    return changed;
  }

  getNode(id: string): CatalogNode | undefined {
    return this.nodes.get(id);
  }

  /** Canonical key of the node's selected version (the related-list source). */
  sourceKey(id: string): string {
    return this.nodes.get(id)?.selected_version.canonical_key ?? id;
  }

  /** Switch the node's selected version; false when the version is unknown. */
  selectVersion(id: string, canonicalKey: string): boolean {
    const node = this.nodes.get(id);
    const version = node?.versions.find((candidate) => candidate.canonical_key === canonicalKey);
    if (!node || !version) return false;
    if (node.selected_version.canonical_key !== canonicalKey) this.nodes.set(id, { ...node, selected_version: version });
    return true;
  }
}

/** Whether swapping `next` in for `current` leaves the layout as it is (same node size). */
function sameLayout(current: GraphNode, next: GraphNode): boolean {
  return (current.selected_version.cited_by_count ?? null) === (next.selected_version.cited_by_count ?? null);
}

/**
 * Bring the force-graph data in line with the exploration state: prune what
 * is no longer visible, then merge what became visible (spawned around
 * `anchorId` when it has no positioned edge partner). Surviving node objects
 * keep their identity (positions, pins) and pick up the catalog's payload.
 * Returns `prev` itself when nothing changed, and also when only payloads
 * changed without touching the layout (details arriving for a node): they
 * are swapped into the existing node objects, so the engine keeps its data
 * (a new one re-heats the whole simulation) and only needs a repaint.
 */
export function syncForceData(
  prev: ForceGraphData,
  state: ExplorationState,
  catalog: GraphCatalog,
  anchorId?: string | null,
): ForceGraphData {
  const keepIds = new Set([...visibleNodeIds(state)].filter((id) => catalog.nodes.has(id)));
  const keepLinks = new Set(
    [...visibleEdgeKeys(state)].filter((key) => {
      const edge = catalog.edges.get(key);
      return !!edge && keepIds.has(edge.source) && keepIds.has(edge.target);
    }),
  );

  const sameMembers =
    prev.nodes.length === keepIds.size &&
    prev.links.length === keepLinks.size &&
    prev.nodes.every((node) => keepIds.has(node.id)) &&
    prev.links.every((link) => keepLinks.has(linkKey(link)));
  if (sameMembers && prev.nodes.every((forceNode) => sameLayout(forceNode.node, catalog.nodes.get(forceNode.id)!))) {
    for (const forceNode of prev.nodes) {
      const node = catalog.nodes.get(forceNode.id)!;
      if (forceNode.node !== node) forceNode.node = node;
    }
    return prev;
  }

  const pruned = pruneGraph(prev, keepIds, keepLinks);
  const presentNodes = new Set<string>();
  for (const forceNode of pruned.nodes) {
    presentNodes.add(forceNode.id);
    const node = catalog.nodes.get(forceNode.id);
    if (node && forceNode.node !== node) forceNode.node = node;
  }
  const presentLinks = new Set(pruned.links.map(linkKey));
  const nodes: GraphNode[] = [];
  for (const id of keepIds) {
    const node = catalog.nodes.get(id);
    if (node && !presentNodes.has(id)) nodes.push(node);
  }
  const edges: GraphEdge[] = [];
  for (const key of keepLinks) {
    const edge = catalog.edges.get(key);
    if (edge && !presentLinks.has(key)) edges.push(edge);
  }
  return mergeGraph(pruned, { nodes, edges }, anchorId);
}
