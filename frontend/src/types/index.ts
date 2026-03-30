/* Shared TypeScript types matching backend schemas. */

/* ── Auth ───────────────────────────────────────────────── */
export interface TokenResponse {
  access_token: string;
  refresh_token: string;
  token_type: string;
}

/* ── User ───────────────────────────────────────────────── */
export interface User {
  id: string;
  email: string;
  display_name: string | null;
  created_at: string;
}

/* ── Paper ──────────────────────────────────────────────── */
export interface PaperMetadata {
  canonical_key: string;
  title: string;
  authors: Author[];
  abstract: string | null;
  publication_date: string | null;
  doi: string | null;
  arxiv_id: string | null;
  venue: string | null;
  paper_type: string | null;
  topics: string[];
  keywords: string[];
  open_access: boolean | null;
  pdf_url: string | null;
  cited_by_count: number | null;
  reference_count: number | null;
  provider_source: string;
}

export interface Author {
  name: string;
  openalex_id: string | null;
  orcid: string | null;
  affiliations: string[];
}

export type ReadingState =
  | "unseen"
  | "seen"
  | "saved"
  | "to_read"
  | "reading"
  | "read"
  | "important"
  | "ignored"
  | "excluded";

export interface PaperState {
  paper_canonical_key: string;
  collection_id: string;
  state: ReadingState;
}

/* ── Collection ─────────────────────────────────────────── */
export type Visibility = "private" | "shared" | "public";
export type MemberRole = "owner" | "editor" | "viewer";

export interface Collection {
  id: string;
  name: string;
  description: string | null;
  visibility: Visibility;
  owner_id: string;
  paper_count: number;
  created_at: string;
  updated_at: string;
}

/* ── Note ───────────────────────────────────────────────── */
export type NoteTargetType = "paper" | "collection" | "author";

export interface Note {
  id: string;
  target_type: NoteTargetType;
  target_key: string;
  content: string;
  created_at: string;
  updated_at: string;
}

/* ── Graph ──────────────────────────────────────────────── */
export interface GraphNode {
  key: string;
  label: string;
}

export interface GraphEdge {
  source: string;
  target: string;
  relation: string;
}

export interface GraphResponse {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

/* ── Search ─────────────────────────────────────────────── */
export interface SearchResult {
  papers: PaperMetadata[];
  total_count: number;
  page: number;
  page_size: number;
  provider: string;
}

/* ── Pagination ─────────────────────────────────────────── */
export interface PaginatedResponse<T> {
  items: T[];
  total: number;
  page: number;
  size: number;
  pages: number;
}
