# Functional Requirements

> **Scope**: MVP — trimmed and translated from the original Italian PRD (183 FRs) to ~80 core requirements.
> **Deferred features** are listed in Section 9.

---

## 1. Actors

| Actor | Capabilities |
|-------|-------------|
| **Anonymous user** | View public collections, register, log in |
| **Authenticated user** | All core features: collections, search, save, annotate, share, import/export, receive recommendations |
| **Collaborator** | View/edit shared collections per assigned role |
| **Collection owner** | Full control: share, revoke, change visibility, manage members |

---

## 2. Entities

### 2.1 Paper

A paper record includes, when available: internal canonical key, DOI, title, abstract, authors (with affiliations), venue, publication year, publication date, type (journal, conference, preprint, book, etc.), references, citations received, keywords, topics/fields, canonical URL, PDF URL, external identifiers (arXiv ID, PMID, PMCID, OpenAlex ID), language, retraction/correction status, and last-updated timestamp.

**Canonical key**: `doi:{normalized_doi}` when a DOI exists; otherwise `hash(normalized_title + sorted_author_last_names + year)`.

The system must support papers with incomplete metadata and must track distinct versions (preprint, conference, journal extension, correction) as separate but linked records.

### 2.2 Author

Name (canonical + known aliases), external identifiers (ORCID, OpenAlex ID), associated papers, co-authors, primary topics, affiliations (when available).

### 2.3 Collection

Unique ID, name, description, owner, visibility (private / shared / public), member list with roles, paper list, tags, notes, activity log.

### 2.4 Relations

| Relation | Description |
|----------|-------------|
| `cites` | Paper A references Paper B |
| `cited_by` | Paper B is cited by Paper A |
| `similar_to` | Semantic or topical similarity |
| `authored_by` | Author wrote Paper |
| `co_authored` | Two authors share at least one paper |
| `belongs_to_collection` | Paper is in a collection |
| `belongs_to_topic` | Paper is classified under a topic |
| `user_state` | User's relationship with a paper (saved, ignored, excluded, etc.) |

### 2.5 Note

Target (paper, author, or collection), free-text content, author of the note, created/updated timestamps. Edit history is preserved.

### 2.6 User Feedback

Explicit feedback states on papers: unseen, seen, saved, to-read, reading, read, important, ignored, excluded (same as FR-060). On authors/topics: follow, unfollow. On recommendations: "more like this", "less like this".

---

## 3. Functional Requirements by Module

### 3.1 Authentication & Identity

| ID | Requirement |
|----|-------------|
| FR-001 | The system shall allow new users to register with email and password. |
| FR-002 | The system shall allow registered users to log in. |
| FR-003 | The system shall allow users to log out, invalidating their session. |
| FR-004 | The system shall support password recovery via email. |
| FR-005 | The system shall allow users to view and edit their profile (display name, email, preferences). |

**Edge cases**: duplicate email, unverified account, wrong credentials, expired session.

### 3.2 Collections

| ID | Requirement |
|----|-------------|
| FR-006 | An authenticated user shall be able to create a new collection (empty or seeded with one or more papers). |
| FR-007 | The user shall be able to rename a collection and edit its description. |
| FR-008 | The user shall be able to set collection visibility: private, shared (invite-only), or public. |
| FR-009 | The user shall be able to add and remove papers from a collection. |
| FR-010 | The user shall be able to add tags to a collection. |
| FR-011 | The user shall be able to add notes at the collection level. |
| FR-012 | The user shall be able to duplicate a collection, preserving its contents and structure. |
| FR-013 | The user shall be able to archive a collection without deleting its data. |
| FR-014 | The user shall be able to delete a collection after explicit confirmation. |
| FR-015 | The user shall be able to order and filter papers within a collection by title, year, citation count, reading state, or tags. |

**Edge cases**: empty collection; collection with thousands of papers; concurrent rename by two collaborators; permission change during editing.

### 3.3 Paper Ingestion

| ID | Requirement |
|----|-------------|
| FR-016 | The system shall allow adding a paper by entering a DOI. |
| FR-017 | The system shall allow adding a paper by entering a title (with disambiguation if multiple matches). |
| FR-018 | The system shall allow adding a paper by entering a URL (arXiv, DOI link, publisher page). |
| FR-019 | The system shall allow adding a paper from search results. |
| FR-020 | The system shall allow adding a paper from recommendations or suggestions. |
| FR-021 | The system shall allow adding a paper directly from the graph exploration view. |
| FR-022 | The system shall allow adding papers from an author's profile page. |
| FR-023 | If a paper is not found in any external provider, the system shall allow manual creation of a minimal record (title + at least one author). |
| FR-024 | A manually created record shall be reconcilable with an external record if later found. |

