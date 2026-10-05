import { describe, expect, it } from "vitest";
import {
  activeFilterCount,
  parseLibraryParams,
  serializeLibraryParams,
} from "@/lib/libraryParams";

const COLLECTION = "0b5f3c2e-8d4a-4c1b-9e7f-2a6d8c4b1e30";

describe("libraryParams", () => {
  it("parses known filters and drops empty, unknown and default values", () => {
    const sp = new URLSearchParams(
      `q=%20graph%20&state=reading&tag=ml&collection_id=${COLLECTION}&sort=year&focus=group%3Ax`,
    );
    expect(parseLibraryParams(sp)).toEqual({
      q: "graph",
      state: "reading",
      tag: "ml",
      collection_id: COLLECTION,
      sort: "year",
    });
    expect(parseLibraryParams(new URLSearchParams("q=&state=bogus&sort=added&tag="))).toEqual({});
    expect(parseLibraryParams(new URLSearchParams("sort=random"))).toEqual({});
  });

  it("drops values the API would reject", () => {
    const sp = new URLSearchParams({ collection_id: "gone", tag: "t".repeat(101) });
    expect(parseLibraryParams(sp)).toEqual({});
    expect(parseLibraryParams(new URLSearchParams({ tag: "t".repeat(100) })).tag).toHaveLength(100);
  });

  it("caps the search at 200 characters", () => {
    const sp = new URLSearchParams({ q: "x".repeat(250) });
    expect(parseLibraryParams(sp).q).toHaveLength(200);
  });

  it("serializes without defaults and keeps unrelated parameters", () => {
    const base = new URLSearchParams("focus=group%3Ax&q=old&state=read");
    const next = serializeLibraryParams({ q: " new ", sort: "added", tag: "ml" }, base);
    expect(next.toString()).toBe("focus=group%3Ax&q=new&tag=ml");
    expect(serializeLibraryParams({}).toString()).toBe("");
    expect(serializeLibraryParams({ sort: "citations" }).toString()).toBe("sort=citations");
  });

  it("round-trips", () => {
    const params = {
      q: "müller",
      state: "to_read",
      collection_id: COLLECTION,
      sort: "title",
    } as const;
    expect(parseLibraryParams(serializeLibraryParams(params))).toEqual(params);
  });

  it("counts filters but not the sort", () => {
    expect(activeFilterCount({})).toBe(0);
    expect(activeFilterCount({ sort: "title" })).toBe(0);
    expect(activeFilterCount({ q: "x", state: "read", tag: "t", collection_id: "c" })).toBe(4);
  });
});
