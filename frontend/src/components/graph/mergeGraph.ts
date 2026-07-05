import type { GraphEdge, GraphNode } from "@/types";

/**
 * Force-graph node wrapper. d3-force mutates these objects in place
 * (x/y/vx/vy, and fx/fy when pinned) — object identity across merges is
 * what keeps existing nodes exactly where the user left them.
 */
export interface ForceNode {
  id: string;
  node: GraphNode;
  x?: number;
  y?: number;
  vx?: number;
  vy?: number;
  fx?: number;
  fy?: number;
}

export interface ForceLink {
  /** react-force-graph replaces string endpoints with node refs at runtime. */
  source: string | ForceNode;
  target: string | ForceNode;
  relation_type: string;
}

export interface ForceGraphData {
  nodes: ForceNode[];
  links: ForceLink[];
}

export const EMPTY_GRAPH: ForceGraphData = { nodes: [], links: [] };

function endpointId(endpoint: string | ForceNode): string {
  return typeof endpoint === "object" ? endpoint.id : endpoint;
}

function linkKey(link: { source: string | ForceNode; target: string | ForceNode; relation_type: string }) {
  return `${endpointId(link.source)}__${endpointId(link.target)}__${link.relation_type}`;
}

const SPAWN_JITTER = 30;

function jitter(): number {
  return (Math.random() - 0.5) * 2 * SPAWN_JITTER;
}

/**
 * Merge an expansion result into the current force-graph data.
 *
 * - Nodes are deduped by paper group id; existing node OBJECTS are reused so
 *   d3 keeps their positions (no whole-graph reshuffle).
 * - Links are deduped by (source, target, relation).
 * - Each new node spawns next to an already-positioned neighbour (its edge
 *   partner, or the focused anchor), so growth relaxes locally instead of
 *   flying in from the origin.
 *
 * Returns a NEW top-level object with new arrays (so React re-renders) that
 * share the previous node/link objects.
 */
export function mergeGraph(
  prev: ForceGraphData,
  incoming: { nodes: GraphNode[]; edges: GraphEdge[] },
  anchorId?: string | null,
): ForceGraphData {
  const nodeById = new Map<string, ForceNode>(prev.nodes.map((n) => [n.id, n]));
  const linkByKey = new Map<string, ForceLink>(prev.links.map((l) => [linkKey(l), l]));

  const newNodes: ForceNode[] = [];
  for (const node of incoming.nodes) {
    if (nodeById.has(node.id)) continue;
    const forceNode: ForceNode = { id: node.id, node };
    nodeById.set(node.id, forceNode);
    newNodes.push(forceNode);
  }

  const incomingLinks: ForceLink[] = [];
  for (const edge of incoming.edges) {
    const key = `${edge.source}__${edge.target}__${edge.relation_type}`;
    if (linkByKey.has(key)) continue;
    const link: ForceLink = {
      source: edge.source,
      target: edge.target,
      relation_type: edge.relation_type,
    };
    linkByKey.set(key, link);
    incomingLinks.push(link);
  }

  // Position new nodes near an already-positioned neighbour.
  const anchor = anchorId ? nodeById.get(anchorId) : undefined;
  for (const fresh of newNodes) {
    let near: ForceNode | undefined;
    for (const link of incomingLinks) {
      const sourceId = endpointId(link.source);
      const targetId = endpointId(link.target);
      if (sourceId === fresh.id || targetId === fresh.id) {
        const partner = nodeById.get(sourceId === fresh.id ? targetId : sourceId);
        if (partner && partner.x != null && partner.y != null) {
          near = partner;
          break;
        }
      }
    }
    if (!near && anchor && anchor.x != null && anchor.y != null) near = anchor;
    if (near) {
      fresh.x = (near.x ?? 0) + jitter();
      fresh.y = (near.y ?? 0) + jitter();
    }
  }

  return { nodes: [...nodeById.values()], links: [...linkByKey.values()] };
}
