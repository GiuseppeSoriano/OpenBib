import type { TFunction } from "i18next";
import type { GraphNode, PaperMetadata } from "@/types";

/** Canvas labels stop at about this many characters (the list and popup keep the full title). */
export const LABEL_MAX = 48;

/** A seed the providers could not resolve: its title is only its internal key. */
export function isUnresolved(paper: PaperMetadata): boolean {
  return paper.provider_source === "unknown";
}

/** The DOI of a paper, from its metadata or a `doi:` canonical key. */
export function paperDoi(paper: PaperMetadata): string | null {
  if (paper.doi) return paper.doi;
  return paper.canonical_key.startsWith("doi:") ? paper.canonical_key.slice(4) : null;
}

/** Display title; never a raw key for an unresolved paper. */
export function paperTitle(paper: PaperMetadata, t: TFunction): string {
  if (isUnresolved(paper) || !paper.title?.trim()) return t("graph.detailsUnavailable");
  return paper.title;
}

/**
 * The graph catalog's client-side mark on a node whose pending details no
 * background refresh will bring (never sent by the server).
 */
export interface DetailsMark {
  detailsUnavailable?: boolean;
}

/**
 * Whether a version carries a related list's data only: the server's
 * placeholder for a record it could not fetch has its key as its title.
 */
export function isListDataOnly(paper: PaperMetadata): boolean {
  return !isUnresolved(paper) && paper.title === paper.canonical_key;
}

/** A node whose selected version still waits for its details. */
export function hasPendingDetails(node: GraphNode): boolean {
  return !!node.details_pending;
}

export type DetailsStatus = "loading" | "unavailable";

/**
 * Where the title of a node's version stands: "loading" while a refresh may
 * still bring it, "unavailable" once none will; null when it is known.
 */
export function detailsStatus(node: GraphNode & DetailsMark, paper: PaperMetadata = node.selected_version): DetailsStatus | null {
  if (!isListDataOnly(paper)) return null;
  return node.details_pending && !node.detailsUnavailable ? "loading" : "unavailable";
}

/**
 * Display title of a graph node (or of one of its versions): a neutral
 * placeholder while its details are pending, never a raw key.
 */
export function nodeTitle(node: GraphNode, t: TFunction, paper: PaperMetadata = node.selected_version): string {
  const status = detailsStatus(node, paper);
  if (status) return t(status === "loading" ? "graph.titleLoading" : "graph.titleUnavailable");
  return paperTitle(paper, t);
}

export function truncateLabel(text: string, max: number = LABEL_MAX): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max - 1).trimEnd()}…` : clean;
}

/** A hovered or selected paper's canvas label spells its title out on up to this many lines. */
export const LABEL_MAX_LINES = 3;

/**
 * A title broken at its spaces onto lines of at most `max` characters (a
 * word longer than a line is split), for the hovered or selected paper's
 * label. A title that fits one line comes back whole, as its only line,
 * exactly as truncateLabel gives it; past `lines` lines, the last one ends
 * in "…".
 */
export function wrapLabel(text: string, max: number = LABEL_MAX, lines: number = LABEL_MAX_LINES): string[] {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length <= max) return [clean];
  const words = clean.split(" ").flatMap((word) => {
    const parts: string[] = [];
    for (let start = 0; start < word.length; start += max) parts.push(word.slice(start, start + max));
    return parts;
  });
  const wrapped: string[] = [];
  let line = "";
  for (const word of words) {
    if (line && line.length + 1 + word.length > max) {
      wrapped.push(line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  wrapped.push(line);
  if (wrapped.length <= lines) return wrapped;
  const kept = wrapped.slice(0, lines);
  const last = kept[lines - 1]!;
  // The ellipsis follows the last whole word when there is room for it.
  kept[lines - 1] = last.length < max ? `${last}…` : `${last.slice(0, max - 1).trimEnd()}…`;
  return kept;
}
