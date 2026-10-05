import { READING_STATES, type LibraryListParams, type LibrarySort, type ReadingState } from "@/types";

/** Library filters and sort as kept in the page URL (paging stays out of it). */
export type LibraryFilterParams = Omit<LibraryListParams, "page" | "size">;

export const LIBRARY_SORTS: readonly LibrarySort[] = ["added", "title", "year", "citations"];
export const DEFAULT_LIBRARY_SORT: LibrarySort = "added";
export const LIBRARY_QUERY_MAX = 200;
export const LIBRARY_TAG_MAX = 100;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const FILTER_KEYS = ["q", "state", "tag", "collection_id", "sort"] as const;

function isReadingState(value: string): value is ReadingState {
  return (READING_STATES as readonly string[]).indexOf(value) !== -1;
}

function isLibrarySort(value: string): value is LibrarySort {
  return (LIBRARY_SORTS as readonly string[]).indexOf(value) !== -1;
}

/**
 * Reads the filters from the URL, dropping empty, unknown and default values,
 * and values the API would reject (an over-long tag, a malformed collection id).
 */
export function parseLibraryParams(sp: URLSearchParams): LibraryFilterParams {
  const params: LibraryFilterParams = {};
  const q = (sp.get("q") ?? "").trim().slice(0, LIBRARY_QUERY_MAX);
  if (q) params.q = q;
  const state = sp.get("state") ?? "";
  if (isReadingState(state)) params.state = state;
  const tag = sp.get("tag") ?? "";
  if (tag && tag.length <= LIBRARY_TAG_MAX) params.tag = tag;
  const collectionId = sp.get("collection_id") ?? "";
  if (UUID_PATTERN.test(collectionId)) params.collection_id = collectionId;
  const sort = sp.get("sort") ?? "";
  if (isLibrarySort(sort) && sort !== DEFAULT_LIBRARY_SORT) params.sort = sort;
  return params;
}

/**
 * Writes the filters into a copy of `base`, omitting defaults, and keeps any
 * unrelated parameter already there.
 */
export function serializeLibraryParams(
  params: LibraryFilterParams,
  base: URLSearchParams = new URLSearchParams(),
): URLSearchParams {
  const next = new URLSearchParams(base);
  for (const key of FILTER_KEYS) next.delete(key);
  const q = (params.q ?? "").trim().slice(0, LIBRARY_QUERY_MAX);
  if (q) next.set("q", q);
  if (params.state) next.set("state", params.state);
  if (params.tag) next.set("tag", params.tag);
  if (params.collection_id) next.set("collection_id", params.collection_id);
  if (params.sort && params.sort !== DEFAULT_LIBRARY_SORT) next.set("sort", params.sort);
  return next;
}

/** Number of active filters; the sort order is not a filter. */
export function activeFilterCount(params: LibraryFilterParams): number {
  return [params.q, params.state, params.tag, params.collection_id].filter(Boolean).length;
}
