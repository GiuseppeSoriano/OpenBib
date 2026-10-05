import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import i18n from "@/i18n";
import PaperCard from "@/components/paper/PaperCard";
import type { PaperMetadata } from "@/types";

const paper: PaperMetadata = {
  canonical_key: "doi:10.1/test",
  paper_group_key: "group:test",
  title: "A Very Important Paper",
  authors: [
    { name: "Alice Smith", openalex_id: null, orcid: null, affiliations: [] },
    { name: "Bob Jones", openalex_id: null, orcid: null, affiliations: [] },
  ],
  abstract: "Some abstract text.",
  publication_date: "2024-03-01",
  doi: "10.1/test",
  arxiv_id: null,
  pmid: null,
  pmcid: null,
  openalex_id: null,
  venue: "Journal of Tests",
  volume: null,
  issue: null,
  pages: null,
  paper_type: null,
  topics: ["Machine Learning"],
  keywords: [],
  open_access: true,
  pdf_url: null,
  abstract_url: null,
  cited_by_count: 12,
  reference_count: null,
  version: null,
  provider_source: "openalex",
  provider_sources: ["openalex"],
};

function renderCard(props: Partial<Parameters<typeof PaperCard>[0]> = {}) {
  return render(
    <I18nextProvider i18n={i18n}>
      <PaperCard paper={paper} {...props} />
    </I18nextProvider>,
  );
}

describe("PaperCard", () => {
  it("renders title, authors, and a quiet meta line", () => {
    renderCard();
    expect(screen.getByText("A Very Important Paper")).toBeInTheDocument();
    expect(screen.getByText("Alice Smith, Bob Jones")).toBeInTheDocument();
    expect(screen.getByText(/Journal of Tests · 2024/)).toHaveTextContent(
      "Journal of Tests · 2024 · Cited by 12 · OpenAlex",
    );
    // The source list would only repeat the provider credited with the count.
    expect(screen.queryByText(/— OpenAlex/)).toBeNull();
  });

  it("shows which provider the citation count comes from as visible text", () => {
    renderCard();
    expect(screen.getByText("· OpenAlex")).toBeVisible();
    expect(screen.getByText(/Citation count from OpenAlex/)).toHaveClass("sr-only");
    expect(screen.getByTitle("Citation count from OpenAlex")).toHaveTextContent("Cited by 12");
  });

  it("formats large citation counts with the locale's grouping", () => {
    renderCard({ paper: { ...paper, cited_by_count: 10565 } });
    expect(screen.getByTitle("Citation count from OpenAlex")).toHaveTextContent("Cited by 10,565");
  });

  it("lists the sources when they add to the citation provenance", () => {
    renderCard({ providerSources: ["openalex", "crossref"] });
    expect(screen.getByText(/— OpenAlex, Crossref/)).toBeInTheDocument();
  });

  it("names the source when there is no citation count", () => {
    renderCard({ paper: { ...paper, cited_by_count: null } });
    expect(document.querySelector(".paper-meta")).toHaveTextContent("Journal of Tests · 2024 — OpenAlex");
  });

  it("renders a note under the meta line", () => {
    renderCard({ note: <p>Possible other version</p> });
    const note = screen.getByText("Possible other version");
    expect(document.querySelector(".paper-meta")?.nextElementSibling).toBe(note);
  });

  it("previews a structured abstract without leaking markup", () => {
    renderCard({
      paper: {
        ...paper,
        title: "Clean title",
        abstract: "<h4>Background</h4>Odor <i>coding</i><h4>Results</h4>p < 0.05<script>x()</script>",
      },
    });
    const preview = document.querySelector(".paper-abstract");
    expect(preview).toHaveTextContent("Background: Odor coding Results: p < 0.05");
    expect(preview?.textContent).not.toMatch(/<\/?[a-z]/i);
    expect(preview?.textContent).not.toContain("x()");
  });

  it("keeps tag-like literal text in the preview", () => {
    const abstract = "Typed Box<T> handles <mask> tokens when x<a and y>b.";
    renderCard({ paper: { ...paper, abstract } });
    expect(document.querySelector(".paper-abstract")?.textContent).toBe(abstract);
  });

  it("never shows the raw DOI or canonical key", () => {
    renderCard();
    expect(screen.queryByText(/doi:10/)).toBeNull();
    expect(screen.queryByText("10.1/test")).toBeNull();
  });

  it("opens details when the title is clicked", () => {
    const onOpenDetails = vi.fn();
    renderCard({ onOpenDetails });
    fireEvent.click(screen.getByRole("button", { name: "A Very Important Paper" }));
    expect(onOpenDetails).toHaveBeenCalledOnce();
  });

  it("renders topics only when requested", () => {
    renderCard();
    expect(screen.queryByText("Machine Learning")).toBeNull();
    renderCard({ showTopics: true });
    expect(screen.getByText("Machine Learning")).toBeInTheDocument();
  });

  it("renders the actions slot", () => {
    renderCard({ actions: <button>Custom action</button> });
    expect(screen.getByRole("button", { name: "Custom action" })).toBeInTheDocument();
  });

  it("renders as a hairline row with an italic venue and open access in the meta line", () => {
    renderCard({ variant: "row" });
    const article = document.querySelector("article");
    expect(article).toHaveClass("paper-card--row");
    expect(article).not.toHaveClass("card");
    expect(screen.getByText("Journal of Tests")).toHaveClass("paper-venue");
    expect(document.querySelector(".paper-meta")).toHaveTextContent(
      "Journal of Tests · 2024 · Cited by 12, Citation count from OpenAlex · Open Access",
    );
    // The provider is named for assistive tech and in the tooltip, not in every row.
    expect(document.querySelector(".paper-citations-source")).toBeNull();
    expect(document.querySelector(".paper-citations")).toHaveAttribute("title", "Citation count from OpenAlex");
    // Open access moves from a title badge to the meta line.
    expect(document.querySelector(".paper-title-row .badge")).toBeNull();
  });
});
