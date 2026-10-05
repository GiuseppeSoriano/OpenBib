import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider, focusManager } from "@tanstack/react-query";
import ReadingStateSelect from "@/components/paper/ReadingStateSelect";
import { ToastProvider } from "@/components/ui/Toast";
import { papers } from "@/lib/api";
import type { PaperState } from "@/types";

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
      <ToastProvider>
        <ReadingStateSelect paperKey="doi:10.1/a" fromList={fromList} />
      </ToastProvider>
    </QueryClientProvider>,
  );
}

function seededClient() {
  // Default staleTime (0): only `fromList` keeps the row from refetching.
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
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

const chip = () => screen.getByTestId("reading-state-select");

describe("ReadingStateSelect", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => focusManager.setFocused(undefined));

  it("refreshes state-filtered Library pages and stores the saved state without a refetch", async () => {
    const user = userEvent.setup();
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    renderSelect(queryClient);
    await waitFor(() => expect(papers.getStates).toHaveBeenCalledTimes(1));
    expect(screen.getByRole("button", { name: "Reading state: No state" })).toBe(chip());

    await user.click(chip());
    await user.click(screen.getByRole("option", { name: "Reading" }));

    await waitFor(() =>
      expect(invalidate).toHaveBeenCalledWith({ queryKey: ["library-entries"] }),
    );
    expect(papers.setState).toHaveBeenCalledWith("doi:10.1/a", "reading");
    expect(queryClient.getQueryData(["paper-states", "doi:10.1/a"])).toEqual([
      expect.objectContaining({ paper_canonical_key: "doi:10.1/a", state: "reading" }),
    ]);
    expect(chip()).toHaveAccessibleName("Reading state: Reading");
    expect(chip()).toHaveAttribute("data-state", "reading");
    expect(invalidate).not.toHaveBeenCalledWith({ queryKey: ["paper-states", "doi:10.1/a"] });
    expect(papers.getStates).toHaveBeenCalledTimes(1);
  });

  it("reads a state seeded by a list response without its own request, even on focus", async () => {
    renderSelect(seededClient(), true);

    expect(chip()).toHaveAccessibleName("Reading state: Read");
    expect(chip()).toHaveAttribute("data-state", "read");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(papers.getStates).not.toHaveBeenCalled();
    refocus();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(papers.getStates).not.toHaveBeenCalled();
    expect(chip()).toHaveAccessibleName("Reading state: Read");
  });

  it("refetches seeded data on mount and focus without fromList", async () => {
    renderSelect(seededClient());

    await waitFor(() => expect(papers.getStates).toHaveBeenCalledTimes(1));
    refocus();
    await waitFor(() => expect(papers.getStates).toHaveBeenCalledTimes(2));
  });

  it("is a listbox popover with every state, the current one selected, driven by the keyboard", async () => {
    const user = userEvent.setup();
    renderSelect(seededClient(), true);
    expect(chip()).toHaveAttribute("aria-haspopup", "listbox");
    expect(chip()).toHaveAttribute("aria-expanded", "false");

    chip().focus();
    await user.keyboard("{Enter}");
    const listbox = screen.getByRole("listbox", { name: "Reading state" });
    expect(chip()).toHaveAttribute("aria-expanded", "true");
    const options = within(listbox).getAllByRole("option");
    expect(options.map((option) => option.textContent)).toEqual([
      "Unseen", "Seen", "Saved", "To read", "Reading", "Read", "Important", "Ignored", "Excluded",
    ]);
    const read = within(listbox).getByRole("option", { name: "Read" });
    expect(read).toHaveAttribute("aria-selected", "true");
    expect(read).toHaveFocus();
    expect(read.querySelector(".state-dot--read")).not.toBeNull();

    // Escape closes without a change and gives focus back to the chip.
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(chip()).toHaveFocus();
    expect(papers.setState).not.toHaveBeenCalled();

    // Space opens; arrows move; Enter picks and returns focus to the chip.
    await user.keyboard(" ");
    await user.keyboard("{ArrowDown}");
    expect(screen.getByRole("option", { name: "Important" })).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(chip()).toHaveFocus();
    expect(papers.setState).toHaveBeenCalledWith("doi:10.1/a", "important");
    await waitFor(() => expect(chip()).toHaveAccessibleName("Reading state: Important"));
    expect(papers.getStates).not.toHaveBeenCalled();

    // Like a select, the arrow keys on the closed chip open the list on the current state.
    await waitFor(() => expect(chip()).not.toHaveAttribute("aria-disabled"));
    for (const key of ["{ArrowDown}", "{ArrowUp}"]) {
      await user.keyboard(key);
      expect(chip()).toHaveAttribute("aria-expanded", "true");
      expect(screen.getByRole("option", { name: "Important" })).toHaveFocus();
      await user.keyboard("{Escape}");
      expect(chip()).toHaveFocus();
    }
    expect(papers.setState).toHaveBeenCalledTimes(1);
  });

  it("scrolls the opened list into view, for a chip low in a long list", async () => {
    const scrollIntoView = vi.fn();
    const original = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = scrollIntoView;
    try {
      const user = userEvent.setup();
      renderSelect(seededClient(), true);
      await user.click(chip());
      const surface = screen.getByTestId("reading-state-popover");
      expect(scrollIntoView).toHaveBeenCalledWith({ block: "nearest" });
      expect(scrollIntoView.mock.contexts).toContain(surface);
    } finally {
      Element.prototype.scrollIntoView = original;
    }
  });

  it("shows the new state at once and keeps the chip focusable while saving", async () => {
    const user = userEvent.setup();
    let release: (() => void) | undefined;
    vi.mocked(papers.setState).mockImplementationOnce(
      (key, state) =>
        new Promise((resolve) => {
          release = () => resolve({ paper_canonical_key: key, state } as PaperState);
        }),
    );
    renderSelect(seededClient(), true);

    await user.click(chip());
    await user.click(screen.getByRole("option", { name: "To read" }));

    await waitFor(() => expect(chip()).toHaveAccessibleName("Reading state: To read"));
    expect(chip()).toHaveAttribute("aria-disabled", "true");
    expect(chip()).toHaveFocus();
    // A second choice waits for the first save: the chip does not open.
    await user.click(chip());
    expect(screen.queryByRole("listbox")).toBeNull();

    await act(async () => release!());
    await waitFor(() => expect(chip()).not.toHaveAttribute("aria-disabled"));
    expect(chip()).toHaveAccessibleName("Reading state: To read");
  });

  it("puts the previous state back and reports a failed save", async () => {
    const user = userEvent.setup();
    vi.mocked(papers.setState).mockRejectedValueOnce(new Error("boom"));
    const queryClient = seededClient();
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    renderSelect(queryClient, true);

    await user.click(chip());
    await user.click(screen.getByRole("option", { name: "Reading" }));

    expect(await screen.findByText("Couldn’t update the reading state.")).toBeInTheDocument();
    await waitFor(() => expect(chip()).toHaveAccessibleName("Reading state: Read"));
    expect(queryClient.getQueryData(["paper-states", "doi:10.1/a"])).toEqual([
      { paper_canonical_key: "doi:10.1/a", state: "read" },
    ]);
    expect(invalidate).not.toHaveBeenCalledWith({ queryKey: ["library-entries"] });
    // The seeded row stays seeded: no per-row request after the rollback.
    expect(papers.getStates).not.toHaveBeenCalled();
  });
});
