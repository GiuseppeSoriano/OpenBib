import { afterEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import "@/i18n";
import { useApiErrorText } from "@/hooks/useApiErrorText";
import AnnouncedText from "@/components/ui/AnnouncedText";

function Probe({ error, fallback }: { error: unknown; fallback?: string }) {
  const { text, waiting } = useApiErrorText(error, fallback);
  return (
    <p data-testid="text" data-waiting={String(waiting)}>
      {text}
    </p>
  );
}

const rateLimited = {
  response: {
    status: 503,
    headers: { "retry-after": "3" },
    data: { detail: { code: "provider_rate_limited", message: "slow down" } },
  },
};

afterEach(() => {
  vi.useRealTimers();
});

describe("useApiErrorText", () => {
  it("is empty without an error", () => {
    render(<Probe error={null} />);
    expect(screen.getByTestId("text")).toBeEmptyDOMElement();
  });

  it("counts a Retry-After wait down and then offers generic advice", () => {
    vi.useFakeTimers();
    render(<Probe error={rateLimited} />);
    const text = screen.getByTestId("text");
    expect(text).toHaveTextContent("Semantic Scholar is receiving too many requests. Try again in 3 s.");
    expect(text).toHaveAttribute("data-waiting", "true");

    act(() => vi.advanceTimersByTime(1000));
    expect(text).toHaveTextContent("Try again in 2 s.");

    act(() => vi.advanceTimersByTime(2000));
    expect(text).toHaveTextContent("Semantic Scholar is receiving too many requests. Please wait a moment");
    expect(text).toHaveAttribute("data-waiting", "false");
  });

  it("uses the fallback for uncoded errors", () => {
    render(<Probe error={{ response: { status: 500 } }} fallback="Could not add." />);
    expect(screen.getByTestId("text")).toHaveTextContent("Could not add.");
  });

  it("counts from when the error arrives, however long the component was mounted", () => {
    vi.useFakeTimers();
    const seen: string[] = [];
    function Recorder({ error }: { error: unknown }) {
      seen.push(useApiErrorText(error).text);
      return null;
    }
    const { rerender } = render(<Recorder error={null} />);
    act(() => vi.advanceTimersByTime(60_000));
    rerender(<Recorder error={rateLimited} />);

    const shown = seen.filter(Boolean);
    expect(shown.length).toBeGreaterThan(0);
    for (const text of shown) expect(text).toMatch(/Try again in 3 s\.$/);
  });

  it("announces a countdown once while the visible text ticks", () => {
    vi.useFakeTimers();
    function Alert({ error }: { error: unknown }) {
      const { text, announcement } = useApiErrorText(error);
      return (
        <p role="alert">
          <AnnouncedText text={text} announcement={announcement} />
        </p>
      );
    }
    render(<Alert error={rateLimited} />);
    const alert = screen.getByRole("alert");
    const spoken = alert.querySelector(".sr-only")!;
    const shown = alert.querySelector("[aria-hidden='true']")!;
    expect(spoken).toHaveTextContent("Try again in 3 s.");
    expect(shown).toHaveTextContent("Try again in 3 s.");

    act(() => vi.advanceTimersByTime(1000));
    expect(shown).toHaveTextContent("Try again in 2 s.");
    expect(spoken).toHaveTextContent("Try again in 3 s.");
  });

  it("renders plain text when nothing counts down", () => {
    render(
      <p role="alert">
        <AnnouncedText text="Could not add." />
      </p>,
    );
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("Could not add.");
    expect(alert.querySelector(".sr-only, [aria-hidden]")).toBeNull();
  });
});
