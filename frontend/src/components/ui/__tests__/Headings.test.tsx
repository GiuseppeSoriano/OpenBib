import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import PageHeader from "@/components/ui/PageHeader";
import SectionHeading from "@/components/ui/SectionHeading";

describe("PageHeader", () => {
  it("renders the eyebrow, h1, description and actions", () => {
    render(
      <PageHeader
        eyebrow="Saturday, 4 October"
        title="Good morning"
        titleId="greeting"
        description="Your reading at a glance."
        actions={<button type="button">Find papers</button>}
        display
      />,
    );
    const heading = screen.getByRole("heading", { level: 1, name: "Good morning" });
    expect(heading).toHaveAttribute("id", "greeting");
    expect(heading.closest(".page-header")).toHaveClass("page-header--display");
    expect(screen.getByText("Saturday, 4 October")).toHaveClass("page-header-eyebrow");
    expect(screen.getByText("Your reading at a glance.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Find papers" })).toBeInTheDocument();
  });

  it("omits the optional parts", () => {
    const { container } = render(<PageHeader title="Settings" />);
    expect(container.querySelector(".page-header-eyebrow")).toBeNull();
    expect(container.querySelector(".page-header-description")).toBeNull();
    expect(container.querySelector(".page-header-actions")).toBeNull();
  });
});

describe("SectionHeading", () => {
  it("labels a section and carries an action", () => {
    render(
      <section aria-labelledby="cols">
        <SectionHeading id="cols" title="Collections" action={<a href="/collections">View all</a>} />
      </section>,
    );
    expect(screen.getByRole("region", { name: "Collections" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 2, name: "Collections" })).toHaveClass(
      "section-heading-title",
    );
    expect(screen.getByRole("link", { name: "View all" })).toBeInTheDocument();
  });

  it("can render a level-3 heading", () => {
    render(<SectionHeading title="Pinned" level={3} />);
    expect(screen.getByRole("heading", { level: 3, name: "Pinned" })).toBeInTheDocument();
  });
});
