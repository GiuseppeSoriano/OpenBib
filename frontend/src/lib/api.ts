import axios, { type InternalAxiosRequestConfig } from "axios";
import { assertSession, invalidateSession, sessionGeneration, SessionChangedError, withSessionLock } from "./session";
import type { GraphResponse,LibraryEntry, LibraryEntryListItem, LibraryFacets, LibraryListParams, LibraryVersionPin, Note, PaginatedResponse, PaperDetail, PaperState, ReadingState, RelatedRangeRequest, RelatedRangeResponse, SearchParams, SearchResult, TokenResponse, TopUpRequest, TopUpResponse, ZoteroStatus, ZoteroSyncReport } from "@/types";

let accessToken: string | null = null;
let refreshPromise: Promise<string> | null = null;
let authFailureHandler: (() => void) | null = null;

export function setAccessToken(token: string | null) {
  accessToken = token;
  invalidateSession();
}

export function setAuthFailureHandler(handler: (() => void) | null) {
  authFailureHandler = handler;
}

export async function refreshAccessToken(): Promise<string> {
  if (!refreshPromise) {
    const epoch = sessionGeneration();
    const request = async () => {
      assertSession(epoch);
      const { data } = await axios.post<TokenResponse>("/api/v1/auth/refresh", undefined, { withCredentials: true, headers: { "Content-Type": "application/json" } });
      assertSession(epoch);
      accessToken = data.access_token;
      return data.access_token;
    };
    refreshPromise = withSessionLock(request).finally(() => {
      refreshPromise = null;
    });
  }
  return refreshPromise;
}

const api = axios.create({ baseURL: "/api/v1", withCredentials: true, headers: { "Content-Type": "application/json" } });
type SessionRequest = InternalAxiosRequestConfig & { _retry?: boolean; _sessionGeneration?: number };

api.interceptors.request.use((config) => {
  const request = config as SessionRequest;
  if (request._sessionGeneration !== undefined) assertSession(request._sessionGeneration);
  request._sessionGeneration = sessionGeneration();
  if (accessToken) config.headers.Authorization = `Bearer ${accessToken}`;
  return config;
});

api.interceptors.response.use((response) => {
  const expected = (response.config as SessionRequest)._sessionGeneration;
  if (expected !== undefined) assertSession(expected);
  return response;
}, async (error) => {
  const original = error.config as SessionRequest | undefined;
  if (original?._sessionGeneration !== undefined) assertSession(original._sessionGeneration);
  const isAuthRoute = original?.url?.includes("/auth/");
  if (error.response?.status === 401 && original?.headers.Authorization && !original._retry && !isAuthRoute) {
    original._retry = true;
    try {
      const sentToken = original.headers.Authorization;
      const token = accessToken && sentToken !== `Bearer ${accessToken}` ? accessToken : await refreshAccessToken();
      original.headers.Authorization = `Bearer ${token}`;
      return api(original);
    } catch (refreshError) {
      if (refreshError instanceof SessionChangedError) return Promise.reject(refreshError);
      if (original._sessionGeneration !== undefined) assertSession(original._sessionGeneration);
      setAccessToken(null);
      authFailureHandler?.();
    }
  }
  return Promise.reject(error);
});

export const papers = {
  async search(params: SearchParams, options: { signal?: AbortSignal } = {}) { return (await api.get<SearchResult>("/papers/search", { params, signal: options.signal })).data; },
  async getDetail(canonicalKey: string) { return (await api.get<PaperDetail>(`/papers/${encodeURIComponent(canonicalKey)}`)).data; },
  async getStates(canonicalKey: string) { return (await api.get<PaperState[]>(`/papers/${encodeURIComponent(canonicalKey)}/states`)).data; },
  async setState(canonicalKey: string, state: ReadingState) { return (await api.put<PaperState>(`/papers/${encodeURIComponent(canonicalKey)}/state`, { state })).data; },
  async getTags(canonicalKey: string) { return (await api.get<{ tag: string }[]>(`/papers/${encodeURIComponent(canonicalKey)}/tags`)).data; },
  async addTag(canonicalKey: string, tag: string) { return (await api.post(`/papers/${encodeURIComponent(canonicalKey)}/tags`, { tag })).data; },
  async removeTag(canonicalKey: string, tag: string) { await api.delete(`/papers/${encodeURIComponent(canonicalKey)}/tags/${encodeURIComponent(tag)}`); },
};

