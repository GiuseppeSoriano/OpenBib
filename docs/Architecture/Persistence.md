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

### Paper identifiers

Every paper row is keyed by a canonical key: `doi:<lowercase DOI>`, or
`hash:<16 hex>` (title, authors and year) for papers without a DOI. All
versions of one logical paper share a `group:` key, which anchors Library
entries, tags and notes.

**Accepted input** (collection add and import, Library resolve): a bare DOI
(`10.1038/nature14539`), `doi:`, `DOI:` or `DOI ` prefixes, `https://doi.org/`,
`http://dx.doi.org/` and `www.doi.org/` links, a percent-encoded DOI link and
surrounding whitespace (including NBSP and zero-width characters), or a
`hash:` key that is already cached.

**Normalization** (`app/common/identifiers.py`). Keys built from provider data
(`build_canonical_key`) stay byte-identical; only user input is normalized.

| Helper | Used on | Behavior |
|--------|---------|----------|
| `parse_paper_identifier` (strict) | Write paths: add, import, resolve `replacement` | Any accepted DOI form becomes `doi:<lowercase>`; a `hash:` key passes (the caller checks it is known); anything else is 422 `invalid_identifier` |
| `normalize_paper_key`, `PaperKey` (lenient) | Read, annotation and delete paths | DOI-like input becomes `doi:…`, `hash:`/`group:` keys pass through, anything else is returned stripped so the lookup simply misses; deletes try the exact stored key first |

Only URL-form input is percent-decoded (a `doi:` key never is), and trailing
punctuation is kept because some DOIs end in a period.

**Resolution** (`registry.resolve_doi`, bounded by `DOI_RESOLVE_TIMEOUT_SECONDS`):

| Status | Meaning | Effect on add |
|--------|---------|---------------|
| `found` | A provider returned metadata | Snapshot upserted; stored under the provider's key (possibly an alias) and real group |
| `not_found` | Every provider missed and doi.org does not know the handle | 422 `doi_not_found`; nothing written |
| `unavailable` | Timeout, provider error, or a registered handle without metadata | Stored as pending (`resolved: false`) |

No provider call runs while a request holds the per-user row lock: write
paths authorize and pre-dedupe, commit, resolve with no transaction open, then
re-check rights and duplicates in a short write transaction.

**Synthetic groups and re-anchoring.** A pending paper is pinned under
`synthetic_group_key(key)` (`group:` plus the first 16 hex characters of
the key's SHA-256), so its entry can hold tags and notes. When the real group
becomes known (a later add or save, or `POST /library/resolve`),
`reanchor_pin` moves the pin with its tags and notes to the real entry and
deletes the old entry once no pin is left under it.

**Retry and correction.** `POST /library/resolve`
(`{paper_canonical_key, replacement?}`, 30 per minute per user) resolves a
stored key again, or re-keys it to a corrected identifier. It changes only the
caller's own rows and rows in collections they can edit; `not_found` changes
nothing.

**Legacy repair.** Keys stored before normalization existed (bare DOIs,
`DOI:` labels, doi.org links) are re-keyed to `doi:` by migration
`1d2e3f4a5b6c` (`app/common/key_repair.py`, a frozen copy of the normalizer
over frozen table definitions). Rows already stored under the canonical key
absorb the legacy ones: collection rows keep the earliest position, reading
states keep the most progressed one, duplicate tags, dismissals, Zotero links
and graph edges are dropped. `cached_paper_metadata` is never touched, and keys
that cannot become a DOI (such as `doi:not-a-doi`) are left for the user to
fix through resolve. The repair is idempotent and its downgrade is a no-op, so
take a backup first and preview it with
`python -m scripts.repair_paper_keys --dry-run`; the migration log shows
counts only.

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
