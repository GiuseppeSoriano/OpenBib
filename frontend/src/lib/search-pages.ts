import type { SearchResult, SearchResultItem } from "@/types";

/** Group stable identities across pages, preserving ranking and all versions.
 * Titles are never used as identities; the backend supplies canonical group keys.
 */
export function mergeSearchPages(pages: SearchResult[]): SearchResultItem[] {
  const groups = new Map<string, SearchResultItem>();
  for (const item of pages.flatMap(page => page.items)) {
    const key = item.kind === "paper" ? item.paper.paper_group_key : item.paper_group_key;
    const previous = groups.get(key);
    if (!previous) { groups.set(key, item); continue; }
    const papers = (entry: SearchResultItem) => entry.kind === "paper" ? [entry.paper] : entry.versions;
    const versions = Array.from(new Map([...papers(previous), ...papers(item)].map(paper => [paper.canonical_key, paper])).values());
    const selected = previous.kind === "paper" ? previous.paper : previous.selected_version;
    if (versions.length === 1) {
      groups.set(key, { kind: "paper", paper: versions[0]! });
    } else {
      groups.set(key, {
        kind: "paper_group", paper_group_key: key, title: selected.title, authors: selected.authors,
        selected_version: selected, versions, version_count: versions.length,
        provider_sources: [...new Set(versions.flatMap(paper => paper.provider_sources ?? [paper.provider_source]))],
      });
    }
  }
  return [...groups.values()];
}
