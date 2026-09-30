import { createRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import i18n from "@/i18n";
import SearchFilters, { type SearchFiltersHandle } from "@/components/search/SearchFilters";
import { COMPACT_QUERY } from "@/lib/breakpoints";
import { maxSearchYear, type SearchParamsState } from "@/lib/searchParams";
import { mockMatchMedia, restoreMatchMedia } from "@/test/utils";

function renderFilters(params: SearchParamsState, onChange = vi.fn(), onReset = vi.fn()) {
  const view = render(
    <I18nextProvider i18n={i18n}>
      <SearchFilters params={params} onChange={onChange} onReset={onReset} />
    </I18nextProvider>,
  );
  return { ...view, onChange, onReset };
}

afterEach(() => {
  restoreMatchMedia();
  vi.useRealTimers();
});

describe("SearchFilters", () => {
  it("applies open access at once", () => {
    const { onChange } = renderFilters({ q: "gnn" });
    fireEvent.click(screen.getByRole("button", { name: "Open access only" }));
    expect(onChange).toHaveBeenLastCalledWith({ oa: true });
    expect(screen.queryByText(/match all of your words/)).toBeNull();
  });

  it("applies the sort once the choice settles, or when focus leaves", () => {
    vi.useFakeTimers();
    const { onChange } = renderFilters({ q: "gnn" });
    const select = screen.getByLabelText("Sort by");
    fireEvent.change(select, { target: { value: "date" } });
    fireEvent.change(select, { target: { value: "citations" } });
    expect(select).toHaveValue("citations");
    expect(screen.getByText(/match all of your words/)).toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(399);
    });
    expect(onChange).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(onChange).toHaveBeenCalledOnce();
    expect(onChange).toHaveBeenLastCalledWith({ sort: "citations" });

    fireEvent.change(select, { target: { value: "date" } });
    fireEvent.blur(select);
    expect(onChange).toHaveBeenLastCalledWith({ sort: "date" });
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it("sends typed years with a toggle and hands them to a search", () => {
    const ref = createRef<SearchFiltersHandle>();
    const onChange = vi.fn();
    render(
      <I18nextProvider i18n={i18n}>
        <SearchFilters ref={ref} params={{ q: "gnn", year_to: 2020 }} onChange={onChange} onReset={vi.fn()} />
      </I18nextProvider>,
    );
    const pending = () => {
      let value: unknown;
      act(() => {
        value = ref.current?.pendingYears();
      });
      return value;
    };
    expect(pending()).toEqual({});
    fireEvent.change(screen.getByLabelText("From"), { target: { value: "2015" } });
    expect(pending()).toEqual({ year_from: 2015, year_to: 2020 });
    fireEvent.click(screen.getByRole("button", { name: "Open access only" }));
    expect(onChange).toHaveBeenLastCalledWith({ year_from: 2015, year_to: 2020, oa: true });

    fireEvent.change(screen.getByLabelText("From"), { target: { value: "15" } });
    expect(pending()).toBeNull();
    expect(screen.getByRole("alert")).toHaveTextContent("Enter a year between 1800");
  });

  it("explains the matching of the date and citation sorts", () => {
    renderFilters({ q: "gnn", sort: "citations" });
    const hint = screen.getByText(/lists only papers that match all of your words/);
    expect(screen.getByLabelText("Sort by")).toHaveAccessibleDescription(hint.textContent ?? "");
    expect(screen.getByLabelText("Sort by")).toHaveValue("citations");
  });

  it("applies the years together and clears one left empty", () => {
    const { onChange } = renderFilters({ q: "gnn", year_from: 2010, year_to: 2012 });
    fireEvent.change(screen.getByLabelText("From"), { target: { value: "2015" } });
    fireEvent.change(screen.getByLabelText("To"), { target: { value: "" } });
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    expect(onChange).toHaveBeenCalledWith({ year_from: 2015, year_to: undefined });
  });

  it("rejects a year outside the range the API accepts", () => {
    const { onChange } = renderFilters({ q: "gnn" });
    fireEvent.change(screen.getByLabelText("To"), { target: { value: "1700" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    expect(screen.getByRole("alert")).toHaveTextContent(`Enter a year between 1800 and ${maxSearchYear()}.`);
    expect(screen.getByLabelText("To")).toHaveAccessibleDescription(`Enter a year between 1800 and ${maxSearchYear()}.`);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("counts active filters and resets them", () => {
    const { onReset } = renderFilters({ q: "gnn", year_from: 2019, oa: true, sort: "date" });
    expect(screen.getByText("2 filters active")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Reset filters" }));
    expect(onReset).toHaveBeenCalledOnce();
  });

  it("folds behind a Filters toggle on compact screens", () => {
    mockMatchMedia((query) => query === COMPACT_QUERY);
    renderFilters({ q: "gnn", oa: true });
    const toggle = screen.getByRole("button", { name: /Filters/ });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(toggle).toHaveTextContent("1");
    expect(screen.queryByRole("combobox", { name: "Sort by" })).toBeNull();
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("combobox", { name: "Sort by" })).toBeVisible();
    // The count and reset stay reachable while folded.
    expect(screen.getByText("1 filter active")).toBeInTheDocument();
  });
});
