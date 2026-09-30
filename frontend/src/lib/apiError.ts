/*
 * Reading API errors safely. `detail` comes in three shapes: coded errors
 * (`{code, message, ...extra}`), legacy plain strings, and FastAPI
 * validation lists. Only strings may ever reach the UI as text.
 */
import type { TFunction } from "i18next";

export const API_ERROR_CODES = [
  "invalid_identifier",
  "doi_not_found",
  "identifier_not_found",
  "unknown_paper_key",
  "already_in_collection",
  "entry_in_collections",
  "not_in_library",
  "invalid_year_range",
  "invalid_cursor",
  "invalid_query",
  "search_window_exceeded",
  "range_start_not_aligned",
  "related_provider_unavailable",
  "provider_not_configured",
  "provider_key_rejected",
  "provider_rate_limited",
  "provider_unavailable",
  "provider_bad_response",
] as const;

export type ApiErrorCode = (typeof API_ERROR_CODES)[number];

const KNOWN_CODES: ReadonlySet<string> = new Set(API_ERROR_CODES);

export interface ApiErrorDetail {
  code: ApiErrorCode;
  message: string;
  [key: string]: unknown;
}

interface ErrorResponse {
  status?: unknown;
  data?: unknown;
  headers?: unknown;
}

function responseOf(err: unknown): ErrorResponse | null {
  if (typeof err !== "object" || err === null) return null;
  const response = (err as { response?: unknown }).response;
  return typeof response === "object" && response !== null ? (response as ErrorResponse) : null;
}

function rawDetail(err: unknown): unknown {
  const data = responseOf(err)?.data;
  return typeof data === "object" && data !== null ? (data as { detail?: unknown }).detail : undefined;
}

/** HTTP status of a failed request; null for network errors and non-HTTP failures. */
export function apiStatus(err: unknown): number | null {
  const status = responseOf(err)?.status;
  return typeof status === "number" ? status : null;
}

/** The coded `detail` object, or null for string, list or missing details. */
export function apiErrorDetail(err: unknown): ApiErrorDetail | null {
  const detail = rawDetail(err);
  if (typeof detail !== "object" || detail === null || Array.isArray(detail)) return null;
  const { code, message } = detail as { code?: unknown; message?: unknown };
  if (typeof code !== "string" || !code) return null;
  return {
    ...(detail as Record<string, unknown>),
    code: code as ApiErrorCode,
    message: typeof message === "string" ? message : "",
  };
}

export function apiErrorCode(err: unknown): ApiErrorCode | null {
  return apiErrorDetail(err)?.code ?? null;
}

/**
 * Seconds from a Retry-After header (delta-seconds or HTTP date): sent with a
 * 429 and with a 503 from a rate-limited or unavailable provider.
 */
export function retryAfterSeconds(err: unknown): number | null {
  const headers = responseOf(err)?.headers;
  if (typeof headers !== "object" || headers === null) return null;
  let value: unknown;
  const getter = (headers as { get?: unknown }).get;
  if (typeof getter === "function") value = getter.call(headers, "retry-after");
  if (value == null) {
    const name = Object.keys(headers).find((key) => key.toLowerCase() === "retry-after");
    value = name ? (headers as Record<string, unknown>)[name] : undefined;
  }
  if (typeof value === "number") return Number.isFinite(value) && value >= 0 ? Math.ceil(value) : null;
  if (typeof value !== "string" || !value.trim()) return null;
  const text = value.trim();
  if (/^\d+$/.test(text)) return Number(text);
  const at = Date.parse(text);
  return Number.isNaN(at) ? null : Math.max(0, Math.ceil((at - Date.now()) / 1000));
}

/**
 * A display-safe message for a failed request: a legacy plain-string
 * `detail`, otherwise `fallback`. Coded errors and validation lists never
 * leak through; map codes to localized copy with `apiErrorCode` instead.
 */
export function apiErrorMessage(err: unknown, fallback: string): string {
  const detail = rawDetail(err);
  return typeof detail === "string" && detail.trim() ? detail : fallback;
}

/** A request that never got a response (offline, DNS, CORS); not a cancellation. */
function isNetworkError(err: unknown): boolean {
  if (typeof err !== "object" || err === null || responseOf(err)) return false;
  const { isAxiosError, code } = err as { isAxiosError?: unknown; code?: unknown };
  return isAxiosError === true && code !== "ERR_CANCELED";
}

/**
 * `errors.*` keys whose copy states the problem without retry advice; the
 * advice is added by `apiErrorText`, either a Retry-After wait or this key.
 */
const RETRY_ADVICE: Readonly<Record<string, string>> = {
  rateLimited: "errors.retrySoon",
  provider_rate_limited: "errors.retrySoon",
  provider_unavailable: "errors.retryLater",
  related_provider_unavailable: "errors.retryLater",
};

/**
 * Localized copy for a failed request: `errors.<code>` for a known coded
 * error, otherwise a rate-limit or connection message by status, otherwise
 * `fallback` (default `errors.generic`). Rate-limit and outage messages end
 * with one retry sentence: "Try again in N s" when a 429 or 503 carries
 * Retry-After, generic advice otherwise. The server's own `message` never
 * reaches the UI.
 */
export function apiErrorText(err: unknown, t: TFunction, fallback?: string): string {
  const code = apiErrorCode(err);
  const status = apiStatus(err);
  let key: string;
  if (code && KNOWN_CODES.has(code)) key = code;
  else if (status === 429) key = "rateLimited";
  else if (isNetworkError(err)) return t("errors.network");
  else return fallback ?? t("errors.generic");
  const text = t(`errors.${key}`);
  const advice = RETRY_ADVICE[key];
  if (!advice) return text;
  const seconds = status === 429 || status === 503 ? retryAfterSeconds(err) : null;
  return `${text} ${seconds ? t("errors.retryIn", { seconds }) : t(advice)}`;
}
