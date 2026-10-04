import { useSyncExternalStore } from "react";

// The last few searches run on the Search page, newest first, for the
// sidebar and the command palette. In memory only (never Web Storage), and
// dropped when the signed-in user changes or signs out.

export interface RecentSearch {
  /** The query text, as typed. */
  query: string;
  /** The Search page's URL query string (without "?"). */
  search: string;
}

const MAX_RECENT = 5;

let recent: readonly RecentSearch[] = [];
let owner: string | null = null;
const listeners = new Set<() => void>();

function publish(next: readonly RecentSearch[]) {
  recent = next;
  listeners.forEach((listener) => listener());
}

export function getRecentSearches(): readonly RecentSearch[] {
  return recent;
}

/** Record a search by its URL query string; searches without text are ignored. */
export function rememberSearch(search: string): void {
  const clean = search.replace(/^\?/, "");
  const query = (new URLSearchParams(clean).get("q") ?? "").trim();
  if (!query) return;
  const key = query.toLowerCase();
  const rest = recent.filter((item) => item.query.toLowerCase() !== key);
  publish([{ query, search: clean }, ...rest].slice(0, MAX_RECENT));
}

export function clearRecentSearches(): void {
  if (recent.length) publish([]);
}

/**
 * Called with the signed-in user's id (null when signed out). Searches made
 * before signing in are kept; another user, or signing out, clears them.
 */
export function syncRecentSearchesOwner(userId: string | null): void {
  if (owner !== null && owner !== userId) clearRecentSearches();
  owner = userId;
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useRecentSearches(): readonly RecentSearch[] {
  return useSyncExternalStore(subscribe, getRecentSearches, getRecentSearches);
}
