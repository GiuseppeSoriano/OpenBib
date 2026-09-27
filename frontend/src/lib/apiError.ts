/*
 * Reading API errors safely. `detail` comes in three shapes: coded errors
 * (`{code, message, ...extra}`), legacy plain strings, and FastAPI
 * validation lists. Only strings may ever reach the UI as text.
 */

export type ApiErrorCode =
  | "invalid_identifier"
  | "doi_not_found"
  | "unknown_paper_key"
  | "already_in_collection"
  | "entry_in_collections"
  | "not_in_library"
  | "invalid_year_range"
  | "invalid_cursor"
  | "range_start_not_aligned"
  | "related_provider_unavailable";

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

/** Seconds from a 429's Retry-After header (delta-seconds or HTTP date). */
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