**Edge cases**: invalid DOI; valid DOI but provider unreachable; ambiguous title; preprint vs. journal version; same paper with slightly different titles across providers.

### 3.4 Bibliographic Search

| ID | Requirement |
|----|-------------|
| FR-025 | The system shall support search by title, author, DOI, venue, year, and external identifiers. |
| FR-026 | The system shall support full-text search across available fields (title, abstract, keywords). |
| FR-027 | The system shall support search restricted to a specific collection. |
| FR-028 | The system shall support filtering by reading state, tags, and saved/excluded status. |
| FR-029 | The system shall support combined advanced filters (e.g., year range + author + topic). |
| FR-030 | The system shall allow ordering results by relevance, date, citation count, or recency. |
| FR-031 | The system shall provide query autocomplete/suggestions during input. |
| FR-032 | The system shall indicate whether a search result is already present in one or more of the user's collections. |

**Edge cases**: empty query; overly broad query; special characters; author name variants; venue renamed over time.

### 3.5 Deduplication & Reconciliation

| ID | Requirement |
|----|-------------|
| FR-033 | Before creating a new paper record, the system shall check for existing equivalent records using DOI, canonical key, or title+author similarity. |
| FR-034 | When equivalence confidence is high, the system shall auto-merge silently. |
| FR-035 | When equivalence is ambiguous, the system shall prompt the user for manual review. |
| FR-036 | On merge, all user data (notes, tags, reading states, collection memberships) shall be preserved in the surviving record. |
| FR-037 | The system shall distinguish genuinely different versions of the same work (preprint / conference / journal / correction / translation) and not auto-merge them. |
| FR-038 | Merges shall be traceable — the system records that a merge occurred. |

**Edge cases**: preprint vs. journal extension; conference paper vs. book chapter; correction/erratum; different titles across languages; same title, different authors.

### 3.6 Graph Exploration

| ID | Requirement |
|----|-------------|
| FR-039 | The system shall provide an interactive graph view showing relationships between papers. |
| FR-040 | The graph shall distinguish relationship types: citations, cited-by, similarity, author-paper, co-authorship, collection membership, and topic. |
| FR-041 | The user shall be able to expand a node to load its related papers/authors. |
| FR-042 | The user shall be able to collapse subgraphs to reduce clutter. |
| FR-043 | The user shall be able to set one or more seed nodes as the exploration focus. |
| FR-044 | The user shall be able to change focus by selecting a different node. |
| FR-045 | The user shall be able to filter visible nodes by type, date range, relevance, or reading state. |
| FR-046 | The user shall be able to filter visible edges by relationship type. |
| FR-047 | The user shall be able to control maximum depth and maximum number of displayed nodes. |
| FR-048 | The user shall be able to pin, hide, or lock specific nodes in the view. |
| FR-049 | The user shall be able to save the current graph state as a named snapshot. |
| FR-050 | The user shall be able to save, exclude, or annotate a paper directly from the graph view. |

**Edge cases**: very dense graphs; cycles; missing references; inferred (non-certain) relations; isolated nodes; conflicting edges from different providers.

### 3.7 Recommendations & Discovery

| ID | Requirement |
|----|-------------|
| FR-051 | The system shall generate recommendations from one or more seed papers. |
| FR-052 | The system shall generate recommendations from the content of a collection. |
| FR-053 | The system shall adapt recommendations based on the user's reading history and explicit feedback. |
| FR-054 | The system shall generate suggestions from followed authors and topics. |
| FR-055 | Every recommendation shall include a human-readable explanation (e.g., "Cited by 3 papers in your collection", "Same topic as paper X"). |
| FR-056 | The user shall be able to save, dismiss, or exclude a recommendation. |
| FR-057 | The system shall not aggressively re-propose papers the user has dismissed or excluded. |
| FR-058 | The system shall handle cold-start scenarios (new user, single-paper collection) by falling back to citation-based and topic-based suggestions. |
| FR-059 | The user shall be able to exclude specific authors, venues, topics, or year ranges from recommendations. |

**Edge cases**: contradictory feedback; bias toward highly-cited papers; single-paper collection; heterogeneous collection; recommendation loop.

### 3.8 Reading States & Tags

| ID | Requirement |
|----|-------------|
| FR-060 | The system shall support per-paper reading states: unseen, seen, saved, to-read, reading, read, important, ignored, excluded. |
| FR-061 | Reading states shall be tracked both globally (per user) and locally (per collection). |
| FR-062 | The user shall be able to filter papers by reading state. |
| FR-063 | The user shall be able to assign custom tags to any paper. |
| FR-064 | The user shall be able to search and filter by tags. |
| FR-065 | Papers marked as excluded or ignored shall be de-prioritized in search results and recommendations. |
| FR-066 | The system shall highlight unexamined papers within a collection or graph view. |

