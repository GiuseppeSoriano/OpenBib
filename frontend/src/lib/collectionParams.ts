import { READING_STATES, type CollectionPaper, type ReadingState } from "@/types";
import { describeStoredKey, type StoredKeyView } from "@/lib/identifiers";

/** "position" is the collection's own order (as added or arranged). */
export type CollectionSort = "position" | "added" | "title" | "year" | "citations";

/** A collection's filters and sort as kept in the page URL. */
export interface CollectionFilterParams {
  q?: string;
  state?: ReadingState;
  tag?: string;
  sort?: CollectionSort;
}

export const COLLECTION_SORTS: readonly CollectionSort[] = ["position", "added", "title", "year", "citations"];
export const DEFAULT_COLLECTION_SORT: CollectionSort = "position";
export const COLLECTION_QUERY_MAX = 200;
const TAG_MAX = 100;

const FILTER_KEYS = ["q", "state", "tag", "sort"] as const;

function isReadingState(value: string): value is ReadingState {
  return (READING_STATES as readonly string[]).indexOf(value) !== -1;
}

function isCollectionSort(value: string): value is CollectionSort {
  return (COLLECTION_SORTS as readonly string[]).indexOf(value) !== -1;
}

/** Reads the filters from the URL, dropping empty, unknown and default values. */
export function parseCollectionParams(sp: URLSearchParams): CollectionFilterParams {
  const params: CollectionFilterParams = {};
  const q = (sp.get("q") ?? "").trim().slice(0, COLLECTION_QUERY_MAX);
  if (q) params.q = q;
  const state = sp.get("state") ?? "";
  if (isReadingState(state)) params.state = state;
  const tag = sp.get("tag") ?? "";
  if (tag && tag.length <= TAG_MAX) params.tag = tag;
  const sort = sp.get("sort") ?? "";
  if (isCollectionSort(sort) && sort !== DEFAULT_COLLECTION_SORT) params.sort = sort;
  return params;
}

/** Writes the filters into a copy of `base`, omitting defaults and keeping unrelated parameters. */
export function serializeCollectionParams(
  params: CollectionFilterParams,
  base: URLSearchParams = new URLSearchParams(),
): URLSearchParams {
  const next = new URLSearchParams(base);
  for (const key of FILTER_KEYS) next.delete(key);
  const q = (params.q ?? "").trim().slice(0, COLLECTION_QUERY_MAX);
  if (q) next.set("q", q);
  if (params.state) next.set("state", params.state);
  if (params.tag) next.set("tag", params.tag);
  if (params.sort && params.sort !== DEFAULT_COLLECTION_SORT) next.set("sort", params.sort);
  return next;
}

/** Number of active filters; the sort order is not a filter. */
export function collectionFilterCount(params: CollectionFilterParams): number {
  return [params.q, params.state, params.tag].filter(Boolean).length;
}

/** The reader's own state and tags on a row, as the page currently knows them. */
export interface RowAnnotations {
  state?: ReadingState;
  tags: string[];
}

/** Lower-cased and without diacritics, so "godel" finds "Gödel". */
function fold(text: string): string {
  return text.normalize("NFD").replace(/[̀-ͯ]/g, "").toLocaleLowerCase();
}

/** The translated label shown before (or instead of) an unresolved row's identifier. */
export type IdentifierLabels = Partial<Record<Exclude<StoredKeyView["kind"], "invalid">, string>>;

/**
 * The text a row is matched on: title, authors and venue, or, for an
 * unresolved row, what its card shows (the identifier without its prefix and
 * its label), never the hidden text of an `s2:` or `hash:` key.
 */
function rowText(row: CollectionPaper, labels: IdentifierLabels): string {
  const paper = row.paper;
  if (!paper) {
    const view = describeStoredKey(row.paper_canonical_key);
    if (view.kind === "invalid") return view.value;
    if (view.kind === "hash" || view.kind === "s2") return labels[view.kind] ?? "";
    return `${labels[view.kind] ?? ""} ${view.value}`;
  }
  return [paper.title, ...paper.authors.map((a) => a.name), paper.venue ?? ""].join(" ");
}

function year(row: CollectionPaper): number | null {
  const value = row.paper?.publication_date;
  const parsed = value ? Number.parseInt(value.slice(0, 4), 10) : NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

/** Descending on a value that may be missing; a missing value sorts last. */
function desc(a: number | null | undefined, b: number | null | undefined): number {
  if (a == null || b == null) return (a == null ? 1 : 0) - (b == null ? 1 : 0);
  return b - a;
}

/**
 * The rows that match the filters, in the chosen order. The endpoint returns
 * the whole collection, so this runs on the loaded rows; every term of the
 * text must appear.
 */
export function filterCollectionRows(
  rows: CollectionPaper[],
  params: CollectionFilterParams,
  annotations: (row: CollectionPaper) => RowAnnotations,
  locale?: string,
  labels: IdentifierLabels = {},
): CollectionPaper[] {
  const terms = fold(params.q ?? "").split(/\s+/).filter(Boolean);
  const matched = rows.filter((row) => {
    if (terms.length) {
      const text = fold(rowText(row, labels));
      if (!terms.every((term) => text.indexOf(term) !== -1)) return false;
    }
    if (params.state || params.tag) {
      const own = annotations(row);
      if (params.state && own.state !== params.state) return false;
      if (params.tag && own.tags.indexOf(params.tag) === -1) return false;
    }
    return true;
  });
  const collator = new Intl.Collator(locale, { sensitivity: "base", numeric: true });
  const compare: Record<CollectionSort, (a: CollectionPaper, b: CollectionPaper) => number> = {
    position: () => 0,
    added: (a, b) => Date.parse(b.added_at) - Date.parse(a.added_at),
    title: (a, b) => {
      if (!a.paper || !b.paper) return (a.paper ? 0 : 1) - (b.paper ? 0 : 1);
      return collator.compare(a.paper.title, b.paper.title);
    },
    year: (a, b) => desc(year(a), year(b)),
    citations: (a, b) => desc(a.paper?.cited_by_count, b.paper?.cited_by_count),
  };
  const order = compare[params.sort ?? DEFAULT_COLLECTION_SORT];
  // A stable sort: ties keep the order the endpoint returned (the collection order).
  return matched.slice().sort(order);
}
