import { afterEach, describe, expect, it, vi } from "vitest";
import { apaAuthorList, apaAuthorName, copyText, formatCitation } from "@/lib/citation";
import type { Author, PaperMetadata } from "@/types";

const author = (name: string, extra: Partial<Author> = {}): Author => ({
  name,
  openalex_id: null,
  orcid: null,
  affiliations: [],
  ...extra,
});

function paper(overrides: Partial<PaperMetadata> = {}): PaperMetadata {
  return {
    canonical_key: "s2:abc",
    paper_group_key: "group:abc",
    title: "How Powerful are Graph Neural Networks?",
    authors: [author("Keyulu Xu"), author("Weihua Hu"), author("Jure Leskovec"), author("Stefanie Jegelka")],
    abstract: null,
    publication_date: "2019-05-06",
    doi: null,
    arxiv_id: "1810.00826",
    venue: "International Conference on Learning Representations",
    paper_type: null,
    topics: [],
    keywords: [],
    open_access: true,
    pdf_url: null,
    cited_by_count: 10565,
    reference_count: null,
    provider_source: "semantic_scholar",
    provider_sources: ["semantic_scholar"],
    ...overrides,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("APA author names", () => {
  it("puts the family name first with initials", () => {
    expect(apaAuthorName(author("Zonghan Wu"))).toBe("Wu, Z.");
    expect(apaAuthorName(author("Philip S. Yu"))).toBe("Yu, P. S.");
    expect(apaAuthorName(author("Jean-Paul Sartre"))).toBe("Sartre, J.-P.");
    expect(apaAuthorName(author("Lovelace, Ada"))).toBe("Lovelace, A.");
    expect(apaAuthorName(author("Plato"))).toBe("Plato");
  });

  it("keeps particles with the family name and suffixes at the end", () => {
    expect(apaAuthorName(author("Amauri Holanda de Souza Jr."))).toBe("de Souza, A. H., Jr.");
    expect(apaAuthorName(author("Vincent van Gogh"))).toBe("van Gogh, V.");
  });

  it("prefers structured family and given names", () => {
    expect(apaAuthorName(author("Ignored Name", { family_name: "Curie", given_name: "Marie Salomea" }))).toBe(
      "Curie, M. S.",
    );
  });

  it("joins two, several and more than twenty authors as APA does", () => {
    expect(apaAuthorList([author("Ada Lovelace")])).toBe("Lovelace, A.");
    expect(apaAuthorList([author("Ada Lovelace"), author("Charles Babbage")])).toBe(
      "Lovelace, A., & Babbage, C.",
    );
    const many = Array.from({ length: 22 }, (_, index) => author(`Given Family${index + 1}`));
    const list = apaAuthorList(many);
    expect(list.startsWith("Family1, G., Family2, G.,")).toBe(true);
    expect(list).toContain("Family19, G., … Family22, G.");
    expect(list).not.toContain("Family20");
  });
});

describe("formatCitation", () => {
  it("formats an APA-like reference with the arXiv link", () => {
    expect(formatCitation(paper())).toBe(
      "Xu, K., Hu, W., Leskovec, J., & Jegelka, S. (2019). How Powerful are Graph Neural Networks? " +
        "International Conference on Learning Representations. https://arxiv.org/abs/1810.00826",
    );
  });

  it("adds volume, issue and pages, and prefers the DOI", () => {
    const text = formatCitation(
      paper({
        title: "A Comprehensive Survey on Graph Neural Networks",
        authors: [author("Zonghan Wu"), author("Philip S. Yu")],
        publication_date: "2021-01-01",
        venue: "IEEE Transactions on Neural Networks and Learning Systems",
        volume: "32",
        issue: "1",
        pages: "4-24",
        doi: "10.1109/TNNLS.2020.2978386",
      }),
    );
    expect(text).toBe(
      "Wu, Z., & Yu, P. S. (2021). A Comprehensive Survey on Graph Neural Networks. " +
        "IEEE Transactions on Neural Networks and Learning Systems, 32(1), 4-24. " +
        "https://doi.org/10.1109/TNNLS.2020.2978386",
    );
  });

  it("handles missing authors, date, venue and links", () => {
    const text = formatCitation(
      paper({ authors: [], publication_date: null, venue: null, arxiv_id: null, title: "Untitled draft" }),
    );
    expect(text).toBe("Untitled draft. (n.d.).");
  });
});

describe("copyText", () => {
  it("writes to the clipboard", async () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    await expect(copyText("ref")).resolves.toBe(true);
    expect(writeText).toHaveBeenCalledWith("ref");
  });

  it("reports a refused copy", async () => {
    const writeText = vi.fn(() => Promise.reject(new Error("denied")));
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    const exec = vi.fn(() => false);
    Object.defineProperty(document, "execCommand", { value: exec, configurable: true });
    await expect(copyText("ref")).resolves.toBe(false);
    expect(document.querySelector("textarea")).toBeNull();
  });

  it("copies the focused selection without a clipboard API and gives focus back", async () => {
    Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true });
    const button = document.createElement("button");
    document.body.appendChild(button);
    button.focus();
    let copied = "";
    const exec = vi.fn(() => {
      const active = document.activeElement;
      copied = active instanceof HTMLTextAreaElement ? active.value : "";
      return true;
    });
    Object.defineProperty(document, "execCommand", { value: exec, configurable: true });
    await expect(copyText("ref")).resolves.toBe(true);
    expect(copied).toBe("ref");
    expect(document.querySelector("textarea")).toBeNull();
    expect(button).toHaveFocus();
    button.remove();
  });
});
