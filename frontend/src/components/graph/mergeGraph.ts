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

export function endpointId(endpoint: string | ForceNode): string {
  return typeof endpoint === "object" ? endpoint.id : endpoint;
}

export function linkKey(link: { source: string | ForceNode; target: string | ForceNode; relation_type: string }) {
  return `${endpointId(link.source)}__${endpointId(link.target)}__${link.relation_type}`;
}

/**
 * Drop nodes not in `keepIds`, and links that touch a dropped node or (when
 * given) are not in `keepLinkKeys`. Survivors keep their object identity, so
 * d3 positions and pins are untouched; the arrays are new.
 */
export function pruneGraph(
  prev: ForceGraphData,
  keepIds: ReadonlySet<string>,
  keepLinkKeys?: ReadonlySet<string>,
): ForceGraphData {
  return {
    nodes: prev.nodes.filter((node) => keepIds.has(node.id)),
    links: prev.links.filter(
      (link) =>
        keepIds.has(endpointId(link.source)) &&
        keepIds.has(endpointId(link.target)) &&
        (!keepLinkKeys || keepLinkKeys.has(linkKey(link))),
    ),
  };
}

/** Ring-spawn geometry: the radius grows with sibling count so every
 * child gets ~SPAWN_SPACING px of arc — readable even before (or without)
 * any physics relaxation. */
const SPAWN_RADIUS_MIN = 50;
const SPAWN_RADIUS_JITTER = 20;
const SPAWN_SPACING = 26;

/**
 * Merge an expansion result into the current force-graph data.
 *
 * - Nodes are deduped by paper group id; existing node OBJECTS are reused so
 *   d3 keeps their positions (no whole-graph reshuffle).
 * - Links are deduped by (source, target, relation).
 * - New nodes are distributed on a RING around their already-positioned
 *   neighbour (edge partner, or the focused anchor): child i of n lands at
 *   angle 2πi/n on a radius that scales with sibling count, so even large
 *   expansions land readably spaced instead of heaping on the seed.
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

  // Group new nodes by their positioned partner, then distribute each
  // group on a ring around it.
  const anchor = anchorId ? nodeById.get(anchorId) : undefined;
  const spawnGroups = new Map<ForceNode, ForceNode[]>();
  for (const fresh of newNodes) {
    let near: ForceNode | undefined;
    for (const link of incomingLinks) {
      const sourceId = endpointId(link.source);
      const targetId = endpointId(link.target);
      if (sourceId === fresh.id || targetId === fresh.id) {
        const partner = nodeById.get(sourceId === fresh.id ? targetId : sourceId);
        if (partner && partner !== fresh && partner.x != null && partner.y != null) {
          near = partner;
          break;
        }
      }
    }
    if (!near && anchor && anchor.x != null && anchor.y != null) near = anchor;
    if (near) spawnGroups.set(near, [...(spawnGroups.get(near) ?? []), fresh]);
  }

  for (const [near, children] of spawnGroups) {
    const phase = Math.random() * 2 * Math.PI;
    const baseRadius = Math.max(
      SPAWN_RADIUS_MIN,
      (children.length * SPAWN_SPACING) / (2 * Math.PI),
    );
    children.forEach((child, index) => {
      const angle = phase + (2 * Math.PI * index) / children.length;
      const radius = baseRadius + Math.random() * SPAWN_RADIUS_JITTER;
      child.x = (near.x ?? 0) + radius * Math.cos(angle);
      child.y = (near.y ?? 0) + radius * Math.sin(angle);
    });
  }

  return { nodes: [...nodeById.values()], links: [...linkByKey.values()] };
}
