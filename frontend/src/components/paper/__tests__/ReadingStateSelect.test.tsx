import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
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

describe("ReadingStateSelect", () => {
  it("refreshes state-filtered Library pages and facets after a change", async () => {
    const user = userEvent.setup();
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    render(
      <QueryClientProvider client={queryClient}>
        <ReadingStateSelect paperKey="doi:10.1/a" />
      </QueryClientProvider>,
    );

    await user.selectOptions(screen.getByTestId("reading-state-select"), "reading");

    await waitFor(() =>
      expect(invalidate).toHaveBeenCalledWith({ queryKey: ["library-entries"] }),
    );
    expect(papers.setState).toHaveBeenCalledWith("doi:10.1/a", "reading");
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["paper-states", "doi:10.1/a"] });
  });
});
