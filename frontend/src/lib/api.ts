import axios from "axios";
import type {
  CitingOrder,
  ExpandRequest,
  ExpandResponse,
  GraphResponse,
  LibraryEntry,
  LibraryEntryListItem,
  LibraryVersionPin,
  Note,
  PaperDetail,
  PaperState,
  ReadingState,
  ZoteroStatus,
  ZoteroSyncReport,
} from "@/types";

const api = axios.create({
  baseURL: "/api/v1",
  headers: { "Content-Type": "application/json" },
});

// Attach JWT token to every request
api.interceptors.request.use((config) => {
  const token = localStorage.getItem("access_token");
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

// Handle 401 → attempt refresh
api.interceptors.response.use(
  (response) => response,
  async (error) => {
    const original = error.config;
    if (error.response?.status === 401 && !original._retry) {
      original._retry = true;
      const refresh = localStorage.getItem("refresh_token");
      if (refresh) {
        try {
          const res = await axios.post("/api/v1/auth/refresh", {
            refresh_token: refresh,
          });
          const { access_token, refresh_token } = res.data;
          localStorage.setItem("access_token", access_token);
          localStorage.setItem("refresh_token", refresh_token);
          original.headers.Authorization = `Bearer ${access_token}`;
          return api(original);
        } catch {
          localStorage.removeItem("access_token");
          localStorage.removeItem("refresh_token");
          window.location.href = "/login";
        }
      }
    }
    return Promise.reject(error);
  },
);

/* ── Papers namespace ──────────────────────────────────── */
export const papers = {
  async getDetail(canonicalKey: string) {
    const { data } = await api.get<PaperDetail>(
      `/papers/${encodeURIComponent(canonicalKey)}`,
    );
    return data;
  },
  async getStates(canonicalKey: string) {
    const { data } = await api.get<PaperState[]>(
      `/papers/${encodeURIComponent(canonicalKey)}/states`,
    );
    return data;
  },
  async setState(canonicalKey: string, state: ReadingState) {
    const { data } = await api.put<PaperState>(
      `/papers/${encodeURIComponent(canonicalKey)}/state`,
      { state },
    );
    return data;
  },
  async getTags(canonicalKey: string) {
    const { data } = await api.get<{ tag: string }[]>(
      `/papers/${encodeURIComponent(canonicalKey)}/tags`,
    );
    return data;
  },
  async addTag(canonicalKey: string, tag: string) {
    const { data } = await api.post(
      `/papers/${encodeURIComponent(canonicalKey)}/tags`,
      { tag },
    );
    return data;
  },
  async removeTag(canonicalKey: string, tag: string) {
    await api.delete(
      `/papers/${encodeURIComponent(canonicalKey)}/tags/${encodeURIComponent(tag)}`,
    );
  },
};

/* ── Notes namespace ───────────────────────────────────── */
export const notes = {
  async listForPaperGroup(paperGroupKey: string) {
    const { data } = await api.get<Note[]>("/notes", {
      params: { paper_group_key: paperGroupKey },
    });
    return data;
  },
  async createForPaper(paperCanonicalKey: string, content: string) {
    const { data } = await api.post<Note>("/notes", {
      target_type: "paper",
      target_key: paperCanonicalKey,
      content,
    });
    return data;
  },
  async remove(noteId: string) {
    await api.delete(`/notes/${noteId}`);
  },
};

/* ── Library namespace ─────────────────────────────────── */
export const library = {
  async listEntries(params: { page?: number; size?: number } = {}) {
    const { data } = await api.get<LibraryEntryListItem[]>("/library/entries", {
      params: { page: params.page ?? 1, size: params.size ?? 25 },
    });
    return data;
  },
  async listKeys() {
    const { data } = await api.get<string[]>("/library/keys");
    return data;
  },
  async getEntry(groupKey: string) {
    const { data } = await api.get<LibraryEntry>(
      `/library/entries/${encodeURIComponent(groupKey)}`,
    );
    return data;
  },
  async ensureEntry(body: {
    paper_group_key: string;
    paper_canonical_key: string;
    source_provider?: string | null;
  }) {
    const { data } = await api.post<LibraryEntry>("/library/entries", body);
    return data;
  },
  async repinPrimary(groupKey: string, primaryCanonicalKey: string) {
    const { data } = await api.patch<LibraryEntry>(
      `/library/entries/${encodeURIComponent(groupKey)}`,
      { primary_canonical_key: primaryCanonicalKey },
    );
    return data;
  },
  async deleteEntry(groupKey: string) {
    await api.delete(`/library/entries/${encodeURIComponent(groupKey)}`);
  },
  async addVersion(
    groupKey: string,
    body: { paper_canonical_key: string; source_provider?: string | null },
  ) {
    const { data } = await api.post<LibraryVersionPin>(
      `/library/entries/${encodeURIComponent(groupKey)}/versions`,
      body,
    );
    return data;
  },
  async removeVersion(groupKey: string, canonicalKey: string) {
    await api.delete(
      `/library/entries/${encodeURIComponent(groupKey)}/versions/${encodeURIComponent(canonicalKey)}`,
    );
  },
};

/* ── Zotero namespace ──────────────────────────────────── */
export const zotero = {
  async getStatus() {
    const { data } = await api.get<ZoteroStatus>("/zotero/credentials");
    return data;
  },
  async setCredentials(apiKey: string) {
    const { data } = await api.put<ZoteroStatus>("/zotero/credentials", {
      api_key: apiKey,
    });
    return data;
  },
  async deleteCredentials() {
    await api.delete("/zotero/credentials");
  },
  async syncCollection(collectionId: string) {
    const { data } = await api.post<ZoteroSyncReport>(
      `/zotero/sync/collection/${collectionId}`,
    );
    return data;
  },
  async syncLibrary() {
    const { data } = await api.post<ZoteroSyncReport>("/zotero/sync/library");
    return data;
  },
};

/* ── Graph namespace ───────────────────────────────────── */
export const graph = {
  async buildPaper(paperKey: string, order: CitingOrder = "cited_by_count") {
    const { data } = await api.get<GraphResponse>(
      `/graph/paper/${encodeURIComponent(paperKey)}`,
      { params: { order } },
    );
    return data;
  },
  async buildCollection(collectionId: string, order: CitingOrder = "cited_by_count") {
    const { data } = await api.get<GraphResponse>(
      `/graph/collection/${encodeURIComponent(collectionId)}`,
      { params: { order } },
    );
    return data;
  },
  async buildLibrary(order: CitingOrder = "cited_by_count") {
    const { data } = await api.get<GraphResponse>("/graph/library", {
      params: { order },
    });
    return data;
  },
  async expand(body: ExpandRequest) {
    const { data } = await api.post<ExpandResponse>("/graph/expand", body);
    return data;
  },
};

export default api;
