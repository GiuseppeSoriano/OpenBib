import { describe, expect, it } from "vitest";
import {
  activeFilterCount,
  maxSearchYear,
  parseSearchParams,
  parseYear,
  serializeSearchParams,
  toApiParams,
  usesCursor,
} from "@/lib/searchParams";

const NOW = new Date("2026-09-30T12:00:00Z");
const parse = (search: string) => parseSearchParams(new URLSearchParams(search), NOW);

describe("parseSearchParams", () => {
  it("reads the words, the year range, open access and the sort", () => {
    expect(parse("q=graph+neural+networks&year_from=2019&year_to=2021&oa=1&sort=citations")).toEqual({
      q: "graph neural networks",
      year_from: 2019,
      year_to: 2021,
      oa: true,
      sort: "citations",
    });
  });

  it("trims and caps the words", () => {
    expect(parse("q=%20%20databases%20").q).toBe("databases");
    expect(parse(`q=${"a".repeat(600)}`).q).toHaveLength(500);
  });

  it("drops default and invalid values", () => {
    expect(parse("q=x&sort=relevance&oa=0")).toEqual({ q: "x" });
    expect(parse("q=x&sort=popularity&oa=yes")).toEqual({ q: "x" });
    expect(parse("q=x&year_from=1799&year_to=abcd")).toEqual({ q: "x" });
    expect(parse("q=x&year_from=19&year_to=20210")).toEqual({ q: "x" });
    expect(parse("q=x&year_to=2028")).toEqual({ q: "x" });
    expect(parse("q=x&year_to=2027")).toEqual({ q: "x", year_to: 2027 });
  });

  it("drops a reversed year range as a whole", () => {
    expect(parse("q=x&year_from=2022&year_to=2020")).toEqual({ q: "x" });
  });

  it("accepts oa=true as well as oa=1", () => {
    expect(parse("q=x&oa=true").oa).toBe(true);
  });
});

describe("serializeSearchParams", () => {
  it("writes a fixed order and omits defaults", () => {
    expect(
      serializeSearchParams({ sort: "date", oa: true, year_to: 2021, year_from: 2019, q: " gnn " }, NOW).toString(),
    ).toBe("q=gnn&year_from=2019&year_to=2021&oa=1&sort=date");
    expect(serializeSearchParams({ q: "gnn", sort: "relevance", oa: false }, NOW).toString()).toBe("q=gnn");
  });

  it("drops values the API would reject", () => {
    expect(serializeSearchParams({ q: "x", year_from: 1500, year_to: 3000 }, NOW).toString()).toBe("q=x");
    expect(serializeSearchParams({ q: "x", year_from: 2021, year_to: 2019 }, NOW).toString()).toBe("q=x");
  });

  it("round-trips through the parser", () => {
    const search = "q=a+b&year_from=2000&oa=1&sort=citations";
    expect(serializeSearchParams(parse(search), NOW).toString()).toBe(search);
  });

  it("keeps filters without words", () => {
    expect(serializeSearchParams({ q: "", oa: true }, NOW).toString()).toBe("oa=1");
  });
});

describe("toApiParams", () => {
  it("pages relevance by number", () => {
    expect(toApiParams({ q: "x", year_from: 2019, oa: true }, { page: 2 })).toEqual({
      q: "x",
      size: 20,
      year_from: 2019,
      open_access_only: true,
      page: 2,
    });
  });

  it("pages the sorted modes by cursor", () => {
    expect(toApiParams({ q: "x", sort: "date" }, { cursor: "abc" })).toEqual({
      q: "x",
      size: 20,
      sort: "date",
      cursor: "abc",
    });
    expect(usesCursor("citations")).toBe(true);
    expect(usesCursor("relevance")).toBe(false);
    expect(usesCursor(undefined)).toBe(false);
  });
});

describe("helpers", () => {
  it("counts the year range once and ignores the sort", () => {
    expect(activeFilterCount({ q: "x" })).toBe(0);
    expect(activeFilterCount({ q: "x", year_from: 2000, year_to: 2001, sort: "date" })).toBe(1);
    expect(activeFilterCount({ q: "x", year_to: 2001, oa: true })).toBe(2);
  });

  it("accepts years from 1800 to next year", () => {
    expect(maxSearchYear(NOW)).toBe(2027);
    expect(parseYear("1800", NOW)).toBe(1800);
    expect(parseYear(" 2027 ", NOW)).toBe(2027);
    expect(parseYear("2028", NOW)).toBeUndefined();
    expect(parseYear("20.5", NOW)).toBeUndefined();
    expect(parseYear("", NOW)).toBeUndefined();
  });

  it("counts next year in UTC, as the server does", () => {
    // Already 2027 east of UTC (e.g. Italy), still 2026 in UTC.
    expect(maxSearchYear(new Date("2026-12-31T23:30:00Z"))).toBe(2027);
    expect(maxSearchYear(new Date("2027-01-01T00:30:00Z"))).toBe(2028);
  });
});
