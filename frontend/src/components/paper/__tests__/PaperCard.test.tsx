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
    expect(screen.getByText(/Journal of Tests · 2024 · 12 citations/)).toBeInTheDocument();
    expect(screen.getByText(/OpenAlex/)).toBeInTheDocument();
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
});
