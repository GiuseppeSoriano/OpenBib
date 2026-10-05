import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import i18n from "@/i18n";
import SearchStatus from "@/components/search/SearchStatus";

type Props = Parameters<typeof SearchStatus>[0];

function renderStatus(props: Partial<Props> = {}) {
  return render(
    <I18nextProvider i18n={i18n}>
      <SearchStatus kind="results" provider="Semantic Scholar" {...props} />
    </I18nextProvider>,
  );
}

function providerError(status: number, code: string, headers: Record<string, string> = {}) {
  return { isAxiosError: true, response: { status, data: { detail: { code, message: "raw server text" } }, headers } };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("SearchStatus", () => {
  it("names the provider and how much of its result set is shown", () => {
    renderStatus({ shown: 20, total: 3768 });
    expect(screen.getByRole("status")).toHaveTextContent("Semantic Scholar · 20 of about 3,768 results");
  });

  it("names the active filters after the counts", () => {
    renderStatus({ shown: 20, total: 48210, filters: "2019–2023 · most cited first" });
    expect(screen.getByRole("status")).toHaveTextContent(
      "Semantic Scholar · 20 of about 48,210 results · 2019–2023 · most cited first",
    );
  });

  it("drops the estimate when there is none", () => {
    renderStatus({ shown: 3, total: null });
    expect(screen.getByRole("status")).toHaveTextContent("Semantic Scholar · 3 results");
    expect(screen.getByRole("status")).not.toHaveTextContent("about");
  });

  it("reports no matches and loading", () => {
    const { rerender } = renderStatus({ kind: "empty" });
    expect(screen.getByRole("status")).toHaveTextContent("No matches in Semantic Scholar");
    rerender(
      <I18nextProvider i18n={i18n}>
        <SearchStatus kind="loading" provider="Semantic Scholar" />
      </I18nextProvider>,
    );
    expect(screen.getByRole("status")).toHaveTextContent("Searching Semantic Scholar…");
  });

  it("adds the partial notice when paging hit the result window", () => {
    renderStatus({ shown: 1000, total: 25000, windowCapped: true });
    expect(screen.getByRole("status")).toHaveTextContent(
      "Only the first 1,000 results are available — refine your search to see others.",
    );
  });

  it("gives the operator message when the provider is not configured", () => {
    const onRetry = vi.fn();
    renderStatus({ kind: "error", error: providerError(503, "provider_not_configured"), onRetry });
    expect(screen.getByRole("status")).toHaveTextContent("set SEMANTIC_SCHOLAR_API_KEY");
    expect(screen.getByRole("status")).not.toHaveTextContent("raw server text");
  });

  it("explains an unavailable provider and retries", () => {
    const onRetry = vi.fn();
    renderStatus({ kind: "error", error: providerError(503, "provider_unavailable"), onRetry });
    expect(screen.getByRole("status")).toHaveTextContent(
      "Semantic Scholar is unavailable right now. Please try again later.",
    );
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it("counts down a rate limit before Retry, outside the live region", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-30T10:00:00Z"));
    const onRetry = vi.fn();
    const error = providerError(503, "provider_rate_limited", { "retry-after": "3" });
    renderStatus({ kind: "error", error, retryAt: Date.now() + 3000, onRetry });

    const status = screen.getByRole("status");
    expect(status).toHaveTextContent(
      "Semantic Scholar is receiving too many requests. Please wait a moment and try again.",
    );
    const button = screen.getByRole("button", { name: "Try again in 3 s" });
    expect(button).toBeDisabled();
    expect(status).not.toContainElement(button);

    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(screen.getByRole("button", { name: "Try again in 2 s" })).toBeDisabled();
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    const ready = screen.getByRole("button", { name: "Try again" });
    expect(ready).toBeEnabled();
    // The announced text neither ticked nor went stale: only Retry counts down.
    expect(status).toHaveTextContent("Please wait a moment and try again.");
    expect(status).not.toHaveTextContent(/\d s/);
    fireEvent.click(ready);
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it("offers no Retry when trying again cannot help", () => {
    renderStatus({ kind: "error", error: providerError(422, "invalid_query") });
    expect(screen.getByRole("status")).toHaveTextContent("couldn’t process this search");
    expect(screen.queryByRole("button")).toBeNull();
  });
});
