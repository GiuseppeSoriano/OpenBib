import { useEffect, useState } from "react";
import type { TFunction } from "i18next";
import { apiErrorCode, apiErrorText, apiStatus, retryAfterSeconds } from "@/lib/apiError";

/** Codes that name a server misconfiguration: trying again cannot help. */
const CONFIG_ERRORS: ReadonlySet<string> = new Set(["provider_not_configured", "provider_key_rejected"]);

/**
 * Whether Retry can help: not for a misconfigured provider, nor for a 422
 * the API rejected (an expired cursor restarts instead).
 */
export function retryHelps(error: unknown): boolean {
  const code = apiErrorCode(error);
  if (code && CONFIG_ERRORS.has(code)) return false;
  return apiStatus(error) !== 422 || code === "invalid_cursor";
}

/** Epoch ms until which Retry waits: a 429/503 Retry-After counted from the failure. */
export function retryWaitUntil(error: unknown, failedAt: number): number | null {
  const status = apiStatus(error);
  const seconds = status === 429 || status === 503 ? retryAfterSeconds(error) : null;
  return seconds ? failedAt + seconds * 1000 : null;
}

/**
 * `apiErrorText` for a failed search. When Retry counts down a Retry-After
 * the seconds are left out of the text, so it never goes stale.
 */
export function searchErrorText(error: unknown, t: TFunction, countdown: boolean): string {
  const response = (error as { response?: unknown } | null)?.response;
  const shown =
    countdown && typeof response === "object" && response !== null
      ? { ...(error as object), response: { ...response, headers: {} } }
      : error;
  return apiErrorText(shown, t, t("search.errorFallback"));
}

/** Whole seconds left until `until` (epoch ms), ticking once a second. */
export function useSecondsUntil(until: number | null): number {
  const [, setTick] = useState(0);
  const remaining = until === null ? 0 : Math.max(0, Math.ceil((until - Date.now()) / 1000));
  useEffect(() => {
    if (until === null || Date.now() >= until) return;
    const timer = window.setInterval(() => {
      setTick((tick) => tick + 1);
      if (Date.now() >= until) window.clearInterval(timer);
    }, 1000);
    return () => window.clearInterval(timer);
  }, [until]);
  return remaining;
}
