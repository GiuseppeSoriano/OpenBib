import type { GraphNode } from "@/types";

/** Resolved theme colors (the canvas cannot read CSS custom properties). */
export interface NodeStyleColors {
  /** --graph-node */
  node: string;
  /** --graph-node-pinned */
  pinned: string;
  /** --graph-node-saved */
  saved: string;
  /** --graph-node-selected */
  selected: string;
  /** --graph-node-gap: the gap between a node and its selection ring. */
  background: string;
}

export interface NodeStyleState {
  pinned: boolean;
  saved: boolean;
  selected: boolean;
}

export interface NodeStyle {
  /** The node's own colour, kept when it is selected. */
  fill: string;
  /** External ring, clear of the node by a background-coloured gap, for the selected node. */
  selectedRing?: { color: string; gapColor: string };
  /** Dashed ring marking a multi-version group. */
  versionRing: boolean;
}

/**
 * Canvas style of one node. Fill precedence is pinned, then saved, then
 * default; `is_seed` no longer drives color (seeds start pinned instead).
 * A pin is a plain filled circle with no extra stroke: size already encodes
 * citations, so it is not enlarged either. Pins stay identifiable without
 * colour in the papers panel's Pinned section, through the pressed Pin
 * toggles, and by their labels. Selection only adds an external ring, so the
 * node keeps its fill and reads on pinned and unpinned nodes alike.
 */
export function nodeStyle(node: GraphNode, state: NodeStyleState, colors: NodeStyleColors): NodeStyle {
  const style: NodeStyle = {
    fill: state.pinned ? colors.pinned : state.saved ? colors.saved : colors.node,
    versionRing: node.version_count > 1,
  };
  if (state.selected) style.selectedRing = { color: colors.selected, gapColor: colors.background };
  return style;
}

/** Class of the HTML dot that mirrors a node's canvas style (lists, summary). */
export function graphDotClass(pinned: boolean, saved: boolean, selected: boolean): string {
  let className = "graph-dot";
  if (pinned) className += " graph-dot--pinned";
  else if (saved) className += " graph-dot--saved";
  if (selected) className += " graph-dot--selected";
  return className;
}

/** Node radius bounds, in graph units (screen pixels at zoom 1). */
export const NODE_RADIUS_MIN = 4;
export const NODE_RADIUS_MAX = 14;

/**
 * Node radius by citations, on a log scale held to 4–14 units: an
 * uncited paper is 4, 100 citations about 8, 100,000 or more the maximum,
 * so one heavily cited paper never dwarfs a range.
 */
export function nodeRadius(citations: number | null | undefined): number {
  const decades = Math.log10(1 + Math.max(0, citations ?? 0));
  return NODE_RADIUS_MIN + (NODE_RADIUS_MAX - NODE_RADIUS_MIN) * Math.min(1, decades / 5);
}
