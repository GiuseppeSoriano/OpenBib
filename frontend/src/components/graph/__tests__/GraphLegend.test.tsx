import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import GraphLegend from "@/components/graph/GraphLegend";
import i18n from "@/i18n";

/**
 * What the edge entry shows, in order: its text pieces and "[link]" for the
 * drawn link, leaving out what only screen readers get.
 */
function shownParts(entry: Element): string[] {
  return Array.from(entry.childNodes)
    .filter((node) => !(node instanceof Element && node.classList.contains("sr-only")))
    .map((node) => (node instanceof SVGElement ? "[link]" : node.textContent!.trim()))
    .filter(Boolean);
}

describe("GraphLegend", () => {
  // The overlay's open state lives in module memory for the session: each
  // test leaves it open again, as a first visit finds it.
  afterEach(() => {
    cleanup();
    render(<GraphLegend />);
    const toggle = screen.getByRole("button", { name: "Legend" });
    if (toggle.getAttribute("aria-expanded") === "false") fireEvent.click(toggle);
  });

  it("opens the overlay by default as a labelled list behind a Legend disclosure", () => {
    render(<GraphLegend />);

    const toggle = screen.getByRole("button", { name: "Legend" });
    const list = screen.getByRole("list", { name: "Legend" });
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(toggle).toHaveAttribute("aria-controls", list.id);
    expect(toggle).toHaveAttribute("title", "Hide the legend");
    expect(within(list).getAllByRole("listitem").map((item) => item.textContent?.trim())).toEqual([
      "Pinned",
      "Paper (size = citations)",
      "In Library",
      "Selected",
      "A → B: A cites B",
    ]);
  });

  it("collapses to a Legend chip and opens again", () => {
    render(<GraphLegend />);
    const toggle = screen.getByRole("button", { name: "Legend" });

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(toggle).not.toHaveAttribute("title");
    expect(screen.queryByRole("list", { name: "Legend" })).toBeNull();
    // The entries stay in the DOM (aria-controls points at them), hidden.
    expect(document.getElementById(toggle.getAttribute("aria-controls")!)).not.toBeVisible();
    expect(screen.getByText("Legend")).not.toHaveClass("sr-only");

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("list", { name: "Legend" })).toBeVisible();
  });

  it("remembers a collapsed legend for the session, across graphs", () => {
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    const first = render(<GraphLegend />);
    fireEvent.click(screen.getByRole("button", { name: "Legend" }));
    first.unmount();

    render(<GraphLegend />);
    expect(screen.getByRole("button", { name: "Legend" })).toHaveAttribute("aria-expanded", "false");
    // Memory only: the privacy notice allows Web Storage for theme and language.
    expect(setItem).not.toHaveBeenCalled();
    setItem.mockRestore();
  });

  it("draws the direction swatch as the canvas draws a link, in the pill and the sheet alike", () => {
    for (const variant of ["overlay", "inline"] as const) {
      const { container, unmount } = render(<GraphLegend variant={variant} />);
      const glyph = container.querySelector("svg.legend-arrow")!;
      expect(glyph).toHaveAttribute("aria-hidden", "true");
      const line = glyph.querySelector("line")!;
      const [x1, x2] = [Number(line.getAttribute("x1")), Number(line.getAttribute("x2"))];
      // M tip, then the two base corners.
      const [tipX, tipY, baseX, y1, , y2] = glyph.querySelector("path")!.getAttribute("d")!.match(/[\d.]+/g)!.map(Number) as [
        number,
        number,
        number,
        number,
        number,
        number,
      ];
      // One arrowhead halfway along the line, pointing at its cited end,
      // as large as the canvas's (7 long, 6 wide).
      expect((tipX + baseX) / 2).toBeCloseTo((x1 + x2) / 2);
      expect(tipX - baseX).toBe(7);
      expect(y2 - y1).toBe(6);
      expect(tipY).toBe(Number(line.getAttribute("y1")));
      expect(glyph.querySelectorAll("path")).toHaveLength(1);
      // Colours come from the tokens in graph.css, never inline.
      expect(glyph.querySelector("[style], [fill], [stroke]")).toBeNull();
      unmount();
    }
  });

  it("reads A, the drawn link, then B: the arrow it replaces is left to screen readers", async () => {
    for (const variant of ["overlay", "inline"] as const) {
      const { container, unmount } = render(<GraphLegend variant={variant} />);
      const entry = container.querySelector("svg.legend-arrow")!.closest("li")!;
      expect(shownParts(entry)).toEqual(["A", "[link]", "B: A cites B"]);
      // One arrow on screen, the drawn one; its text stand-in is visually
      // hidden, so the entry still reads "A → B: A cites B".
      expect(within(entry).getByText("→")).toHaveClass("sr-only");
      expect(entry.textContent).toBe("A → B: A cites B");
      unmount();
    }

    await act(() => i18n.changeLanguage("it"));
    try {
      const { container } = render(<GraphLegend variant="inline" />);
      const entry = container.querySelector("svg.legend-arrow")!.closest("li")!;
      expect(shownParts(entry)).toEqual(["A", "[link]", "B: A cita B"]);
      expect(entry.textContent).toBe("A → B: A cita B");
    } finally {
      await act(() => i18n.changeLanguage("en"));
    }
  });

  it("keeps the sheet's inline legend as a plain list with the pinning hint", () => {
    render(<GraphLegend variant="inline" />);

    expect(screen.queryByRole("button")).toBeNull();
    const items = screen.getAllByRole("listitem").map((item) => item.textContent?.trim());
    expect(items).toContain("In Library");
    expect(items[items.length - 1]).toBe("Drag a node or use Pin to fix it in place");
  });
});
