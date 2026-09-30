// The last search shown on the Search page, as its URL query string (without
// "?"), so a bare /search can reopen it. In memory only (never Web Storage)
// and cleared when the session ends or another user signs in.
let lastSearch: string | null = null;

export function getLastSearch(): string | null {
  return lastSearch;
}

export function setLastSearch(search: string): void {
  lastSearch = search.replace(/^\?/, "") || null;
}

export function clearLastSearch(): void {
  lastSearch = null;
}
