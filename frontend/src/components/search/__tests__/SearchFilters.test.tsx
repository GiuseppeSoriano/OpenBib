import { createRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import i18n from "@/i18n";
import SearchFilters, { type PersonalFilters, type SearchFiltersHandle } from "@/components/search/SearchFilters";
import { COMPACT_QUERY } from "@/lib/breakpoints";
import { maxSearchYear, type SearchParamsState } from "@/lib/searchParams";
import { mockMatchMedia, restoreMatchMedia } from "@/test/utils";

interface Options {
  personal?: PersonalFilters | null;
  personalActive?: boolean;
  resultCount?: number | null;
}

function renderFilters(params: SearchParamsState, onChange = vi.fn(), onReset = vi.fn(), options: Options = {}) {
  const ref = createRef<SearchFiltersHandle>();
  const view = render(
    <I18nextProvider i18n={i18n}>
      <SearchFilters ref={ref} params={params} onChange={onChange} onReset={onReset} {...options} />
    </I18nextProvider>,
  );
  return { ...view, ref, onChange, onReset };
}

const yearChip = () => screen.getByRole("button", { name: /^Year/ });
const sortChip = () => screen.getByRole("button", { name: /^Sort/ });
const thisYear = new Date().getUTCFullYear();

afterEach(() => {
  restoreMatchMedia();
  vi.useRealTimers();
});

describe("SearchFilters — toolbar", () => {
  it("applies open access at once", () => {
    const { onChange } = renderFilters({ q: "gnn" });
    const chip = screen.getByRole("button", { name: "Open access" });
    expect(chip).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(chip);
    expect(onChange).toHaveBeenLastCalledWith({ oa: true });
    expect(screen.queryByText(/match all of your words/)).toBeNull();
  });

  it("chooses the sort from a listbox and returns focus to its chip", () => {
    const { onChange } = renderFilters({ q: "gnn" });
    expect(sortChip()).toHaveAccessibleName("Sort Relevance");
    fireEvent.click(sortChip());
    expect(sortChip()).toHaveAttribute("aria-expanded", "true");
    const listbox = screen.getByRole("listbox", { name: "Sort by" });
    expect(within(listbox).getByRole("option", { name: "Relevance" })).toHaveFocus();
    fireEvent.keyDown(listbox, { key: "End" });
    expect(within(listbox).getByRole("option", { name: "Most cited" })).toHaveFocus();
    fireEvent.keyDown(listbox, { key: "Enter" });
    expect(onChange).toHaveBeenCalledOnce();
    expect(onChange).toHaveBeenLastCalledWith({ sort: "citations" });
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(sortChip()).toHaveFocus();
  });

  it("does not search again when the same sort is chosen", () => {
    const { onChange } = renderFilters({ q: "gnn", sort: "date" });
    fireEvent.click(sortChip());
    fireEvent.click(screen.getByRole("option", { name: "Newest first" }));
    expect(onChange).not.toHaveBeenCalled();
  });

  it("explains the matching of the date and citation sorts", () => {
    renderFilters({ q: "gnn", sort: "citations" });
    const hint = screen.getByText(/lists only papers that match all of your words/);
    expect(sortChip()).toHaveAccessibleName("Sort Most cited");
    expect(sortChip()).toHaveAccessibleDescription(hint.textContent ?? "");
  });

  it("sends typed years with a toggle and hands them to a search", () => {
    const { ref, onChange } = renderFilters({ q: "gnn", year_to: 2020 });
    const pending = () => {
      let value: unknown;
      act(() => {
        value = ref.current?.pendingYears();
      });
      return value;
    };
    expect(pending()).toEqual({});
    fireEvent.click(yearChip());
    fireEvent.change(screen.getByLabelText("From"), { target: { value: "2015" } });
    expect(pending()).toEqual({ year_from: 2015, year_to: 2020 });
    fireEvent.click(screen.getByRole("button", { name: "Open access" }));
    expect(onChange).toHaveBeenLastCalledWith({ year_from: 2015, year_to: 2020, oa: true });

    fireEvent.change(screen.getByLabelText("From"), { target: { value: "15" } });
    expect(pending()).toBeNull();
    expect(screen.getByRole("alert")).toHaveTextContent("Enter a year between 1800");
  });

  it("opens the year popover to show invalid years typed earlier", () => {
    const { ref } = renderFilters({ q: "gnn" });
    fireEvent.click(yearChip());
    fireEvent.change(screen.getByLabelText("From"), { target: { value: "1700" } });
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    act(() => {
      ref.current?.pendingYears();
    });
    expect(screen.getByRole("dialog", { name: "Publication year" })).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("Enter a year between 1800");
    expect(screen.getByLabelText("From")).toHaveFocus();
  });

  it("applies the years together and clears one left empty", () => {
    const { onChange } = renderFilters({ q: "gnn", year_from: 2010, year_to: 2012 });
    expect(yearChip()).toHaveAccessibleName("Year: 2010–2012");
    fireEvent.click(yearChip());
    fireEvent.change(screen.getByLabelText("From"), { target: { value: "2015" } });
    fireEvent.change(screen.getByLabelText("To"), { target: { value: "" } });
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    expect(onChange).toHaveBeenCalledWith({ year_from: 2015, year_to: undefined });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(yearChip()).toHaveFocus();
  });

  it("rejects a year outside the range the API accepts", () => {
    const { onChange } = renderFilters({ q: "gnn" });
    fireEvent.click(yearChip());
    fireEvent.change(screen.getByLabelText("To"), { target: { value: "1700" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    expect(screen.getByRole("alert")).toHaveTextContent(`Enter a year between 1800 and ${maxSearchYear()}.`);
    expect(screen.getByLabelText("To")).toHaveAccessibleDescription(`Enter a year between 1800 and ${maxSearchYear()}.`);
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: "Publication year" })).toBeInTheDocument();
  });
});

describe("SearchFilters — year presets, reset and personal filters", () => {
  it("applies a year preset at once and marks the current one", () => {
    const { onChange } = renderFilters({ q: "gnn" });
    fireEvent.click(yearChip());
    const dialog = screen.getByRole("dialog", { name: "Publication year" });
    const anyTime = within(dialog).getByRole("button", { name: "Any time" });
    expect(anyTime).toHaveAttribute("aria-pressed", "true");
    expect(anyTime).toHaveFocus();
    fireEvent.click(within(dialog).getByRole("button", { name: `Since ${thisYear}` }));
    expect(onChange).toHaveBeenLastCalledWith({ year_from: thisYear, year_to: undefined });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(yearChip()).toHaveFocus();
  });

  it("knows the preset behind the applied years, and Clear removes them", () => {
    const { onChange } = renderFilters({ q: "gnn", year_from: thisYear - 4 });
    expect(yearChip()).toHaveAccessibleName(`Year: Since ${thisYear - 4}`);
    fireEvent.click(yearChip());
    expect(screen.getByRole("button", { name: "Last 5 years" })).toHaveAttribute("aria-pressed", "true");
    // Custom moves to the fields without applying anything.
    fireEvent.click(screen.getByRole("button", { name: "Custom range" }));
    expect(screen.getByLabelText("From")).toHaveFocus();
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    expect(onChange).toHaveBeenLastCalledWith({ year_from: undefined, year_to: undefined });
  });

  it("offers Reset only while filters are active", () => {
    const { onReset, rerender } = renderFilters({ q: "gnn", sort: "date" });
    expect(screen.queryByRole("button", { name: "Reset filters" })).toBeNull();
    rerender(
      <I18nextProvider i18n={i18n}>
        <SearchFilters params={{ q: "gnn", year_from: 2019, oa: true }} onChange={vi.fn()} onReset={onReset} />
      </I18nextProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Reset filters" }));
    expect(onReset).toHaveBeenCalledOnce();
  });

  it("shows the personal toggles as chips, and Reset when they differ", () => {
    const personal = {
      unsavedOnly: false,
      hideDismissed: false,
      onUnsavedOnlyChange: vi.fn(),
      onHideDismissedChange: vi.fn(),
    };
    renderFilters({ q: "gnn" }, vi.fn(), vi.fn(), { personal, personalActive: true });
    fireEvent.click(screen.getByRole("button", { name: "Not in a collection" }));
    expect(personal.onUnsavedOnlyChange).toHaveBeenCalledWith(true);
    const hide = screen.getByRole("button", { name: "Hide dismissed" });
    expect(hide).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(hide);
    expect(personal.onHideDismissedChange).toHaveBeenCalledWith(true);
    expect(screen.getByRole("button", { name: "Reset filters" })).toBeInTheDocument();
  });
});

describe("SearchFilters — phones", () => {
  it("shows a Filters button with the count and the active filters as removable chips", () => {
    mockMatchMedia((query) => query === COMPACT_QUERY);
    const { onChange } = renderFilters({ q: "gnn", year_from: 2019, year_to: 2023, sort: "citations" });
    const toggle = screen.getByRole("button", { name: /^Filters/ });
    expect(toggle).toHaveAttribute("aria-haspopup", "dialog");
    expect(toggle).toHaveTextContent("· 2");
    expect(toggle).toHaveAccessibleName("Filters 2 filters active");
    expect(screen.queryByRole("button", { name: /^Year/ })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Remove filter: 2019–2023" }));
    expect(onChange).toHaveBeenLastCalledWith({ year_from: undefined, year_to: undefined });
    expect(toggle).toHaveFocus();
    fireEvent.click(screen.getByRole("button", { name: "Remove filter: Most cited" }));
    expect(onChange).toHaveBeenLastCalledWith({ sort: undefined });
  });

  it("opens the Filters sheet: toggles and presets apply at once, Show results applies typed years", () => {
    mockMatchMedia((query) => query === COMPACT_QUERY);
    const { onChange } = renderFilters({ q: "gnn" }, vi.fn(), vi.fn(), { resultCount: 48210 });
    const toggle = screen.getByRole("button", { name: /^Filters/ });
    fireEvent.click(toggle);
    const sheet = screen.getByRole("dialog", { name: "Filters" });
    expect(toggle).toHaveAttribute("aria-expanded", "true");

    fireEvent.click(within(sheet).getByRole("checkbox", { name: "Open access only" }));
    expect(onChange).toHaveBeenLastCalledWith({ oa: true });
    fireEvent.click(within(sheet).getByRole("button", { name: "Last 5 years" }));
    expect(onChange).toHaveBeenLastCalledWith({ year_from: thisYear - 4, year_to: undefined });

    fireEvent.change(within(sheet).getByLabelText("To"), { target: { value: String(thisYear) } });
    fireEvent.click(within(sheet).getByRole("button", { name: "Show 48,210 results" }));
    expect(onChange).toHaveBeenLastCalledWith({ year_from: thisYear - 4, year_to: thisYear });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(toggle).toHaveFocus();
  });

  it("applies the sheet's sort once the choice settles, or when the sheet closes", () => {
    vi.useFakeTimers();
    mockMatchMedia((query) => query === COMPACT_QUERY);
    const { onChange } = renderFilters({ q: "gnn" });
    fireEvent.click(screen.getByRole("button", { name: /^Filters/ }));
    const group = screen.getByRole("radiogroup", { name: "Sort by" });
    fireEvent.keyDown(group, { key: "ArrowRight" });
    fireEvent.keyDown(group, { key: "ArrowRight" });
    expect(within(group).getByRole("radio", { name: "Most cited" })).toHaveAttribute("aria-checked", "true");
    expect(within(screen.getByRole("dialog")).getByText(/match all of your words/)).toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(399);
    });
    expect(onChange).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(onChange).toHaveBeenCalledOnce();
    expect(onChange).toHaveBeenLastCalledWith({ sort: "citations" });

    // The parent kept the relevance sort: one step right is Newest first.
    fireEvent.keyDown(group, { key: "ArrowRight" });
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onChange).toHaveBeenLastCalledWith({ sort: "date" });
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it("keeps the sheet open on invalid years and opens it for a search with them", () => {
    mockMatchMedia((query) => query === COMPACT_QUERY);
    const { ref, onChange } = renderFilters({ q: "gnn" });
    fireEvent.click(screen.getByRole("button", { name: /^Filters/ }));
    fireEvent.change(screen.getByLabelText("From"), { target: { value: "1700" } });
    fireEvent.click(screen.getByRole("button", { name: "Show results" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Enter a year between 1800");
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    act(() => {
      ref.current?.pendingYears();
    });
    expect(screen.getByRole("dialog", { name: "Filters" })).toBeInTheDocument();
  });

  it("names the personal filters in the row only when they differ from their defaults", () => {
    mockMatchMedia((query) => query === COMPACT_QUERY);
    const personal = {
      unsavedOnly: false,
      hideDismissed: true,
      onUnsavedOnlyChange: vi.fn(),
      onHideDismissedChange: vi.fn(),
    };
    const { rerender } = renderFilters({ q: "gnn" }, vi.fn(), vi.fn(), { personal });
    expect(screen.queryByRole("button", { name: /Not in a collection|Hide dismissed|Dismissed shown/ })).toBeNull();
    expect(screen.getByRole("button", { name: /^Filters/ })).toHaveAccessibleName("Filters");

    const changed = { ...personal, unsavedOnly: true, hideDismissed: false };
    rerender(
      <I18nextProvider i18n={i18n}>
        <SearchFilters params={{ q: "gnn" }} onChange={vi.fn()} onReset={vi.fn()} personal={changed} personalActive />
      </I18nextProvider>,
    );
    const toggle = screen.getByRole("button", { name: /^Filters/ });
    expect(toggle).toHaveAccessibleName("Filters 2 filters active");
    fireEvent.click(screen.getByRole("button", { name: "Remove filter: Not in a collection" }));
    expect(personal.onUnsavedOnlyChange).toHaveBeenCalledWith(false);
    expect(toggle).toHaveFocus();
    fireEvent.click(screen.getByRole("button", { name: "Remove filter: Dismissed shown" }));
    expect(personal.onHideDismissedChange).toHaveBeenCalledWith(true);
  });

  it("keeps focus in the sheet after Reset and describes the sort with its hint", () => {
    mockMatchMedia((query) => query === COMPACT_QUERY);
    const { onReset } = renderFilters({ q: "gnn", oa: true, sort: "citations" });
    fireEvent.click(screen.getByRole("button", { name: /^Filters/ }));
    const sheet = screen.getByRole("dialog", { name: "Filters" });
    const group = within(sheet).getByRole("radiogroup", { name: "Sort by" });
    expect(group).toHaveAccessibleDescription(/match all of your words/);

    fireEvent.click(within(sheet).getByRole("button", { name: "Reset filters" }));
    expect(onReset).toHaveBeenCalledOnce();
    expect(within(sheet).getByRole("heading", { name: "Filters" })).toHaveFocus();
  });
});
