import { linkKey, mergeGraph, pruneGraph, type ForceGraphData } from "@/components/graph/mergeGraph";
import { visibleEdgeKeys, visibleNodeIds, type ExplorationState } from "@/components/graph/graphExploration";
import type { GraphEdge, GraphNode } from "@/types";

function isRicher(incoming: GraphNode, existing: GraphNode): boolean {
  if (incoming.version_count !== existing.version_count) return incoming.version_count > existing.version_count;
  return existing.selected_version.provider_source === "unknown" && incoming.selected_version.provider_source !== "unknown";
}

/**
 * Every node and edge fetched during one exploration session, by id / link
 * key. The exploration state decides what is visible; the catalog keeps the
 * payloads so a node that leaves the canvas can come back unchanged.
 */
export class GraphCatalog {
  readonly nodes = new Map<string, GraphNode>();
  readonly edges = new Map<string, GraphEdge>();

  reset(): void {
    this.nodes.clear();
    this.edges.clear();
  }

  /**
   * An existing node is replaced only by a richer record (more versions, or
   * resolved where it was not), so a multi-version base node never degrades
   * to the single-version record a related range returns. The replacement
   * keeps the seed flag and the version the user had selected.
   */
  add(data: { nodes: GraphNode[]; edges: GraphEdge[] }): void {
    for (const node of data.nodes) {
      const existing = this.nodes.get(node.id);
      if (!existing) {
        this.nodes.set(node.id, node);
      } else if (isRicher(node, existing)) {
        const selectedKey = existing.selected_version.canonical_key;
        this.nodes.set(node.id, {
          ...node,
          is_seed: existing.is_seed || node.is_seed,
          selected_version: node.versions.find((version) => version.canonical_key === selectedKey) ?? node.selected_version,
        });
      }
    }
    for (const edge of data.edges) {
      const key = linkKey(edge);
      if (!this.edges.has(key)) this.edges.set(key, edge);
    }
  }

  getNode(id: string): GraphNode | undefined {
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

/**
 * Bring the force-graph data in line with the exploration state: prune what
 * is no longer visible, then merge what became visible (spawned around
 * `anchorId` when it has no positioned edge partner). Surviving node objects
 * keep their identity (positions, pins) and pick up the catalog's payload.
 * Returns `prev` itself when nothing changed.
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

  const unchanged =
    prev.nodes.length === keepIds.size &&
    prev.links.length === keepLinks.size &&
    prev.nodes.every((node) => keepIds.has(node.id) && catalog.nodes.get(node.id) === node.node) &&
    prev.links.every((link) => keepLinks.has(linkKey(link)));
  if (unchanged) return prev;

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
