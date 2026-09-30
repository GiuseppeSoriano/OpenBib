import { describe, expect, it } from "vitest";
import i18n from "@/i18n";
import { retryHelps, retryWaitUntil, searchErrorText } from "@/components/search/searchRetry";

function providerError(status: number, code: string, headers: Record<string, string> = {}) {
  return { isAxiosError: true, response: { status, data: { detail: { code, message: "raw" } }, headers } };
}

describe("searchRetry", () => {
  it("offers Retry only when trying again can help", () => {
    expect(retryHelps(providerError(503, "provider_unavailable"))).toBe(true);
    expect(retryHelps(providerError(503, "provider_rate_limited"))).toBe(true);
    expect(retryHelps(providerError(422, "invalid_cursor"))).toBe(true);
    expect(retryHelps(providerError(422, "invalid_query"))).toBe(false);
    expect(retryHelps(providerError(503, "provider_not_configured"))).toBe(false);
    expect(retryHelps(providerError(503, "provider_key_rejected"))).toBe(false);
  });

  it("waits for a Retry-After on a 429 or 503 only", () => {
    expect(retryWaitUntil(providerError(503, "provider_rate_limited", { "retry-after": "30" }), 1000)).toBe(31_000);
    expect(retryWaitUntil({ response: { status: 429, headers: { "retry-after": "5" } } }, 0)).toBe(5000);
    expect(retryWaitUntil(providerError(502, "provider_bad_response", { "retry-after": "30" }), 0)).toBeNull();
    expect(retryWaitUntil(providerError(503, "provider_unavailable"), 0)).toBeNull();
  });

  it("leaves the seconds out when Retry counts them down", () => {
    const error = providerError(503, "provider_rate_limited", { "retry-after": "30" });
    const t = i18n.getFixedT("en");
    expect(searchErrorText(error, t, false)).toBe(
      "Semantic Scholar is receiving too many requests. Try again in 30 s.",
    );
    expect(searchErrorText(error, t, true)).toBe(
      "Semantic Scholar is receiving too many requests. Please wait a moment and try again.",
    );
  });
});
