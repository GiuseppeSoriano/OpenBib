# Persistence Architecture

> Which datastore holds what, and why. This is the reference for the
> "what is stored persistently where" question.

## Overview

OpenBib uses two datastores with sharply separated roles:

| Store | Role | Durability |
|-------|------|------------|
| **PostgreSQL 16** | System of record: all user data + the durable paper-metadata snapshot | Permanent; migrated with Alembic |
| **Redis 7** | Short-TTL cache of external API responses | Fully rebuildable; safe to flush at any time |

The founding principle is **user-data-only storage**: OpenBib does not try
to mirror the academic corpus. Paper metadata is fetched from external
providers (OpenAlex, arXiv, Crossref, Europe PMC) on demand; what gets
persisted is (a) everything the user created, and (b) a durable snapshot
of the metadata for every paper a user has actually touched.

## PostgreSQL — system of record

### User data (created by users, irreplaceable)

| Table | Contents | Key |
|-------|----------|-----|
| `users` | Account, Argon2id password hash, display name | `id` (UUID) |
| `collections` | Name, description, visibility (`private/shared/public`) | `id` (UUID) |
| `collection_members` | Collaboration roles (`owner/editor/viewer`) | `(collection_id, user_id)` |
| `collection_papers` | Specific paper *versions* saved in a collection | `(collection_id, paper_canonical_key)` |
| `user_library_entries` | One row per logical paper in the user's library; anchors notes/tags | `(user_id, paper_group_key)` |
| `user_library_versions` | Explicitly pinned versions under a library entry | `(user_id, paper_canonical_key)` |
| `user_paper_states` | Reading states, per version | `(user_id, paper_canonical_key)` |
| `user_paper_tags` | Tags (anchored to `paper_group_key` for version survival) | `(user_id, paper_canonical_key, tag)` |
| `user_dismissed_papers` | "Not relevant" dismissals for search filtering | `(user_id, paper_canonical_key)` |
| `notes` | Notes on papers / collections / authors (paper notes anchored on `paper_group_key`) | `id` (UUID) |
| `user_preferences` | Free-form per-user preference JSON | `(user_id, key)` |
| `zotero_credentials` | Zotero API key (masked in API responses) + Zotero userID | `user_id` |
| `zotero_links` | Local object ↔ Zotero key mapping (what makes sync idempotent) | `(user_id, local_type, local_key)` |
| `paper_graph_edges` | Persisted citation edges among saved papers (global facts) | `(source_key, target_key, relation_type)` |

### `cached_paper_metadata` — the durable metadata snapshot

One row per paper *version* (`canonical_key` PK, `paper_group_key`
indexed), upserted every time a paper flows through search, lookup, or
graph expansion. This is deliberately in Postgres, not Redis: it backs
features that must work even when providers are down or the Redis cache
is cold — the paper-details view, hydrated collection rows, library
entries, and graph node rendering.

Field audit (all present and consumed by the details view):

| Group | Fields |
|-------|--------|
| Identity | `canonical_key`, `paper_group_key`, `doi`, `arxiv_id`, `pmid`, `pmcid`, `openalex_id`, `version` |
| Bibliographic | `title`, `authors_json`, `abstract`, `publication_date`, `venue`, `volume`, `issue`, `pages`, `paper_type` |
| Classification | `topics_json`, `keywords_json` |
| Access | `open_access`, `pdf_url`, `abstract_url` |
| Impact | `cited_by_count`, `reference_count` |
| Provenance | `provider_source`, `provider_sources_json`, `updated_at` |

The Zotero sync also maps items directly from this table.

## Redis — short-TTL API cache

Cache-through in `app/providers/cache.py`; key format
`openbib:cache:{provider}:{query_type}:{sha256(params)[:12]}`.

| Query type | TTL | Rationale |
|------------|-----|-----------|
| Lookup (DOI/arXiv/PMID) | 24 h | Metadata is stable |
| **Search (merged fan-out)** | 1 h | Repeat keyword searches within the TTL never hit the public APIs |
| References | 7 d | Fixed once published |
| Citations | 12 h | Counts grow |
| Author | 24 h | Profiles change rarely |

Notes:

- The search cache stores the final merged/grouped response under a single
  key per full query signature (query, providers, filters, page, size) —
  one key, maximum hit rate. Total provider failure is never cached.
- Redis failure closes authentication, search, graph and Zotero routes; normal authenticated CRUD can temporarily continue with a sanitized warning. Provider-cache failure alone does not bypass the rate-limit boundary.
- Nothing in Redis is authoritative; `docker compose down` without `-v`
  keeps Postgres and loses nothing meaningful.

## Intentional side effects of anonymous use

Anonymous exploration (public search, paper details, graph expansion)
still upserts `cached_paper_metadata` rows and may persist
`paper_graph_edges`. Both hold **global citation facts** with no user
scoping, so this is by design: anonymous traffic warms the snapshot for
everyone without touching any user's data.

## Security and further work

- Zotero credentials now use versioned AES-256-GCM ciphertext. The encryption migration removes plaintext transactionally; see [Security](../Security.md).
- Periodic refresh policy for stale `cached_paper_metadata` rows
  (citation counts age; a lightweight re-fetch on read after N days).