**Edge cases**: same paper in multiple collections with different states; accidental state change; state conflict between manual and inferred.

### 3.9 Notes & Annotations

| ID | Requirement |
|----|-------------|
| FR-067 | The user shall be able to add free-text notes to a paper. |
| FR-068 | The user shall be able to add notes to an author. |
| FR-069 | The user shall be able to add notes to a collection. |
| FR-070 | The user shall be able to edit existing notes; the system preserves edit history. |
| FR-071 | Notes shall be searchable. |
| FR-072 | Notes shall survive paper merges and metadata updates — they remain linked to the correct logical entity. |

**Edge cases**: two collaborators editing the same note; merge of annotated records; paper removed from collection but notes persist; references in notes to deleted entities.

### 3.10 Provider Integration

| ID | Requirement |
|----|-------------|
| FR-073 | The system shall integrate with external bibliographic providers through an abstract provider layer. |
| FR-074 | The system shall support lookup by DOI and other identifiers against all configured providers. |
| FR-075 | The system shall use providers for search, reference retrieval, citation retrieval, and author lookup. |
| FR-076 | The system shall implement a fallback chain: if the primary provider fails or returns no data, the next provider is tried. |
| FR-077 | The system shall handle provider rate limits, temporary unavailability, and partial responses gracefully — with explicit user-facing messages and no data loss. |
| FR-078 | The system shall cache provider responses in Redis with configurable TTLs per provider and query type (lookup, search, references, citations). |

**Edge cases**: provider down; schema change; partial data; conflicting metadata between providers; quota exceeded; expired token.

### 3.11 Import & Export

| ID | Requirement |
|----|-------------|
| FR-079 | The system shall support import from a list of DOIs (single or batch). |
| FR-080 | The system shall support import from BibTeX files. |
| FR-081 | The system shall provide an import preview showing matched, unmatched, and duplicate records. |
| FR-082 | The system shall deduplicate during import. |
| FR-083 | The system shall continue importing even if some records fail, and produce a summary report (successes, duplicates, failures). |
| FR-084 | BibTeX export is deferred beyond the public-release patch; OpenBib currently exports references through Zotero. |
| FR-085 | The public-release gate includes password-protected, versioned JSON export of profile, collections/memberships, library versions, notes, tags, states, preferences, dismissed items, metadata and Zotero mappings, excluding credentials and security internals. |

**Edge cases**: malformed file; wrong encoding; duplicates within the same import file; very large import; interrupted import.

### 3.12 Collaboration & Sharing

| ID | Requirement |
|----|-------------|
| FR-086 | The system shall support three collection visibility levels: private, shared (invite-only), and public. |
| FR-087 | The collection owner shall be able to invite collaborators with a role: editor or viewer. |
| FR-088 | The owner shall be able to revoke access at any time. |
| FR-089 | Editors shall be able to add/remove papers and add notes to a shared collection. Viewers can only read. |
| FR-090 | Any authenticated user shall be able to browse public collections of other users. |
| FR-091 | Any authenticated user shall be able to import (clone) a public collection into their own account. |
| FR-092 | In shared collections, the system shall distinguish between private notes (visible only to the author) and shared notes (visible to all members). |

**Edge cases**: user removed during active editing; invite sent to non-existent user; visibility changed while collaborator is editing; owner deletes account while shared collections exist.

---

## 4. Global Behavioral Rules

1. **No silent data loss**: Notes, tags, reading states, and feedback shall never be lost due to metadata updates, merges, or sync operations.
2. **Incomplete data is acceptable**: The system shall not block usage of a paper with partial metadata, provided a minimum valid record exists (canonical key + title).
3. **Graceful degradation**: If a feature depends on an unavailable provider, the system shall degrade visibly without affecting user data or unrelated features.
4. **Explainability**: Any recommendation, suggested connection, or automatic action (merge, dedup) shall include a user-readable explanation.
5. **User control**: The user can undo, modify, hide, or override any automated action that affects their experience (merges, recommendations, state changes).

---

## 5. Acceptance Criteria

