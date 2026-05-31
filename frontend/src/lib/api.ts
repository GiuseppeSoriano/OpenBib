import axios from "axios";
import type { LibraryEntry, LibraryEntryListItem, LibraryVersionPin } from "@/types";

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

export default api;
