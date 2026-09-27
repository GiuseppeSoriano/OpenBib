import { describe, expect, it } from "vitest";
import { AxiosError, AxiosHeaders, type AxiosResponse } from "axios";
import {
  apiErrorCode,
  apiErrorDetail,
  apiErrorMessage,
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
});
