/* Shared TypeScript types matching backend schemas. */

/* ── Auth ───────────────────────────────────────────────── */
export interface TokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  legal_acceptance_required: boolean;
}

/* ── User ───────────────────────────────────────────────── */
export interface User {
  id: string;
  email: string;
  display_name: string | null;
  created_at: string;
  email_verified: boolean;
  legal_acceptance_required: boolean;
}

/* ── Paper ──────────────────────────────────────────────── */
export interface PaperMetadata {
  canonical_key: string;
  paper_group_key: string;
  title: string;
  authors: Author[];
  abstract: string | null;
  publication_date: string | null;
  doi: string | null;
  arxiv_id: string | null;
  pmid?: string | null;
  pmcid?: string | null;
  semantic_scholar_id?: string | null;
  openalex_id?: string | null;
  venue: string | null;
  volume?: string | null;
  issue?: string | null;
  pages?: string | null;
  paper_type: string | null;
  topics: string[];
  keywords: string[];
  open_access: boolean | null;
  pdf_url: string | null;
  abstract_url?: string | null;
  cited_by_count: number | null;
  reference_count: number | null;
  version?: string | null;
  provider_source: string;
  provider_sources: string[];
}

export interface Author {
  name: string;
  family_name?: string | null;
  given_name?: string | null;
  semantic_scholar_id?: string | null;
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
  state: ReadingState;
}

export const READING_STATES: ReadingState[] = [
  "unseen",
  "seen",
  "saved",
  "to_read",
  "reading",
  "read",
  "important",
  "ignored",
  "excluded",
];

export interface PaperDetail extends PaperMetadata {
  versions: PaperMetadata[];
}

/* ── Zotero ─────────────────────────────────────────────── */
export interface ZoteroStatus {
  connected: boolean;
  zotero_user_id: string | null;
  api_key_masked: string | null;
}

export interface ZoteroSyncFailure {
  paper_canonical_key: string;
  message: string;
}

export interface ZoteroSyncReport {
  zotero_collection_key: string;
  items_created: number;
  items_updated: number;
  items_skipped: number;
  failures: ZoteroSyncFailure[];
}

/* ── Collection ─────────────────────────────────────────── */
export type MemberRole = "owner" | "editor" | "viewer";

export interface Collection {
  id: string;
  name: string;
  description: string | null;
  revision: number;
  can_manage_access: boolean;
  is_owner: boolean;
  can_edit: boolean;
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
  id: string;
  label: string | null;
  type: "paper" | "paper_group";
  paper_group_key: string;
  version_count: number;
  selected_version: PaperMetadata;
  versions: PaperMetadata[];
  is_seed: boolean;
}

export interface GraphEdge {
  source: string;
  target: string;
  relation_type: string;
}

/* ── Recommendations ────────────────────────────────────── */
export interface RecommendationItem {
  canonical_key: string;
  title: string;
  score: number;
  reason: string;
}

export interface RecommendationResponse {
  paper_key: string;
  recommendations: RecommendationItem[];
}

/* ── Collection Paper (from backend) ────────────────────── */
export interface CollectionPaper {
  paper_canonical_key: string;
  paper_group_key: string | null;
  position: number;
  added_at: string;
  paper?: PaperMetadata | null;
}

export interface SearchPaperItem {
  kind: "paper";
  paper: PaperMetadata;
}

export interface SearchPaperGroupItem {
  kind: "paper_group";
  paper_group_key: string;
  title: string;
  authors: Author[];
  version_count: number;
  selected_version: PaperMetadata;
  versions: PaperMetadata[];
  provider_sources: string[];
}

export type SearchResultItem = SearchPaperItem | SearchPaperGroupItem;

export interface SearchResult {
  items: SearchResultItem[];
  total_count: number;
  raw_total_count: number;
  has_more: boolean;
  page: number;
  page_size: number;
  providers: string[];
}

/* ── Paper memberships (search page enrichment) ─────────── */
export type PaperMemberships = Record<string, string[]>;

/* ── User stats ─────────────────────────────────────────── */
export interface UserStats {
  total_collections: number;
  total_papers: number;
  distinct_papers: number;
  library_total: number;
}

/* ── Library ────────────────────────────────────────────── */
export interface LibraryVersionPin {
  paper_canonical_key: string;
  paper_group_key: string;
  source_provider: string | null;
  added_at: string;
}

export interface LibraryEntryListItem {
  paper_group_key: string;
  primary_canonical_key: string;
  created_at: string;
  primary_version: PaperMetadata | null;
  version_count: number;
  tags: string[];
}

export interface LibraryEntry {
  paper_group_key: string;
  primary_canonical_key: string;
  created_at: string;
  primary_version: PaperMetadata | null;
  pinned_versions: LibraryVersionPin[];
  notes_count: number;
  tags: string[];
  states: PaperState[];
}

export interface PaginatedResponse<T> {
  items: T[];
  total: number;
  page: number;
  size: number;
}

export interface GraphResponse {
  active_paper_key: string;
  active_paper_group_key: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export type CitingOrder = "cited_by_count" | "recent";

// "cited_by" → add papers that cite the node; "cites" → add its references.
export type RelationDirection = "cited_by" | "cites";

export interface ExpandRequest {
  from_keys: string[];
  focus_key?: string | null;
  existing_group_keys: string[];
  direction: RelationDirection;
  order: CitingOrder;
  limit_per_node: number;
}

export interface ExpandResponse {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export interface RegistrationStatus {
  stage: "email" | "otp" | "profile" | "expired" | "locked";
  email_masked?: string | null;
  expires_at?: string | null;
  otp_expires_at?: string | null;
  resend_after?: number;
}
