import { describe, expect, it } from "vitest";
import {
  describeStoredKey,
  doiUrl,
  normalizeDoi,
  parseIdentifier,
  parseIdentifierList,
  stripDoiPrefixes,
} from "@/lib/identifiers";

// The same table as backend/tests/test_identifiers.py.
const TNN = "10.1109/tnn.2008.2005605";

const VALID: [string, string][] = [
  ["10.1109/tnn.2008.2005605", TNN],
  ["doi:10.1109/tnn.2008.2005605", TNN],
  ["DOI: 10.1109/TNN.2008.2005605", TNN],
  ["DOI 10.1109/tnn.2008.2005605", TNN],
  ["https://doi.org/10.1109/tnn.2008.2005605", TNN],
  ["http://dx.doi.org/10.1109/tnn.2008.2005605", TNN],
  ["https://dx.doi.org/10.1109/tnn.2008.2005605", TNN],
  ["https://www.doi.org/10.1109/tnn.2008.2005605", TNN],
  ["doi.org/10.1109/tnn.2008.2005605", TNN],
  ["10.1109/TNN.2008.2005605", TNN],
  ["  10.1109/tnn.2008.2005605\n", TNN],
  ["\u00a010.1109/tnn.2008.2005605\u00a0", TNN],
  ["\u200b10.1109/tnn.2008.2005605\ufeff", TNN],
  ["https://doi.org/10.1109%2Ftnn.2008.2005605", TNN],
  ["https%3A%2F%2Fdoi.org%2F10.1109%2Ftnn.2008.2005605", TNN],
  ["doi:doi:10.1109/tnn.2008.2005605", TNN],
  [
    "10.1002/(SICI)1097-4636(199812)43:4<359::AID-JBM1>3.0.CO;2-H",
    "10.1002/(sici)1097-4636(199812)43:4<359::aid-jbm1>3.0.co;2-h",
  ],
  ["https://doi.org/10.1000/end.", "10.1000/end."],
  ["10.1/x", "10.1/x"],
];

const INVALID = ["not-a-doi", "10.1/", "", "   ", "http://example.com/x", "group:abc", "doi:", "10.x/y"];

const S2_ID = "3efd851140aa28e95221b55fcc5659eea97b172d";

describe("identifiers — DOI case table", () => {
  it.each(VALID)("normalizes %j to one DOI", (raw, doi) => {
    expect(normalizeDoi(raw)).toBe(doi);
    expect(parseIdentifier(raw)).toEqual({
      kind: "doi",
      canonicalKey: `doi:${doi}`,
      doi,
      lookupId: doi,
    });
  });

  it.each(INVALID)("rejects %j", (raw) => {
    expect(normalizeDoi(raw)).toBeNull();
    expect(parseIdentifier(raw)).toBeNull();
  });

  it("decodes percent escapes only in URL forms", () => {
    expect(stripDoiPrefixes("https://doi.org/10.1000/a%2Fb", { decode: true })).toBe("10.1000/a/b");
    expect(stripDoiPrefixes("https://doi.org/10.1000/a%2Fb")).toBe("10.1000/a%2Fb");
    expect(normalizeDoi("10.1109%2Ftnn.2008.2005605")).toBeNull();
  });

  it("rejects input longer than the API accepts", () => {
    expect(parseIdentifier(`10.1/${"x".repeat(600)}`)).toBeNull();
  });
});

describe("identifiers — other kinds", () => {
  it.each([
    [" hash:collpub ", "hash", "hash:collpub"],
    [`s2:${S2_ID.toUpperCase()}`, "s2", `s2:${S2_ID}`],
    [`https://www.semanticscholar.org/paper/The-Graph-Neural-Network-Model/${S2_ID}`, "s2", `s2:${S2_ID}`],
    [`semanticscholar.org/paper/${S2_ID}`, "s2", `s2:${S2_ID}`],
    ["arxiv:2306.00001", "arxiv", "arxiv:2306.00001"],
    ["arXiv:2306.00001v2", "arxiv", "arxiv:2306.00001"],
    ["2306.00001", "arxiv", "arxiv:2306.00001"],
    ["2306.12345v3", "arxiv", "arxiv:2306.12345"],
    ["https://arxiv.org/abs/2306.00001v1", "arxiv", "arxiv:2306.00001"],
    ["https://arxiv.org/pdf/2306.00001v2.pdf", "arxiv", "arxiv:2306.00001"],
    ["http://export.arxiv.org/abs/2306.00001?context=cs", "arxiv", "arxiv:2306.00001"],
    ["arxiv:hep-th/9901001", "arxiv", "arxiv:hep-th/9901001"],
    ["pmid:12345678", "pmid", "pmid:12345678"],
    ["PMID: 42", "pmid", "pmid:42"],
    ["pmcid:pmc1234567", "pmcid", "pmcid:PMC1234567"],
  ])("parses %j as %s", (raw, kind, canonicalKey) => {
    expect(parseIdentifier(raw)).toMatchObject({ kind, canonicalKey, doi: null });
  });

  it.each([
    "s2:abc",
    `https://www.semanticscholar.org/paper/a/b/${S2_ID}`,
    "arxiv:not an id",
    "arxiv:",
    "2306.00001V2",
    "pmid:abc",
    "pmid:1234567890",
    "pmcid:1234",
    "2306.1",
  ])(
    "rejects the malformed %j",
    (raw) => {
      expect(parseIdentifier(raw)).toBeNull();
    },
  );
});

