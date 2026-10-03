import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import Menu, { menuShift } from "@/components/ui/Menu";

function rect(x: number, width: number): DOMRect {
  return { x, y: 0, left: x, right: x + width, top: 0, bottom: 40, width, height: 40, toJSON: () => ({}) };
}

describe("menuShift", () => {
  it("leaves a popover that fits where it is", () => {
    expect(menuShift(41, 241, 390)).toBe(0);
  });

  it("pulls a popover past the right edge back inside the gutter", () => {
    expect(menuShift(41, 399, 390)).toBe(-25);
  });

  it("pushes a popover past the left edge back inside the gutter", () => {
    expect(menuShift(-120, 180, 390)).toBe(136);
  });

  it("prefers the left edge when the popover is as wide as the viewport", () => {
    expect(menuShift(81, 471, 390)).toBe(-81);
  });
});

describe("Menu", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("moves an open popover back on screen through --menu-shift", () => {
    vi.spyOn(document.documentElement, "clientWidth", "get").mockReturnValue(390);
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
      this: HTMLElement,
    ) {
      return this.getAttribute("role") === "menu"
        ? rect(41, 358)
        : rect(41, 40);
    });

    render(
      <Menu button="Open" align="left">
        <button type="button" role="menuitem">
          A collection with a very long name
        </button>
      </Menu>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Open" }));

    const popover = screen.getByRole("menu");
    expect(popover.style.getPropertyValue("--menu-shift")).toBe("-25px");
  });

  it("sets no offset when the popover fits", () => {
    vi.spyOn(document.documentElement, "clientWidth", "get").mockReturnValue(1440);
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(rect(219, 352));

    render(
      <Menu button="Open" align="left">
        <button type="button" role="menuitem">
          Short
        </button>
      </Menu>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Open" }));

    expect(screen.getByRole("menu").style.getPropertyValue("--menu-shift")).toBe("");
  });
});