export const notes = {
  async listForPaperGroup(paperGroupKey: string) { return (await api.get<Note[]>("/notes", { params: { paper_group_key: paperGroupKey } })).data; },
  async createForPaper(paperCanonicalKey: string, content: string) { return (await api.post<Note>("/notes", { target_type: "paper", target_key: paperCanonicalKey, content })).data; },
  async remove(noteId: string) { await api.delete(`/notes/${noteId}`); },
};

export const library = {
  async listEntries(params: LibraryListParams = {}) { return (await api.get<PaginatedResponse<LibraryEntryListItem>>("/library/entries", { params: { ...params, page: params.page ?? 1, size: params.size ?? 25 } })).data; },
  async getFacets() { return (await api.get<LibraryFacets>("/library/facets")).data; },
  async listKeys() { return (await api.get<string[]>("/library/keys")).data; },
  async getEntry(groupKey: string) { return (await api.get<LibraryEntry>(`/library/entries/${encodeURIComponent(groupKey)}`)).data; },
  async ensureEntry(body: { paper_group_key: string; paper_canonical_key: string; source_provider?: string | null }) { return (await api.post<LibraryEntry>("/library/entries", body)).data; },
  async repinPrimary(groupKey: string, primaryCanonicalKey: string) { return (await api.patch<LibraryEntry>(`/library/entries/${encodeURIComponent(groupKey)}`, { primary_canonical_key: primaryCanonicalKey })).data; },
  async deleteEntry(groupKey: string) { await api.delete(`/library/entries/${encodeURIComponent(groupKey)}`); },
  async addVersion(groupKey: string, body: { paper_canonical_key: string; source_provider?: string | null }) { return (await api.post<LibraryVersionPin>(`/library/entries/${encodeURIComponent(groupKey)}/versions`, body)).data; },
  async removeVersion(groupKey: string, canonicalKey: string) { await api.delete(`/library/entries/${encodeURIComponent(groupKey)}/versions/${encodeURIComponent(canonicalKey)}`); },
};

export const zotero = {
  async getStatus() { return (await api.get<ZoteroStatus>("/zotero/credentials")).data; },
  async setCredentials(apiKey: string) { return (await api.put<ZoteroStatus>("/zotero/credentials", { api_key: apiKey })).data; },
  async deleteCredentials() { await api.delete("/zotero/credentials"); },
  async syncCollection(collectionId: string, headers: Record<string, string> = {}) { return (await api.post<ZoteroSyncReport>(`/zotero/sync/collection/${collectionId}`, undefined, { headers })).data; },
  async syncLibrary() { return (await api.post<ZoteroSyncReport>("/zotero/sync/library")).data; },
};

export const graph = {
  async buildPaper(paperKey: string) { return (await api.get<GraphResponse>(`/graph/paper/${encodeURIComponent(paperKey)}`)).data; },
  async buildCollection(collectionId: string, headers: Record<string, string> = {}) { return (await api.get<GraphResponse>(`/graph/collection/${encodeURIComponent(collectionId)}`, { headers })).data; },
  async buildLibrary() { return (await api.get<GraphResponse>("/graph/library")).data; },
  async related(body: RelatedRangeRequest, options: { signal?: AbortSignal } = {}) { return (await api.post<RelatedRangeResponse>("/graph/related", body, { signal: options.signal })).data; },
  async topUp(body: TopUpRequest, options: { signal?: AbortSignal } = {}) { return (await api.post<TopUpResponse>("/graph/related/top-up", body, { signal: options.signal })).data; },
};

export default api;
