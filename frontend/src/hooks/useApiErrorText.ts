import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { apiErrorText, apiStatus, retryAfterSeconds } from "@/lib/apiError";
import { useSecondsUntil } from "@/components/search/searchRetry";

/** The error with its Retry-After header replaced by `seconds` (dropped at 0). */
function withRetryAfter(error: unknown, seconds: number): unknown {
  const response = (error as { response?: object }).response ?? {};
  const headers = seconds > 0 ? { "retry-after": String(seconds) } : {};
  return { ...(error as object), response: { ...response, headers } };
}

/**
 * `apiErrorText` for a failed request, with a 429/503 Retry-After wait
 * counting down once a second. `waiting` stays true until the wait is over.
 * While a wait applies, `announcement` is the message as first shown: a live
 * region reads that once (see `AnnouncedText`) instead of every tick.
 */
export function useApiErrorText(
  error: unknown,
  fallback?: string,
): { text: string; announcement: string | null; waiting: boolean } {
  const { t } = useTranslation();
  const wait = useMemo(() => {
    const status = apiStatus(error);
    const seconds = status === 429 || status === 503 ? retryAfterSeconds(error) : null;
    return seconds ? { seconds, deadline: Date.now() + seconds * 1000 } : null;
  }, [error]);
  // Read from the clock on every render, so the first render is never stale.
  const remaining = useSecondsUntil(wait?.deadline ?? null);

  if (!error) return { text: "", announcement: null, waiting: false };
  if (wait === null) return { text: apiErrorText(error, t, fallback), announcement: null, waiting: false };
  return {
    text: apiErrorText(withRetryAfter(error, remaining), t, fallback),
    announcement: apiErrorText(withRetryAfter(error, wait.seconds), t, fallback),
    waiting: remaining > 0,
  };
}
