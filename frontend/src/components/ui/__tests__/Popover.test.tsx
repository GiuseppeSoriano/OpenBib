import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import Popover, { PopoverListbox } from "@/components/ui/Popover";
import { MenuChip } from "@/components/ui/Chip";
import Modal from "@/components/ui/Modal";

function YearPopover({ onApply = () => {} }: { onApply?: () => void }) {
  return (
    <>
      <Popover
        label="Publication year"
        trigger={(props) => <MenuChip {...props}>Year</MenuChip>}
      >
        {(close) => (
          <>
            <label>
              From
              <input />
            </label>
            <button
              type="button"
              onClick={() => {
                onApply();
                close();
              }}
            >
              Apply
            </button>
          </>
        )}
      </Popover>
      <button type="button">Elsewhere</button>
    </>
  );
}

describe("Popover", () => {
  it("wires the trigger to a non-modal dialog and moves focus in", async () => {
    const user = userEvent.setup();
    render(<YearPopover />);
    const trigger = screen.getByRole("button", { name: "Year" });
    expect(trigger).toHaveAttribute("aria-haspopup", "dialog");
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(trigger).not.toHaveAttribute("aria-controls");

    await user.click(trigger);
    const dialog = screen.getByRole("dialog", { name: "Publication year" });
    expect(dialog).not.toHaveAttribute("aria-modal");
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(trigger).toHaveAttribute("aria-controls", dialog.id);
    expect(screen.getByLabelText("From")).toHaveFocus();
  });

  it("closes on Escape and returns focus to the trigger", async () => {
    const user = userEvent.setup();
    render(<YearPopover />);
    await user.click(screen.getByRole("button", { name: "Year" }));
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Year" })).toHaveFocus();
  });

  it("closes in place on an outside click or when focus leaves", async () => {
    const user = userEvent.setup();
    render(<YearPopover />);
    await user.click(screen.getByRole("button", { name: "Year" }));
    await user.click(screen.getByRole("button", { name: "Elsewhere" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Elsewhere" })).toHaveFocus();

    await user.click(screen.getByRole("button", { name: "Year" }));
    await user.tab();
    await user.tab();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Elsewhere" })).toHaveFocus();
  });

  it("close() from the content returns focus to the trigger", async () => {
    const user = userEvent.setup();
    const onApply = vi.fn();
    render(<YearPopover onApply={onApply} />);
    await user.click(screen.getByRole("button", { name: "Year" }));
    await user.click(screen.getByRole("button", { name: "Apply" }));
    expect(onApply).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Year" })).toHaveFocus();
  });

  it("supports a controlled open state", async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    render(
      <Popover
        label="Controlled"
        open
        onOpenChange={onOpenChange}
        trigger={(props) => <button {...props}>Toggle</button>}
      >
        <button type="button">Inside</button>
      </Popover>,
    );
    expect(screen.getByRole("dialog", { name: "Controlled" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Toggle" }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("closes only itself on Escape inside a modal dialog", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(
      <Modal open title="Filters" onClose={onClose}>
        <YearPopover />
      </Modal>,
    );
    await user.click(screen.getByRole("button", { name: "Year" }));
    fireEvent.keyDown(screen.getByLabelText("From"), { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Publication year" })).not.toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: "Filters" })).toBeInTheDocument();
  });
});

function SortPopover() {
  const [sort, setSort] = useState<"relevance" | "newest" | "cited">("relevance");
  const labels = { relevance: "Relevance", newest: "Newest", cited: "Most cited" };
  return (
    <Popover
      haspopup="listbox"
      align="end"
      trigger={(props) => (
        <MenuChip {...props} prefix="Sort">
          {labels[sort]}
        </MenuChip>
      )}
    >
      {(close) => (
        <PopoverListbox
          label="Sort by"
          value={sort}
          options={(Object.keys(labels) as (keyof typeof labels)[]).map((value) => ({
            value,
            label: labels[value],
          }))}
          onSelect={(value) => {
            setSort(value);
            close();
          }}
        />
      )}
    </Popover>
  );
}

describe("PopoverListbox", () => {
  it("focuses the selected option and selects with the keyboard", async () => {
    const user = userEvent.setup();
    render(<SortPopover />);
    const trigger = screen.getByRole("button", { name: /Sort/ });
    expect(trigger).toHaveAttribute("aria-haspopup", "listbox");
    await user.click(trigger);

    const listbox = screen.getByRole("listbox", { name: "Sort by" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(listbox.parentElement).toHaveAttribute("id", trigger.getAttribute("aria-controls"));
    expect(screen.getByRole("option", { name: "Relevance" })).toHaveFocus();
    expect(screen.getByRole("option", { name: "Relevance" })).toHaveAttribute("aria-selected", "true");

    await user.keyboard("{ArrowDown}{ArrowDown}");
    expect(screen.getByRole("option", { name: "Most cited" })).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Sort.*Most cited/ })).toHaveFocus();
  });

  it("selects an option on click", async () => {
    const user = userEvent.setup();
    render(<SortPopover />);
    await user.click(screen.getByRole("button", { name: /Sort/ }));
    await user.click(screen.getByRole("option", { name: "Newest" }));
    expect(screen.getByRole("button", { name: /Sort.*Newest/ })).toBeInTheDocument();
  });
});
