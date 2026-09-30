import { describe, expect, it } from "vitest";
import { AxiosError, AxiosHeaders, type AxiosResponse } from "axios";
import i18n from "@/i18n";
import {
  API_ERROR_CODES,
  apiErrorCode,
  apiErrorDetail,
  apiErrorMessage,
  apiErrorText,
  apiStatus,
  retryAfterSeconds,
} from "@/lib/apiError";

function httpError(status: number, data: unknown, headers: Record<string, string> = {}) {
  const response = {
    status,
    statusText: "",
    data,
    headers: new AxiosHeaders(headers),
    config: { headers: new AxiosHeaders() },
  } as AxiosResponse;
  return new AxiosError("Request failed", "ERR_BAD_RESPONSE", undefined, undefined, response);
}

const coded = httpError(409, {
  detail: {
    code: "entry_in_collections",
    message: "This entry is still in collections.",
    collections: [{ id: "c1", name: "Reading list" }],
  },
});
const legacy = httpError(409, { detail: "Cannot delete this entry" });
const validation = httpError(422, {
  detail: [{ loc: ["query", "q"], msg: "field required", type: "missing" }],
});

describe("apiError helpers", () => {
  it("reads the HTTP status, or null without a response", () => {
    expect(apiStatus(coded)).toBe(409);
    expect(apiStatus(new AxiosError("Network Error", "ERR_NETWORK"))).toBeNull();
    expect(apiStatus(new Error("boom"))).toBeNull();
    expect(apiStatus(null)).toBeNull();
  });

  it("returns coded details with their extra fields", () => {
    expect(apiErrorCode(coded)).toBe("entry_in_collections");
    expect(apiErrorDetail(coded)).toMatchObject({
      code: "entry_in_collections",
      message: "This entry is still in collections.",
      collections: [{ id: "c1", name: "Reading list" }],
    });
  });

  it("treats string and validation-list details as uncoded", () => {
    for (const err of [legacy, validation, httpError(500, "Internal Server Error")]) {
      expect(apiErrorDetail(err)).toBeNull();
      expect(apiErrorCode(err)).toBeNull();
    }
  });

  it("only ever produces a string for display", () => {
    expect(apiErrorMessage(legacy, "fallback")).toBe("Cannot delete this entry");
    expect(apiErrorMessage(coded, "fallback")).toBe("fallback");
    expect(apiErrorMessage(validation, "fallback")).toBe("fallback");
    expect(apiErrorMessage(httpError(400, { detail: "  " }), "fallback")).toBe("fallback");
    expect(apiErrorMessage(new Error("boom"), "fallback")).toBe("fallback");
  });

  it("parses Retry-After as seconds or an HTTP date", () => {
    expect(retryAfterSeconds(httpError(429, {}, { "Retry-After": "12" }))).toBe(12);
    const inTenSeconds = new Date(Date.now() + 10_000).toUTCString();
    const fromDate = retryAfterSeconds(httpError(429, {}, { "retry-after": inTenSeconds }));
    expect(fromDate).toBeGreaterThanOrEqual(8);
    expect(fromDate).toBeLessThanOrEqual(10);
    expect(retryAfterSeconds({ response: { headers: { "retry-after": "3" } } })).toBe(3);
    expect(retryAfterSeconds(httpError(429, {}))).toBeNull();
    expect(retryAfterSeconds(httpError(429, {}, { "Retry-After": "soon" }))).toBeNull();
  });

  it("reads Retry-After from a 503 sent by a rate-limited provider", () => {
    const busy = httpError(
      503,
      { detail: { code: "provider_rate_limited", message: "Semantic Scholar is busy" } },
      { "Retry-After": "30" },
    );
    expect(apiErrorCode(busy)).toBe("provider_rate_limited");
    expect(retryAfterSeconds(busy)).toBe(30);
    expect(retryAfterSeconds(httpError(503, {}))).toBeNull();
  });
});

function codedError(status: number, code: string, headers: Record<string, string> = {}) {
  return httpError(status, { detail: { code, message: `server text for ${code}` } }, headers);
}

