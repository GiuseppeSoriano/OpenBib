import { afterEach, describe, expect, it } from "vitest";
import { clearLastSearch, getLastSearch, setLastSearch } from "@/lib/lastSearch";

afterEach(() => clearLastSearch());

describe("lastSearch", () => {
  it("keeps the last search as a query string without the leading ?", () => {
    expect(getLastSearch()).toBeNull();
    setLastSearch("?q=graph&sort=date");
    expect(getLastSearch()).toBe("q=graph&sort=date");
    setLastSearch("q=other");
    expect(getLastSearch()).toBe("q=other");
  });

  it("treats an empty search as none and can be cleared", () => {
    setLastSearch("q=graph");
    setLastSearch("");
    expect(getLastSearch()).toBeNull();
    setLastSearch("q=graph");
    clearLastSearch();
    expect(getLastSearch()).toBeNull();
  });

  it("never touches Web Storage", () => {
    const before = [localStorage.length, sessionStorage.length];
    setLastSearch("q=private+topic");
    expect([localStorage.length, sessionStorage.length]).toEqual(before);
    expect(JSON.stringify({ ...localStorage, ...sessionStorage })).not.toContain("private");
  });
});
