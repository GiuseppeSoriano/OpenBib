import { mockRefresh } from "@/test/auth-mock";
import { afterEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import UnresolvedPaperCard from "@/components/paper/UnresolvedPaperCard";
import { library } from "@/lib/api";
import { renderWithProviders } from "@/test/utils";

vi.mock("@/lib/api", () => ({
  refreshAccessToken: vi.fn(() => mockRefresh()),
  setAccessToken: vi.fn(),
  setAuthFailureHandler: vi.fn(),
  default: { get: vi.fn(() => Promise.resolve({ data: [] })), post: vi.fn() },
  library: { resolve: vi.fn() },
  papers: {},
  notes: {},
  graph: {},
  zotero: {},
}));

const S2_ID = "3efd851140aa28e95221b55fcc5659eea97b172d";

function result(status: "resolved" | "not_found" | "unavailable", title?: string) {
  return {
    status,
    previous_key: "10.1109/TNN.2008.2005605",
    canonical_key: "10.1109/TNN.2008.2005605",
    paper_group_key: null,
    paper: title ? ({ title } as never) : null,
    moved: {},
  };
}

afterEach(() => {
  vi.mocked(library.resolve).mockReset();
});

describe("UnresolvedPaperCard — identifier display", () => {
  it("shows a DOI as a doi.org link that says it opens in a new tab", () => {
    renderWithProviders(<UnresolvedPaperCard canonicalKey="10.1109/TNN.2008.2005605" canEdit={false} />);
    expect(screen.getByText("Details unavailable")).toBeInTheDocument();
    expect(screen.getByText("Unresolved")).toBeInTheDocument();
    const link = screen.getByRole("link", { name: /10\.1109\/tnn\.2008\.2005605.*opens in a new tab/ });
    expect(link).toHaveAttribute("href", "https://doi.org/10.1109/tnn.2008.2005605");
    expect(link).toHaveAttribute("target", "_blank");
    expect(link.parentElement).toHaveTextContent(/^DOI 10\.1109/);
  });

  it.each([
    ["arxiv:2306.00001", /2306\.00001/, "https://arxiv.org/abs/2306.00001"],
    [`s2:${S2_ID}`, /Semantic Scholar record/, `https://www.semanticscholar.org/paper/${S2_ID}`],
    ["pmid:12345", /12345/, "https://pubmed.ncbi.nlm.nih.gov/12345/"],
  ])("links %s to its record", (key, name, href) => {
    renderWithProviders(<UnresolvedPaperCard canonicalKey={key} canEdit={false} />);
    expect(screen.getByRole("link", { name })).toHaveAttribute("href", href);
  });

  it("shows an invalid key as plain text and never shows a hash key", () => {
    const { unmount } = renderWithProviders(<UnresolvedPaperCard canonicalKey="not-a-doi" canEdit={false} />);
    expect(screen.getByText("Identifier: not-a-doi")).toBeInTheDocument();
    expect(screen.queryByRole("link")).toBeNull();
    unmount();

    const { container } = renderWithProviders(
      <UnresolvedPaperCard canonicalKey="hash:0123abcd" addedAt="2026-02-01T10:00:00Z" canEdit />,
    );
    expect(screen.getByText(/^Internal reference · added .*2026/)).toBeInTheDocument();
    expect(container.textContent).not.toMatch(/hash:|0123abcd/);
  });

  it("shows an invalid DOI-shaped key without its prefix", async () => {
    const user = userEvent.setup();
    renderWithProviders(<UnresolvedPaperCard canonicalKey="doi:not-a-doi" canEdit />);
    expect(screen.getByText("Identifier: not-a-doi")).toBeInTheDocument();
    expect(screen.queryByRole("link")).toBeNull();

    await user.click(screen.getByRole("button", { name: "Fix identifier" }));
    expect(screen.getByLabelText("Correct DOI or arXiv ID")).toHaveValue("not-a-doi");
  });

  it("offers no recovery actions to readers", () => {
    renderWithProviders(
      <UnresolvedPaperCard
        canonicalKey="10.1/x"
        canEdit={false}
        actions={() => <button type="button">Remove</button>}
      />,
    );
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Fix identifier" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Remove" })).toBeNull();
    expect(screen.getByText("Details for this identifier aren’t available yet.")).toBeInTheDocument();
  });
});

