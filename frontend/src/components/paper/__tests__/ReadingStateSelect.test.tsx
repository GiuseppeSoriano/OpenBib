import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider, focusManager } from "@tanstack/react-query";
import ReadingStateSelect from "@/components/paper/ReadingStateSelect";
import { papers } from "@/lib/api";

vi.mock("@/lib/api", () => ({
  papers: {
    getStates: vi.fn(() => Promise.resolve([])),
    setState: vi.fn((key: string, state: string) =>
      Promise.resolve({ paper_canonical_key: key, state, updated_at: "2026-01-01T00:00:00Z" }),
    ),
  },
}));

function renderSelect(queryClient: QueryClient, fromList = false) {
  return render(
    <QueryClientProvider client={queryClient}>
      <ReadingStateSelect paperKey="doi:10.1/a" fromList={fromList} />
    </QueryClientProvider>,
  );
}

function seededClient() {
  // Default staleTime (0): only `fromList` keeps the row from refetching.
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  queryClient.setQueryData(
    ["paper-states", "doi:10.1/a"],
    [{ paper_canonical_key: "doi:10.1/a", state: "read" }],
  );
  return queryClient;
}

function refocus() {
  act(() => focusManager.setFocused(false));
  act(() => focusManager.setFocused(true));
}

describe("ReadingStateSelect", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => focusManager.setFocused(undefined));

  it("refreshes state-filtered Library pages and stores the saved state without a refetch", async () => {
    const user = userEvent.setup();
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    renderSelect(queryClient);
    await waitFor(() => expect(papers.getStates).toHaveBeenCalledTimes(1));

    await user.selectOptions(screen.getByTestId("reading-state-select"), "reading");

    await waitFor(() =>
      expect(invalidate).toHaveBeenCalledWith({ queryKey: ["library-entries"] }),
    );
    expect(papers.setState).toHaveBeenCalledWith("doi:10.1/a", "reading");
    expect(queryClient.getQueryData(["paper-states", "doi:10.1/a"])).toEqual([
      expect.objectContaining({ paper_canonical_key: "doi:10.1/a", state: "reading" }),
    ]);
    expect(screen.getByTestId("reading-state-select")).toHaveValue("reading");
    expect(invalidate).not.toHaveBeenCalledWith({ queryKey: ["paper-states", "doi:10.1/a"] });
    expect(papers.getStates).toHaveBeenCalledTimes(1);
  });

  it("reads a state seeded by a list response without its own request, even on focus", async () => {
    renderSelect(seededClient(), true);

    expect(screen.getByTestId("reading-state-select")).toHaveValue("read");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(papers.getStates).not.toHaveBeenCalled();
    refocus();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(papers.getStates).not.toHaveBeenCalled();
    expect(screen.getByTestId("reading-state-select")).toHaveValue("read");
  });

  it("refetches seeded data on mount and focus without fromList", async () => {
    renderSelect(seededClient());

    await waitFor(() => expect(papers.getStates).toHaveBeenCalledTimes(1));
    refocus();
    await waitFor(() => expect(papers.getStates).toHaveBeenCalledTimes(2));
  });
});
