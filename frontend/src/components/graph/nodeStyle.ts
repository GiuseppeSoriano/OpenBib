import type { GraphNode } from "@/types";

/** Resolved theme colors (the canvas cannot read CSS custom properties). */
export interface NodeStyleColors {
  /** --graph-node */
  node: string;
  /** --graph-node-pinned */
  pinned: string;
  /** --graph-node-mark: the punched centre of a paper in the Library. */
  mark: string;
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
  /** Centre dot of a paper in the Library, in the canvas colour. */
  mark?: string;
  /** External ring, clear of the node by a background-coloured gap, for the selected node. */
  selectedRing?: { color: string; gapColor: string };
  /** Dashed ring marking a multi-version group. */
  versionRing: boolean;
}

/**
 * Canvas style of one node. Only two fills: pinned papers take the accent,
 * every other paper the neutral grey (`is_seed` no longer drives color:
 * seeds start pinned instead). Library membership is a mark, not a colour:
 * a small centre dot in the canvas colour, "punched" through either fill,
 * so pinned and unpinned Library papers stay apart without a third hue.
 * Size already encodes citations, so a pin is not enlarged. Selection only
 * adds an external ring, so the node keeps its fill and mark.
 */
export function nodeStyle(node: GraphNode, state: NodeStyleState, colors: NodeStyleColors): NodeStyle {
  const style: NodeStyle = {
    fill: state.pinned ? colors.pinned : colors.node,
    versionRing: node.version_count > 1,
  };
  if (state.saved) style.mark = colors.mark;
  if (state.selected) style.selectedRing = { color: colors.selected, gapColor: colors.background };
  return style;
}

/** Class of the HTML dot that mirrors a node's canvas style (lists, summary, legend). */
export function graphDotClass(pinned: boolean, saved: boolean, selected: boolean): string {
  let className = "graph-dot";
  if (pinned) className += " graph-dot--pinned";
  if (saved) className += " graph-dot--saved";
  if (selected) className += " graph-dot--selected";
  return className;
}

/** Node radius bounds, in graph units (screen pixels at zoom 1). */
export const NODE_RADIUS_MIN = 4;
export const NODE_RADIUS_MAX = 14;

/** The Library mark's radius, as a share of the node's. */
export const MARK_RATIO = 0.4;
/** Smallest mark radius on screen (px), so it never vanishes zoomed out. */
export const MARK_MIN_PX = 1.5;
/** Largest share of the node the mark may take, so a ring of fill always shows. */
export const MARK_MAX_RATIO = 0.6;

/**
 * Radius of the Library mark, in graph units: 40% of the node's radius,
 * held to at least 1.5 screen pixels at any zoom but never more than 60%
 * of the node, so a band of the fill always surrounds it.
 */
export function markRadius(radius: number, globalScale: number): number {
  return Math.min(radius * MARK_MAX_RATIO, Math.max(radius * MARK_RATIO, MARK_MIN_PX / globalScale));
}

/**
 * Node radius by citations, on a log scale held to 4–14 units: an
 * uncited paper is 4, 100 citations about 8, 100,000 or more the maximum,
 * so one heavily cited paper never dwarfs a range.
 */
export function nodeRadius(citations: number | null | undefined): number {
  const decades = Math.log10(1 + Math.max(0, citations ?? 0));
  return NODE_RADIUS_MIN + (NODE_RADIUS_MAX - NODE_RADIUS_MIN) * Math.min(1, decades / 5);
}