describe("UnresolvedPaperCard — recovery", () => {
  it.each(["hash:0123abcd", "not-a-doi", "openalex:W1"])(
    "offers only Fix identifier for %j, which cannot be looked up again",
    (key) => {
      renderWithProviders(
        <UnresolvedPaperCard
          canonicalKey={key}
          addedAt="2026-02-01T10:00:00Z"
          canEdit
          actions={() => <button type="button">Remove</button>}
        />,
      );
      expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
      expect(screen.getByRole("button", { name: "Fix identifier" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Remove" })).toBeInTheDocument();
    },
  );

  it("describes every action by the identifier line", () => {
    renderWithProviders(
      <UnresolvedPaperCard
        canonicalKey="10.1/x"
        canEdit
        actions={(describedBy) => (
          <button type="button" aria-describedby={describedBy}>
            Remove
          </button>
        )}
      />,
    );
    const identifier = screen.getByText("DOI", { exact: false, selector: "p" });
    for (const name of ["Try again", "Fix identifier", "Remove"]) {
      expect(screen.getByRole("button", { name })).toHaveAttribute("aria-describedby", identifier.id);
    }
  });

  it("retries the stored key and reports a paper that is still unavailable", async () => {
    const user = userEvent.setup();
    vi.mocked(library.resolve).mockResolvedValue(result("unavailable"));
    const onResolved = vi.fn();
    renderWithProviders(<UnresolvedPaperCard canonicalKey="10.1109/TNN.2008.2005605" canEdit onResolved={onResolved} />);

    await user.click(screen.getByRole("button", { name: "Try again" }));

    expect(library.resolve).toHaveBeenCalledWith({
      paper_canonical_key: "10.1109/TNN.2008.2005605",
      replacement: null,
    });
    expect(await screen.findByText(/still has no details/)).toHaveAttribute("role", "status");
    expect(onResolved).toHaveBeenCalledWith(expect.objectContaining({ status: "unavailable" }));
  });

  it("validates a fix before sending it and sends a valid replacement", async () => {
    const user = userEvent.setup();
    vi.mocked(library.resolve).mockResolvedValue(result("resolved", "Graph Neural Networks"));
    renderWithProviders(<UnresolvedPaperCard canonicalKey="not-a-doi" canEdit />);

    await user.click(screen.getByRole("button", { name: "Fix identifier" }));
    const input = screen.getByLabelText("Correct DOI or arXiv ID");
    expect(input).toHaveValue("not-a-doi");
    await user.click(screen.getByRole("button", { name: "Apply" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Enter a DOI");
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(input).toHaveAttribute("aria-describedby", alert.id);
    expect(library.resolve).not.toHaveBeenCalled();

    await user.clear(input);
    await user.type(input, "https://doi.org/10.1109/TNN.2008.2005605");
    expect(input).not.toHaveAttribute("aria-invalid");
    await user.click(screen.getByRole("button", { name: "Apply" }));

    await waitFor(() =>
      expect(library.resolve).toHaveBeenCalledWith({
        paper_canonical_key: "not-a-doi",
        replacement: "https://doi.org/10.1109/TNN.2008.2005605",
      }),
    );
    expect(await screen.findByText("Details found for “Graph Neural Networks”.")).toBeInTheDocument();
    expect(screen.queryByLabelText("Correct DOI or arXiv ID")).toBeNull();
  });

  it("keeps the fix form open with the server's reason when nothing is found", async () => {
    const user = userEvent.setup();
    vi.mocked(library.resolve).mockResolvedValue(result("not_found"));
    renderWithProviders(<UnresolvedPaperCard canonicalKey="10.1/typo" canEdit />);

    await user.click(screen.getByRole("button", { name: "Fix identifier" }));
    await user.clear(screen.getByLabelText("Correct DOI or arXiv ID"));
    await user.type(screen.getByLabelText("Correct DOI or arXiv ID"), "10.1/right");
    await user.click(screen.getByRole("button", { name: "Apply" }));

    const form = screen.getByLabelText("Correct DOI or arXiv ID").closest("form")!;
    expect(await within(form).findByRole("alert")).toHaveTextContent("No paper was found");
  });

  it("lets the page handle lost access and otherwise shows the coded error", async () => {
    const user = userEvent.setup();
    const forbidden = { response: { status: 403 } };
    vi.mocked(library.resolve).mockRejectedValueOnce(forbidden).mockRejectedValueOnce({
      response: {
        status: 503,
        headers: { "retry-after": "20" },
        data: { detail: { code: "provider_unavailable", message: "down" } },
      },
    });
    const onResolveError = vi.fn((err: unknown) => err === forbidden);
    renderWithProviders(<UnresolvedPaperCard canonicalKey="10.1/x" canEdit onResolveError={onResolveError} />);

    await user.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(onResolveError).toHaveBeenCalledWith(forbidden));
    expect(screen.queryByRole("alert")).toBeNull();

    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Semantic Scholar is unavailable right now. Try again in 20 s.",
    );
    expect(screen.getByRole("button", { name: "Try again" })).toBeDisabled();
  });
});
