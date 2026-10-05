import { afterEach, describe, expect, it } from "vitest";
import { clearLastSearch, setLastSearch } from "@/lib/lastSearch";
import {
  clearRecentSearches,
  getRecentSearches,
  rememberSearch,
  syncRecentSearchesOwner,
} from "@/lib/recentSearches";

afterEach(() => {
  clearRecentSearches();
  clearLastSearch();
  syncRecentSearchesOwner(null);
});

describe("recentSearches", () => {
  it("keeps the newest five searches with text, without duplicates", () => {
    for (const q of ["one", "two", "three", "four", "five", "six"]) rememberSearch(`q=${q}`);
    rememberSearch("?q=FOUR&sort=date");
    rememberSearch("sort=date");
    expect(getRecentSearches().map((item) => item.query)).toEqual(["FOUR", "six", "five", "three", "two"]);
    expect(getRecentSearches()[0]!.search).toBe("q=FOUR&sort=date");
  });

  it("records every search the Search page remembers", () => {
    setLastSearch("?q=graph+neural+networks");
    expect(getRecentSearches()).toEqual([{ query: "graph neural networks", search: "q=graph+neural+networks" }]);
  });

  it("keeps searches made before signing in and drops them for another user or on sign-out", () => {
    rememberSearch("q=anonymous");
    syncRecentSearchesOwner("u1");
    expect(getRecentSearches()).toHaveLength(1);
    syncRecentSearchesOwner("u2");
    expect(getRecentSearches()).toHaveLength(0);
    rememberSearch("q=private");
    syncRecentSearchesOwner(null);
    expect(getRecentSearches()).toHaveLength(0);
  });

  it("never touches Web Storage", () => {
    const before = [localStorage.length, sessionStorage.length];
    rememberSearch("q=private+topic");
    expect([localStorage.length, sessionStorage.length]).toEqual(before);
  });
});