// STRONG and STRONG_INVALID from backend/tests/test_identifiers.py, verbatim.
const STRONG: [string, string, string][] = [
  [`s2:${S2_ID}`, "s2", `s2:${S2_ID}`],
  [` S2:${S2_ID.toUpperCase()} `, "s2", `s2:${S2_ID}`],
  [`https://www.semanticscholar.org/paper/${S2_ID}`, "s2", `s2:${S2_ID}`],
  [
    `https://www.semanticscholar.org/paper/The-Graph-Neural-Network-Model/${S2_ID.toUpperCase()}`,
    "s2",
    `s2:${S2_ID}`,
  ],
  [`semanticscholar.org/paper/${S2_ID}/`, "s2", `s2:${S2_ID}`],
  ["arxiv:2501.00663", "arxiv", "arxiv:2501.00663"],
  ["arXiv:2501.00663v2", "arxiv", "arxiv:2501.00663"],
  ["2501.00663", "arxiv", "arxiv:2501.00663"],
  ["0704.0001v1", "arxiv", "arxiv:0704.0001"],
  ["https://arxiv.org/abs/2501.00663v3", "arxiv", "arxiv:2501.00663"],
  ["http://arxiv.org/pdf/2501.00663v1.pdf", "arxiv", "arxiv:2501.00663"],
  ["arxiv.org/abs/2501.00663", "arxiv", "arxiv:2501.00663"],
  ["arXiv:hep-th/9901001v2", "arxiv", "arxiv:hep-th/9901001"],
  ["https://arxiv.org/abs/math.GT/0309136", "arxiv", "arxiv:math.gt/0309136"],
  ["pmid:31452104", "pmid", "pmid:31452104"],
  ["PMID: 31452104", "pmid", "pmid:31452104"],
  ["pmcid:PMC2323736", "pmcid", "pmcid:PMC2323736"],
  ["PMCID:pmc2323736", "pmcid", "pmcid:PMC2323736"],
];
const STRONG_INVALID = [
  "s2:" + "a".repeat(39),
  "s2:" + "g".repeat(40),
  S2_ID,
  "https://www.semanticscholar.org/author/123",
  "arxiv:not-an-id",
  "250.00663",
  "https://arxiv.org/list/cs.LG/recent",
  "pmid:abc",
  "pmcid:2323736",
  "PMC2323736",
];

describe("identifiers — strong-kind case table", () => {
  it.each(STRONG)("parses %j as %s", (raw, kind, key) => {
    expect(parseIdentifier(raw)).toMatchObject({ kind, canonicalKey: key, doi: null });
    // A stored key parses back to itself, as `parse_lookup_key(key)` does.
    expect(parseIdentifier(key)).toMatchObject({ kind, canonicalKey: key });
  });

  it.each(STRONG_INVALID)("rejects the malformed %j", (raw) => {
    expect(parseIdentifier(raw)).toBeNull();
  });
});

describe("parseIdentifierList", () => {
  it("keeps line numbers, separates invalid lines and repeated identifiers", () => {
    const list = parseIdentifierList(
      "10.1/a\n\nnot-a-doi\nhttps://doi.org/10.1/A\r\narxiv:2306.00001\n  \n10.1/b",
    );
    expect(list.valid.map((v) => [v.line, v.input, v.identifier.canonicalKey])).toEqual([
      [1, "10.1/a", "doi:10.1/a"],
      [5, "arxiv:2306.00001", "arxiv:2306.00001"],
      [7, "10.1/b", "doi:10.1/b"],
    ]);
    expect(list.invalid).toEqual([{ line: 3, value: "not-a-doi" }]);
    expect(list.duplicates).toEqual([{ line: 4, value: "https://doi.org/10.1/A", firstLine: 1 }]);
  });

  it("returns empty lists for blank input", () => {
    expect(parseIdentifierList("  \n\n")).toEqual({ valid: [], invalid: [], duplicates: [] });
  });
});

describe("describeStoredKey", () => {
  it("links recognizable identifiers", () => {
    expect(describeStoredKey("10.1109/TNN.2008.2005605")).toEqual({
      kind: "doi",
      value: TNN,
      url: `https://doi.org/${TNN}`,
    });
    expect(describeStoredKey("arxiv:2306.00001")).toMatchObject({
      url: "https://arxiv.org/abs/2306.00001",
    });
    expect(describeStoredKey(`s2:${S2_ID}`)).toMatchObject({
      kind: "s2",
      url: `https://www.semanticscholar.org/paper/${S2_ID}`,
    });
    expect(describeStoredKey("pmid:42")).toMatchObject({ url: "https://pubmed.ncbi.nlm.nih.gov/42/" });
  });

  it("never exposes a hash key and shows anything else as plain text", () => {
    expect(describeStoredKey("hash:0123abcd")).toEqual({ kind: "hash" });
    expect(describeStoredKey(" not-a-doi ")).toEqual({ kind: "invalid", value: "not-a-doi" });
    expect(describeStoredKey("doi:not-a-doi")).toEqual({ kind: "invalid", value: "not-a-doi" });
    expect(describeStoredKey("doi:")).toEqual({ kind: "invalid", value: "doi:" });
    expect(describeStoredKey("openalex:W1")).toEqual({ kind: "invalid", value: "openalex:W1" });
  });

  it("escapes URL-significant characters in doi.org links", () => {
    expect(doiUrl("10.1000/a#b?c")).toBe("https://doi.org/10.1000/a%23b%3Fc");
  });
});
