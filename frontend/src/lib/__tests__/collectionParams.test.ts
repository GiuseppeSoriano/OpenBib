import { describe, expect, it } from "vitest";
import {
  collectionFilterCount,
  filterCollectionRows,
  parseCollectionParams,
  serializeCollectionParams,
} from "@/lib/collectionParams";
import type { CollectionPaper } from "@/types";

function row(key: string, title: string | null, extra: Partial<CollectionPaper["paper"] & object> = {}): CollectionPaper {
  return {
    paper_canonical_key: key,
    paper_group_key: null,
    position: 0,
    added_at: "2026-01-01T00:00:00Z",
    resolved: title !== null,
    paper:
      title === null
        ? null
        : ({
            canonical_key: key,
            title,
            authors: [],
            venue: null,
            publication_date: null,
            cited_by_count: null,
            ...extra,
          } as CollectionPaper["paper"]),
  };
}

describe("collectionParams", () => {
  it("parses known filters and drops empty, unknown and default values", () => {
    const sp = new URLSearchParams("q=%20graph%20&state=reading&tag=ml&sort=title&share=x");
    expect(parseCollectionParams(sp)).toEqual({ q: "graph", state: "reading", tag: "ml", sort: "title" });
    expect(parseCollectionParams(new URLSearchParams("state=nope&sort=position&q=%20"))).toEqual({});
  });

  it("serializes without defaults and keeps unrelated parameters", () => {
    const next = serializeCollectionParams({ q: " x ", sort: "position" }, new URLSearchParams("tag=a&other=1"));
    expect(next.toString()).toBe("other=1&q=x");
    expect(collectionFilterCount({ q: "x", tag: "a", sort: "year" })).toBe(2);
  });

  it("matches every term on title, authors and venue, ignoring accents, and unresolved rows on their key", () => {
    const rows = [
      row("doi:1", "Gödel Machines", { authors: [{ name: "Jürgen Schmidhuber" }] as never }),
      row("doi:2", "Residual Learning", { venue: "CVPR" }),
      row("10.1109/tnn.2008.2005605", null),
    ];
    const none = () => ({ tags: [] });
    const titles = (q: string) => filterCollectionRows(rows, { q }, none).map((r) => r.paper_canonical_key);
    expect(titles("godel jurgen")).toEqual(["doi:1"]);
    expect(titles("cvpr")).toEqual(["doi:2"]);
    expect(titles("tnn.2008")).toEqual(["10.1109/tnn.2008.2005605"]);
    expect(titles("godel cvpr")).toEqual([]);
  });

  it("matches an unresolved row on what its card shows, not on the hidden key", () => {
    const rows = [
      row("pmid:42", null),
      row("s2:0123456789abcdef0123456789abcdef01234567", null),
      row("hash:0123abcd", null),
      row("doi:not-a-doi", null),
    ];
    const none = () => ({ tags: [] });
    const labels = { pmid: "PubMed", s2: "Semantic Scholar record", hash: "Internal reference" };
    const keys = (q: string) =>
      filterCollectionRows(rows, { q }, none, "en", labels).map((r) => r.paper_canonical_key);
    expect(keys("pubmed 42")).toEqual(["pmid:42"]);
    expect(keys("semantic scholar")).toEqual(["s2:0123456789abcdef0123456789abcdef01234567"]);
    expect(keys("internal")).toEqual(["hash:0123abcd"]);
    expect(keys("not-a-doi")).toEqual(["doi:not-a-doi"]);
    // The prefixes and the hidden hex of s2: and hash: keys are not shown, so they do not match.
    expect(keys("pmid")).toEqual([]);
    expect(keys("s2")).toEqual([]);
    expect(keys("0123")).toEqual([]);
  });

  it("sorts with missing values last and keeps the collection order on ties", () => {
    const rows = [
      row("a", "B", { cited_by_count: null }),
      row("b", "a", { cited_by_count: 5 }),
      row("c", null),
      row("d", "c", { cited_by_count: 5 }),
    ];
    const none = () => ({ tags: [] });
    const keys = (sort: "title" | "citations") => filterCollectionRows(rows, { sort }, none).map((r) => r.paper_canonical_key);
    expect(keys("title")).toEqual(["b", "a", "d", "c"]);
    expect(keys("citations")).toEqual(["b", "d", "a", "c"]);
  });
});
