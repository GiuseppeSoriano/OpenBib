import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import GraphPaperList from "@/components/graph/GraphPaperList";
import type { GraphNode, PaperMetadata } from "@/types";

function graphNode(id: string, title: string, year: string | null, cited: number | null): GraphNode {
  const version = {
    canonical_key: `hash:${id}`,
    paper_group_key: id,
    title,
    authors: [],
    publication_date: year ? `${year}-01-01` : null,
    cited_by_count: cited,
    provider_source: "semantic_scholar",
  } as unknown as PaperMetadata;
  return {
    id,
    label: title,
    type: "paper",
    paper_group_key: id,
    version_count: 1,
    selected_version: version,
    versions: [version],
    is_seed: false,
  };
}

const NODES = [
  graphNode("a", "Attention Is All You Need", "2017", 120000),
  graphNode("b", "Graph Neural Networks", "2009", 5400),
  graphNode("c", "Réseaux de neurones", null, null),
  graphNode("d", "Deep Residual Learning", "2016", 0),
];

function setup(props: Partial<Parameters<typeof GraphPaperList>[0]> = {}) {
  const onSelect = vi.fn();
  const onTogglePin = vi.fn();
  const onClose = vi.fn();
  const view = render(
    <GraphPaperList
      variant="drawer"
      nodes={NODES}
      pinOrder={["a"]}
      pinned={new Set(["a"])}
      currentRangeIds={["b", "c"]}
      currentRange={{ start: 31, end: 60 }}
      selectedId={null}
      onSelect={onSelect}
      onTogglePin={onTogglePin}
      onClose={onClose}
      {...props}
    />,
  );
  const list = screen.getByRole("complementary", { name: "Papers on the graph" });
  return { view, list, onSelect, onTogglePin, onClose };
}

function rows(list: HTMLElement) {
  return Array.from(list.querySelectorAll<HTMLElement>(".graph-list-select"));
}

