import type { SearchParams, SearchSort } from "@/types";

/** The search as kept in the page URL: the words, the filters and the sort. */
export interface SearchParamsState {
  q: string;
  year_from?: number;
  year_to?: number;
  /** Open access only. */
  oa?: boolean;
  sort?: SearchSort;
}

/** Where the next page starts: a page number (relevance) or a cursor (sorted modes). */
export type SearchPageParam = { page: number } | { cursor: string };

export const SEARCH_SORTS: readonly SearchSort[] = ["relevance", "date", "citations"];
export const DEFAULT_SEARCH_SORT: SearchSort = "relevance";
export const SEARCH_QUERY_MAX = 500;
export const SEARCH_PAGE_SIZE = 20;
export const MIN_SEARCH_YEAR = 1800;

/** Latest year the API accepts (next year in UTC, as the server counts it). */
export function maxSearchYear(now: Date = new Date()): number {
  return now.getUTCFullYear() + 1;
}

/** A four-digit year the API accepts, or undefined. */
export function parseYear(value: string | number | null | undefined, now?: Date): number | undefined {
  const text = String(value ?? "").trim();
  if (!/^\d{4}$/.test(text)) return undefined;
  const year = Number(text);
  return year >= MIN_SEARCH_YEAR && year <= maxSearchYear(now) ? year : undefined;
}

function isSearchSort(value: string): value is SearchSort {
  return (SEARCH_SORTS as readonly string[]).indexOf(value) !== -1;
}

/** Date and citation sorts page with an opaque cursor instead of page numbers. */
export function usesCursor(sort: SearchSort | undefined): boolean {
  return !!sort && sort !== DEFAULT_SEARCH_SORT;
}

/**
 * Normalizes a search: trims and caps the words, and drops default values and
 * values the API would reject (a year out of range, a reversed range).
 */
function clean(
  input: { q?: string | null; year_from?: unknown; year_to?: unknown; oa?: unknown; sort?: unknown },
  now?: Date,
): SearchParamsState {
  const state: SearchParamsState = { q: (input.q ?? "").trim().slice(0, SEARCH_QUERY_MAX) };
  let from = parseYear(input.year_from as string | number | undefined, now);
  let to = parseYear(input.year_to as string | number | undefined, now);
  if (from !== undefined && to !== undefined && from > to) {
    from = undefined;
    to = undefined;
  }
  if (from !== undefined) state.year_from = from;
  if (to !== undefined) state.year_to = to;
  if (input.oa === true || input.oa === "1" || input.oa === "true") state.oa = true;
  const sort = typeof input.sort === "string" ? input.sort : "";
  if (isSearchSort(sort) && sort !== DEFAULT_SEARCH_SORT) state.sort = sort;
  return state;
}

/** Reads the search from the URL; invalid and default values are dropped. */
export function parseSearchParams(sp: URLSearchParams, now?: Date): SearchParamsState {
  return clean(
    {
      q: sp.get("q"),
      year_from: sp.get("year_from"),
      year_to: sp.get("year_to"),
      oa: sp.get("oa"),
      sort: sp.get("sort"),
    },
    now,
  );
}

/**
 * Writes the search as URL parameters in a fixed order, omitting defaults
 * and invalid values, so equal searches always serialize the same way.
 */
export function serializeSearchParams(state: SearchParamsState, now?: Date): URLSearchParams {
  const next = new URLSearchParams();
  const cleaned = clean(state, now);
  if (cleaned.q) next.set("q", cleaned.q);
  if (cleaned.year_from !== undefined) next.set("year_from", String(cleaned.year_from));
  if (cleaned.year_to !== undefined) next.set("year_to", String(cleaned.year_to));
  if (cleaned.oa) next.set("oa", "1");
  if (cleaned.sort) next.set("sort", cleaned.sort);
  return next;
}

/** API parameters for one page of the search. */
export function toApiParams(state: SearchParamsState, pageParam: SearchPageParam): SearchParams {
  const params: SearchParams = { q: state.q, size: SEARCH_PAGE_SIZE };
  if (state.year_from !== undefined) params.year_from = state.year_from;
  if (state.year_to !== undefined) params.year_to = state.year_to;
  if (state.oa) params.open_access_only = true;
  if (usesCursor(state.sort)) params.sort = state.sort;
  if ("cursor" in pageParam) params.cursor = pageParam.cursor;
  else params.page = pageParam.page;
  return params;
}

/** Number of active filters: the year range counts once; the sort is not a filter. */
export function activeFilterCount(state: SearchParamsState): number {
  const years = state.year_from !== undefined || state.year_to !== undefined;
  return (years ? 1 : 0) + (state.oa ? 1 : 0);
}
