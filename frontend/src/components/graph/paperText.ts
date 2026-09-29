import type { TFunction } from "i18next";
import type { PaperMetadata } from "@/types";

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

export function truncateLabel(text: string, max: number = LABEL_MAX): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max - 1).trimEnd()}…` : clean;
}
