import type { PossibleVersion, SearchResult, SearchResultItem } from "@/types";
import { usesCursor, type SearchPageParam, type SearchParamsState } from "@/lib/searchParams";

export function itemGroupKey(item: SearchResultItem): string {
  return item.kind === "paper" ? item.paper.paper_group_key : item.paper_group_key;
}

/**
 * DOM id of a result card, stable across pages and renders. The group key
 * is encoded rather than hashed so two results can never share an id.
 */
export function resultElementId(groupKey: string): string {
  return `result-${encodeURIComponent(groupKey)}`;
}

/** Possible other versions of `key`, deduplicated, never pointing at itself. */
function relatedVersions(key: string, ...lists: (PossibleVersion[] | undefined)[]): PossibleVersion[] {
  const related = new Map<string, PossibleVersion>();
  for (const version of lists.flatMap((list) => list ?? [])) {
    if (version.paper_group_key !== key && !related.has(version.paper_group_key)) {
      related.set(version.paper_group_key, version);
    }
  }
  return Array.from(related.values());
}

/** Group stable identities across pages, preserving ranking and all versions.
 * Titles are never used as identities; the backend supplies canonical group keys.
 */
export function mergeSearchPages(pages: SearchResult[]): SearchResultItem[] {
  const groups = new Map<string, SearchResultItem>();
  for (const item of pages.flatMap(page => page.items)) {
    const key = itemGroupKey(item);
    const previous = groups.get(key);
    if (!previous) { groups.set(key, item); continue; }
    const papers = (entry: SearchResultItem) => entry.kind === "paper" ? [entry.paper] : entry.versions;
    const versions = Array.from(new Map([...papers(previous), ...papers(item)].map(paper => [paper.canonical_key, paper])).values());
    const selected = previous.kind === "paper" ? previous.paper : previous.selected_version;
    const possible_versions = relatedVersions(key, previous.possible_versions, item.possible_versions);
    if (versions.length === 1) {
      groups.set(key, { kind: "paper", paper: versions[0]!, possible_versions });
    } else {
      groups.set(key, {
        kind: "paper_group", paper_group_key: key, title: selected.title, authors: selected.authors,
        selected_version: selected, versions, version_count: versions.length,
        provider_sources: [...new Set(versions.flatMap(paper => paper.provider_sources ?? [paper.provider_source]))],
        possible_versions,
      });
    }
  }
  return [...groups.values()];
}

/**
 * Where the page after `last` starts: the next page number for relevance,
 * the server's cursor for the date and citation sorts; undefined at the end.
 */
export function nextSearchPage(state: SearchParamsState, last: SearchResult): SearchPageParam | undefined {
  if (usesCursor(state.sort)) return last.next_cursor ? { cursor: last.next_cursor } : undefined;
  return last.has_more && !last.window_capped ? { page: last.page + 1 } : undefined;
}
