import { useMemo } from "react";
import { useLocation } from "react-router-dom";
import { useAuth } from "@/contexts/AuthContext";

/** The capability stays in the URL fragment/in memory, never in Web Storage.
 * Callers attach its header only to the matching collection's read operations.
 */
export function useCollectionAccess(collectionId?: string) {
  const location = useLocation();
  const { user } = useAuth();
  const token = new URLSearchParams(location.hash.slice(1)).get("share") ?? "";
  const validToken = /^[A-Za-z0-9_-]{43}$/.test(token) ? token : "";
  const scope = useMemo(() => ({ collectionId, validToken, userId: user?.id, nonce: crypto.randomUUID() }), [collectionId, validToken, user?.id]).nonce;
  const headers: Record<string, string> = validToken ? { "X-Collection-Share-Token": validToken } : {};
  return {
    scope,
    headers,
    fragment: validToken ? `#share=${validToken}` : "",
    returnTo: location.pathname + location.hash,
  };
}

/** Return null on lost access so React Query replaces previously cached content. */
export async function collectionRead<T>(request: () => Promise<T>): Promise<T | null> {
  try { return await request(); }
  catch (error) {
    const status = (error as { response?: { status: number } }).response?.status;
    if (status === 403 || status === 404) return null;
    throw error;
  }
}

export function safeReturnTo(value: unknown): string {
  if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//") || (value.includes("\\") || Array.from(value).some((char) => char.charCodeAt(0) <= 32))) return "/";
  const url = new URL(value, window.location.origin);
  return url.origin === window.location.origin ? url.pathname + url.search + url.hash : "/";
}