describe("apiErrorText", () => {
  const en = i18n.getFixedT("en");
  const it_ = i18n.getFixedT("it");

  it("has English and Italian copy for every coded error", () => {
    for (const code of API_ERROR_CODES) {
      for (const lng of ["en", "it"]) {
        expect(i18n.getResource(lng, "translation", `errors.${code}`), `${lng}: ${code}`).toEqual(expect.any(String));
      }
      expect(apiErrorText(codedError(422, code), en)).not.toContain("server text");
    }
  });

  it("localizes provider errors instead of showing the server message", () => {
    expect(apiErrorText(codedError(503, "provider_unavailable"), en)).toBe(
      "Semantic Scholar is unavailable right now. Please try again later.",
    );
    expect(apiErrorText(codedError(503, "provider_unavailable"), it_)).toBe(
      "Semantic Scholar non è al momento disponibile. Riprova più tardi.",
    );
    expect(apiErrorText(codedError(503, "provider_not_configured"), en)).toMatch(/SEMANTIC_SCHOLAR_API_KEY/);
    expect(apiErrorText(codedError(422, "search_window_exceeded"), en)).toMatch(/first 1,000 results/);
    expect(apiErrorText(codedError(422, "identifier_not_found"), en)).toMatch(/no paper with this identifier/);
  });

  it("ends with a single retry sentence, the Retry-After wait when known", () => {
    const busy = codedError(503, "provider_rate_limited", { "Retry-After": "12" });
    expect(apiErrorText(busy, en)).toBe("Semantic Scholar is receiving too many requests. Try again in 12 s.");
    expect(apiErrorText(busy, it_)).toBe("Semantic Scholar sta ricevendo troppe richieste. Riprova tra 12 s.");
    expect(apiErrorText(codedError(503, "provider_rate_limited"), en)).toBe(
      "Semantic Scholar is receiving too many requests. Please wait a moment and try again.",
    );
    const outage = codedError(503, "provider_unavailable", { "Retry-After": "5" });
    expect(apiErrorText(outage, en)).toBe("Semantic Scholar is unavailable right now. Try again in 5 s.");
    expect(apiErrorText(outage, it_)).toBe("Semantic Scholar non è al momento disponibile. Riprova tra 5 s.");
    expect(apiErrorText(codedError(503, "related_provider_unavailable", { "Retry-After": "5" }), en)).toBe(
      "Citation data from Semantic Scholar is unavailable right now. Try again in 5 s.",
    );
    const limited = httpError(429, { detail: "Rate limit exceeded" }, { "Retry-After": "7" });
    expect(apiErrorText(limited, en)).toBe("Too many requests. Try again in 7 s.");
    expect(apiErrorText(httpError(429, {}), en)).toBe("Too many requests. Please wait a moment and try again.");
    expect(apiErrorText(httpError(429, {}, { "Retry-After": "0" }), it_)).toBe(
      "Troppe richieste. Attendi un momento e riprova.",
    );
  });

  it("never pairs a wait with copy that has its own retry advice", () => {
    const guarded = httpError(503, { detail: "Protection service temporarily unavailable" }, { "Retry-After": "30" });
    expect(apiErrorText(guarded, en)).toBe("Something went wrong. Please try again.");
    expect(apiErrorText(guarded, en, "Couldn’t load the graph. Try again.")).toBe(
      "Couldn’t load the graph. Try again.",
    );
    const badBody = codedError(503, "provider_bad_response", { "Retry-After": "9" });
    expect(apiErrorText(badBody, en)).toBe(
      "Semantic Scholar sent a response OpenBib couldn’t read. Please try again later.",
    );
  });

  it("falls back for network, legacy, unknown and validation errors", () => {
    expect(apiErrorText(new AxiosError("Network Error", "ERR_NETWORK"), en)).toMatch(/Couldn’t reach OpenBib/);
    expect(apiErrorText(new AxiosError("canceled", "ERR_CANCELED"), en, "fallback")).toBe("fallback");
    expect(apiErrorText(legacy, en, "fallback")).toBe("fallback");
    expect(apiErrorText(validation, en, "fallback")).toBe("fallback");
    expect(apiErrorText(codedError(400, "some_future_code"), en, "fallback")).toBe("fallback");
    expect(apiErrorText(new Error("boom"), en)).toBe("Something went wrong. Please try again.");
  });
});
