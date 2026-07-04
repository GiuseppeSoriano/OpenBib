import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { SearchX } from "lucide-react";
import EmptyState from "@/components/ui/EmptyState";
import Skeleton, { SkeletonCard } from "@/components/ui/Skeleton";

describe("EmptyState", () => {
  it("renders title, description, and action", () => {
    render(
      <EmptyState
        icon={SearchX}
        title="Nothing here"
        description="Try something else."
        action={<button>Do it</button>}
      />,
    );
    expect(screen.getByText("Nothing here")).toBeInTheDocument();
    expect(screen.getByText("Try something else.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Do it" })).toBeInTheDocument();
  });
});

describe("Skeleton", () => {
  it("renders the requested number of lines", () => {
    const { container } = render(<Skeleton lines={3} />);
    expect(container.querySelectorAll(".skeleton")).toHaveLength(3);
  });

  it("renders card placeholders", () => {
    render(<SkeletonCard count={2} />);
    expect(screen.getByTestId("skeleton").querySelectorAll(".skeleton-card")).toHaveLength(2);
  });
});
