import { createRef } from "react";
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Chip, FilterChip, MenuChip } from "@/components/ui/Chip";

describe("FilterChip", () => {
  it("is a toggle button whose state is aria-pressed", async () => {
    const user = userEvent.setup();
    const onPressedChange = vi.fn();
    const { rerender } = render(
      <FilterChip pressed={false} onPressedChange={onPressedChange}>
        Open access
      </FilterChip>,
    );
    const chip = screen.getByRole("button", { name: "Open access" });
    expect(chip).toHaveAttribute("aria-pressed", "false");
    expect(chip).toHaveClass("chip");

    await user.click(chip);
    expect(onPressedChange).toHaveBeenCalledWith(true);

    rerender(
      <FilterChip pressed onPressedChange={onPressedChange} count={3}>
        Filters
      </FilterChip>,
    );
    const pressed = screen.getByRole("button", { name: "Filters 3" });
    expect(pressed).toHaveAttribute("aria-pressed", "true");
    await user.click(pressed);
    expect(onPressedChange).toHaveBeenLastCalledWith(false);
  });
});

describe("MenuChip", () => {
  it("forwards its ref and popup attributes, with a muted prefix and an active state", () => {
    const ref = createRef<HTMLButtonElement>();
    render(
      <MenuChip ref={ref} prefix="Sort" active aria-haspopup="listbox" aria-expanded={false}>
        Most cited
      </MenuChip>,
    );
    const chip = screen.getByRole("button", { name: "Sort Most cited" });
    expect(ref.current).toBe(chip);
    expect(chip).toHaveClass("chip", "chip--active");
    expect(chip).toHaveAttribute("aria-haspopup", "listbox");
    expect(chip).toHaveAttribute("aria-expanded", "false");
    expect(chip.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
  });
});

describe("Chip", () => {
  it("renders a static tag without a button", () => {
    render(<Chip>2019–2023</Chip>);
    expect(screen.getByText("2019–2023")).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("offers a labelled remove button", async () => {
    const user = userEvent.setup();
    const onRemove = vi.fn();
    render(
      <Chip removeLabel="Remove filter: 2019–2023" onRemove={onRemove}>
        2019–2023
      </Chip>,
    );
    await user.click(screen.getByRole("button", { name: "Remove filter: 2019–2023" }));
    expect(onRemove).toHaveBeenCalledTimes(1);
  });
});