| ID | Scenario | Expected outcome |
|----|----------|-----------------|
| AC-01 | **Seed to discovery**: User adds 3 papers to a new collection | System retrieves metadata, shows citation graph, generates ≥5 recommendations with explanations, and adapts suggestions based on save/dismiss feedback |
| AC-02 | **Import and organize**: User imports a BibTeX file with 50 entries | System shows preview, deduplicates, reports successes/failures, creates a filterable and taggable collection |
| AC-03 | **Explainable recommendation**: User inspects a suggestion | System shows why it was proposed (e.g., "shares 2 authors with papers in your collection") |
| AC-04 | **Feedback loop**: User marks a paper as excluded | That paper does not reappear in subsequent recommendations unless new context emerges |
| AC-05 | **Collaboration**: Owner shares a collection; editor adds a paper and a note | Owner sees the change in the activity log; permissions are respected throughout |
| AC-06 | **Data preservation on merge**: Two duplicate records are merged | All notes, tags, and reading states from both records are preserved in the surviving record |
| AC-07 | **Graceful degradation**: OpenAlex is down | User sees a clear message; cached data remains available; user data (collections, notes) is unaffected |

---

## 6. Critical Edge Cases

### 6.1 Bibliographic Data
- DOI present but wrong; DOI absent; DOI valid but provider unreachable
- Ambiguous title; same title for different works
- Preprint vs. journal; conference vs. journal extension; correction/erratum
- Missing abstract, references, or citations
- Author name variants, ordering differences between providers
- Metadata encoding errors; multilingual titles/transliterations
- Year known but full date unknown

### 6.2 Graph & Discovery
- Isolated paper (no relations); hyper-cited paper dominating suggestions
- Heterogeneous collection; cold start; contradictory feedback
- Recency bias; classic-paper bias; single-author/venue domination
- Excluded paper reappearing; recommendation loop
- Excessive graph density

### 6.3 Multi-User
- Concurrent edits; permission loss during editing
- Private notes in shared collections; merge of records annotated by multiple users
- Owner deletion with active shared collections

### 6.4 External Providers
- Rate limit; expired token; provider down; schema change
- Partial data; conflicting metadata between providers
- Same paper returned with different metadata by different providers

### 6.5 Import/Export
- Corrupted file; large import; interrupted import; partial retry
- Sync conflicts; element removed in source but annotated locally
- Same library connected twice

---

## 7. Requirement Traceability Matrix

| Module | FR range | Architecture layer |
|--------|----------|--------------------|
| Authentication | FR-001 – FR-005 | Auth middleware, Users service, Users table |
| Collections | FR-006 – FR-015 | Collections service, Collections/Members tables |
| Paper Ingestion | FR-016 – FR-024 | Papers service, Provider layer, Dedup service |
| Search | FR-025 – FR-032 | Search service, Provider layer, Cache |
| Deduplication | FR-033 – FR-038 | Dedup service, Canonical key logic |
| Graph Exploration | FR-039 – FR-050 | Graph service, Graph edges table, Frontend graph component |
| Recommendations | FR-051 – FR-059 | Recommendation service, Provider layer, Feedback table |
| Reading States & Tags | FR-060 – FR-066 | States service, States/Tags tables |
| Notes | FR-067 – FR-072 | Notes service, Notes table |
| Provider Integration | FR-073 – FR-078 | Provider layer, Cache layer (Redis) |
| Import/Export | FR-079 – FR-085 | Import/Export service, Provider layer |
| Collaboration | FR-086 – FR-092 | Collections service, Members table, Auth middleware |

---

## 8. Entity Summary

| Entity | Stored locally? | Source of truth |
|--------|----------------|-----------------|
| User | Yes (PostgreSQL) | Our system |
| Collection | Yes (PostgreSQL) | Our system |
| Collection membership | Yes (PostgreSQL) | Our system |
| Paper metadata | Cached (Redis) | External providers |
| Paper–collection link | Yes (PostgreSQL) | Our system |
| Reading state | Yes (PostgreSQL) | Our system |
| Tag | Yes (PostgreSQL) | Our system |
| Note | Yes (PostgreSQL) | Our system |
| Graph edges (citations, similarity) | Cached (Redis + materialized table) | External providers |
| Author metadata | Cached (Redis) | External providers |

---

## 9. Deferred Features (Post-MVP)

The following capabilities are acknowledged but explicitly excluded from the MVP:

- **FR-D01** Timeline / temporal evolution visualization
- **FR-D02** Activity feed and notification system
- **FR-D03** Advanced personalization engine (implicit signals, profile attenuation, feedback-loop dampening)
- **FR-D04** Full audit trail and detailed activity history
- **FR-D05** Identity federation (OAuth via Google, ORCID, institutional SSO)
- **FR-D06** Admin dashboard and content moderation tools
- **FR-D07** Sync with external reference managers (Zotero, Mendeley)
- **FR-D08** Collection merge (combining two collections into one)
- **FR-D09** Exploration snapshots with shareable URLs
- **FR-D10** Mobile-native applications
