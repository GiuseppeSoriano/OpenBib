import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import SegmentedControl, { type SegmentOption } from "@/components/ui/SegmentedControl";

type Sort = "relevance" | "newest" | "cited";

const OPTIONS: SegmentOption<Sort>[] = [
  { value: "relevance", label: "Relevance" },
  { value: "newest", label: "Newest", title: "Newest first" },
  { value: "cited", label: "Most cited" },
];

function Harness({
  initial = "relevance",
  options = OPTIONS,
  onChange = () => {},
}: {
  initial?: Sort;
  options?: SegmentOption<Sort>[];
  onChange?: (value: Sort) => void;
}) {
  const [value, setValue] = useState<Sort>(initial);
  return (
    <>
      <button type="button">Before</button>
      <SegmentedControl
        label="Sort by"
        value={value}
        options={options}
        onChange={(next) => {
          onChange(next);
          setValue(next);
        }}
      />
    </>
  );
}

describe("SegmentedControl", () => {
  it("is a radio group with the checked segment as the only tab stop", async () => {
    const user = userEvent.setup();
    render(<Harness initial="newest" />);
    const group = screen.getByRole("radiogroup", { name: "Sort by" });
    expect(group).toHaveClass("segmented");
    expect(screen.getByRole("radio", { name: "Newest" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("radio", { name: "Relevance" })).toHaveAttribute("aria-checked", "false");
    expect(screen.getByRole("radio", { name: "Newest" })).toHaveAttribute("title", "Newest first");

    await user.click(screen.getByRole("button", { name: "Before" }));
    await user.tab();
    expect(screen.getByRole("radio", { name: "Newest" })).toHaveFocus();
    await user.tab();
    expect(document.body).toHaveFocus();
  });

  it("selects on click and with arrow keys, wrapping around and honouring Home/End", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);

    await user.click(screen.getByRole("radio", { name: "Most cited" }));
    expect(onChange).toHaveBeenLastCalledWith("cited");

    await user.keyboard("{ArrowRight}");
    expect(screen.getByRole("radio", { name: "Relevance" })).toHaveFocus();
    expect(screen.getByRole("radio", { name: "Relevance" })).toHaveAttribute("aria-checked", "true");

    await user.keyboard("{ArrowLeft}");
    expect(screen.getByRole("radio", { name: "Most cited" })).toHaveAttribute("aria-checked", "true");

    await user.keyboard("{Home}");
    expect(screen.getByRole("radio", { name: "Relevance" })).toHaveFocus();
    await user.keyboard("{End}");
    expect(screen.getByRole("radio", { name: "Most cited" })).toHaveFocus();
    expect(onChange).toHaveBeenLastCalledWith("cited");
  });

  it("skips disabled segments", async () => {
    const user = userEvent.setup();
    const options = OPTIONS.map((option) =>
      option.value === "newest" ? { ...option, disabled: true } : option,
    );
    render(<Harness options={options} />);
    await user.click(screen.getByRole("radio", { name: "Relevance" }));
    await user.keyboard("{ArrowRight}");
    expect(screen.getByRole("radio", { name: "Most cited" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("radio", { name: "Newest" })).toBeDisabled();
  });
});