describe("GraphPaperList", () => {
  it("groups papers under caps labels with counts and shows each row's title and meta", () => {
    const { list } = setup();

    const headings = within(list).getAllByRole("heading", { level: 3 }).map((heading) => heading.textContent);
    expect(headings).toEqual(["Pinned (1)", "Current range · 31–60", "Other papers (1)"]);
    const first = within(list).getByRole("button", { name: /^Attention Is All You Need/ });
    // The full title is a tooltip on the clamped text only, so it is not
    // read twice (as the button's name and again as its description).
    expect(first).not.toHaveAttribute("title");
    expect(first).not.toHaveAccessibleDescription();
    expect(first.querySelector(".graph-list-name")).toHaveTextContent("Attention Is All You Need");
    expect(first.querySelector(".graph-list-name")).toHaveAttribute("title", "Attention Is All You Need");
    expect(first.querySelector(".graph-list-meta")).toHaveTextContent("2017 · Cited by 120,000");
    // No year and no count: no meta line at all.
    expect(within(list).getByRole("button", { name: "Réseaux de neurones" }).querySelector(".graph-list-meta")).toBeNull();
    expect(within(list).getByRole("button", { name: "Pin “Attention Is All You Need”" })).toHaveAttribute("aria-pressed", "true");
    expect(within(list).getByRole("button", { name: "Pin “Graph Neural Networks”" })).toHaveAttribute("aria-pressed", "false");
  });

  it("counts the current range when its bounds are unknown", () => {
    const { list } = setup({ currentRange: null });
    expect(within(list).getByRole("heading", { level: 3, name: "Current range (2)" })).toBeInTheDocument();
  });

  it("filters the rows by title, ignoring case and accents, and says when nothing matches", () => {
    const { list, onClose } = setup();
    const filter = within(list).getByRole("searchbox", { name: "Filter papers by title" });

    fireEvent.change(filter, { target: { value: "RESEAUX" } });
    expect(rows(list).map((row) => row.querySelector(".graph-list-name")?.textContent)).toEqual(["Réseaux de neurones"]);
    expect(within(list).getAllByRole("heading", { level: 3 }).map((heading) => heading.textContent)).toEqual([
      "Current range · 31–60",
    ]);
    expect(within(list).getByRole("status")).toHaveTextContent("1 paper matches");

    fireEvent.change(filter, { target: { value: "quantum" } });
    expect(rows(list)).toHaveLength(0);
    expect(within(list).getByRole("status")).toHaveTextContent("No papers match “quantum”.");

    // Escape clears the filter first, and only then closes the drawer.
    fireEvent.keyDown(filter, { key: "Escape" });
    expect(filter).toHaveValue("");
    expect(rows(list)).toHaveLength(4);
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.keyDown(filter, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("moves between rows with the arrow keys, Home and End, keeping the column", () => {
    const { list } = setup();
    const [a, b, c, d] = rows(list) as [HTMLElement, HTMLElement, HTMLElement, HTMLElement];

    fireEvent.keyDown(within(list).getByRole("searchbox"), { key: "ArrowDown" });
    expect(a).toHaveFocus();
    fireEvent.keyDown(a, { key: "ArrowDown" });
    expect(b).toHaveFocus();
    fireEvent.keyDown(b, { key: "ArrowDown" });
    expect(c).toHaveFocus();
    fireEvent.keyDown(c, { key: "ArrowUp" });
    expect(b).toHaveFocus();
    fireEvent.keyDown(b, { key: "End" });
    expect(d).toHaveFocus();
    fireEvent.keyDown(d, { key: "ArrowDown" });
    expect(d).toHaveFocus();
    fireEvent.keyDown(d, { key: "Home" });
    expect(a).toHaveFocus();

    const pin = within(list).getByRole("button", { name: "Pin “Attention Is All You Need”" });
    pin.focus();
    fireEvent.keyDown(pin, { key: "ArrowDown" });
    expect(within(list).getByRole("button", { name: "Pin “Graph Neural Networks”" })).toHaveFocus();
  });

  it("selects and pins from a row, and closes from Close and Escape", () => {
    const { list, onSelect, onTogglePin, onClose } = setup();
    fireEvent.click(within(list).getByRole("button", { name: /^Graph Neural Networks/ }));
    expect(onSelect).toHaveBeenCalledWith("b");
    fireEvent.click(within(list).getByRole("button", { name: "Pin “Graph Neural Networks”" }));
    expect(onTogglePin).toHaveBeenCalledWith("b");

    fireEvent.click(within(list).getByRole("button", { name: "Close the papers list" }));
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(rows(list)[0]!, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("scrolls the paper selected on the canvas into view and highlights it", () => {
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
    try {
      const { view, list } = setup();
      expect(scrollIntoView).not.toHaveBeenCalled();
      view.rerender(
        <GraphPaperList
          variant="drawer"
          nodes={NODES}
          pinOrder={["a"]}
          pinned={new Set(["a"])}
          currentRangeIds={["b", "c"]}
          selectedId="d"
          onSelect={vi.fn()}
          onTogglePin={vi.fn()}
        />,
      );
      const selected = within(list).getByRole("button", { name: /^Deep Residual Learning/ });
      expect(selected).toHaveAttribute("aria-current", "true");
      expect(selected.querySelector(".graph-dot")).toHaveClass("graph-dot--selected");
      expect(scrollIntoView).toHaveBeenCalledTimes(1);
      expect(scrollIntoView.mock.contexts[0]).toBe(selected);
    } finally {
      delete (Element.prototype as Partial<Element>).scrollIntoView;
    }
  });

  it("keeps the sheet variant's heading for assistive tech only, without Close", () => {
    setup({ variant: "sheet", onClose: undefined });
    const list = screen.getByRole("complementary", { name: "Papers on the graph" });
    expect(within(list).queryByRole("button", { name: "Close the papers list" })).toBeNull();
    expect(within(list).getByRole("heading", { level: 2 }).parentElement).toHaveClass("sr-only");
  });

  it("shows an empty state when the graph has no papers", () => {
    setup({ nodes: [], pinOrder: [], pinned: new Set(), currentRangeIds: [] });
    const list = screen.getByRole("complementary", { name: "Papers on the graph" });
    expect(within(list).getByRole("status")).toHaveTextContent("No papers on the graph yet.");
    expect(within(list).queryByRole("searchbox")).toBeNull();
  });
});
