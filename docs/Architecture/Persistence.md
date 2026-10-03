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
to mirror the academic corpus. Paper metadata is fetched on demand from
Semantic Scholar, the only active provider (the OpenAlex, arXiv, Crossref and
Europe PMC adapters are retained but inactive); what gets
persisted is (a) everything the user created, and (b) a durable snapshot
of the metadata for every paper a user has actually touched.

## PostgreSQL — system of record

### User data (created by users, irreplaceable)

| Table | Contents | Key |
|-------|----------|-----|
| `users` | Account, Argon2id password hash, display name | `id` (UUID) |
| `collections` | Name, description, revision, encrypted revocable read link | `id` (UUID) |
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
indexed), upserted every time a paper flows through search (the served
page only), lookup, add or import, or a served related-paper range in the
graph. This is deliberately in Postgres, not Redis: it backs
features that must work even when providers are down or the Redis cache
is cold — the paper-details view, hydrated collection rows, library
entries, and graph node rendering.

Field audit (all present and consumed by the details view):

| Group | Fields |
|-------|--------|
| Identity | `canonical_key`, `paper_group_key`, `semantic_scholar_id` (indexed), `doi`, `arxiv_id`, `pmid`, `pmcid`, `openalex_id`, `version` |
| Bibliographic | `title`, `authors_json`, `abstract`, `publication_date`, `venue`, `volume`, `issue`, `pages`, `paper_type` |
| Classification | `topics_json`, `keywords_json` |
| Access | `open_access`, `pdf_url`, `abstract_url` |
| Impact | `cited_by_count`, `reference_count` |
| Provenance | `provider_source`, `provider_sources_json`, `updated_at` |

The Zotero sync also maps items directly from this table.

### Paper identifiers

Every paper row is keyed by a canonical key: `doi:<lowercase DOI>` when the
paper has a DOI, otherwise `s2:<40 hex paperId>` for Semantic Scholar records
without a DOI, or `hash:<16 hex>` (title, authors and year) for older records
from other providers. `arxiv:`, `pmid:` and `pmcid:` keys are accepted as
input and as lookup keys, but a write stores the resolved snapshot's key. All
versions of one logical paper share a `group:` key, which anchors Library
entries, tags and notes.

**Accepted input** (collection add and import, Library resolve `replacement`):

| Form | Examples | Normalized key |
|------|----------|------------|
| DOI | `10.1038/nature14539`, `doi:`, `DOI:` or `DOI ` prefixes, `https://doi.org/…`, `http://dx.doi.org/…`, `www.doi.org/…`, a percent-encoded DOI link | `doi:10.1038/nature14539` |
| Semantic Scholar | `s2:<40 hex>`, `https://www.semanticscholar.org/paper/<slug>/<40 hex>` | `s2:<lowercase hex>` |
| arXiv | `arxiv:2501.00663`, `arxiv.org/abs/…` or `/pdf/…` links, a bare new-style ID (`2501.00663v2`); old-style IDs (`hep-th/9901001`) need the prefix or a link | `arxiv:<id without version>` |
| PubMed | `pmid:12345678` | `pmid:12345678` |
| PubMed Central | `pmcid:PMC1234567` | `pmcid:PMC1234567` |
| Internal | a `hash:` key that is already cached | unchanged |

Surrounding whitespace (including NBSP and zero-width characters) is ignored.
The paper is then stored under the cached snapshot's key when one exists (see below).

**Normalization** (`app/common/identifiers.py`). Keys built from provider data
(`build_canonical_key`, `map_paper`) stay byte-identical; only user input is
normalized.

| Helper | Used on | Behavior |
|--------|---------|----------|
| `parse_paper_identifier` (strict) | Write paths: add, import, resolve `replacement` | Any form in the table above becomes its key; a `hash:` key passes (the caller checks it is known); anything else is 422 `invalid_identifier` |
| `normalize_paper_key`, `PaperKey` (lenient) | Read, annotation, graph and delete paths | DOI-like input becomes `doi:…`; `s2:`, `arxiv:`, `pmid:` and `pmcid:` keys keep their value with the prefix lowercased (and the S2 paperId lowercased, the PMCID uppercased); `hash:`/`group:` keys pass through; anything else is returned stripped so the lookup simply misses; deletes try the exact stored key first |

Only URL-form input is percent-decoded (a `doi:` key never is), and trailing
punctuation is kept because some DOIs end in a period.

**Alias lookup and the stored-key rule.** `get_cached_paper` finds a snapshot
by its canonical key or, failing that, by the `doi`, `semantic_scholar_id`,
`arxiv_id`, `pmid` or `pmcid` column the key names. Snapshot upserts merge a
provider record into a row that already holds one of its aliases and keep that
row's key and group. Every write path therefore stores the paper under the
**stored row's** canonical key and group, never the typed one: a DOI added for
a paper cached as `s2:Y` lands on `s2:Y`.

**Resolution** (`registry.resolve_doi` and `resolve_id`, one lookup bounded by
`DOI_RESOLVE_TIMEOUT_SECONDS`; imports batch them within
`IMPORT_REQUEST_BUDGET_SECONDS`):

| Status | Meaning | Effect on a DOI add | Effect on an `s2:`/`arxiv:`/`pmid:`/`pmcid:` add |
|--------|---------|---------------------|-----------------------|
| `found` | Semantic Scholar returned metadata | Snapshot upserted; stored under the snapshot's key and real group | Same |
| `not_found` | Semantic Scholar missed and, for a DOI, doi.org does not know the handle | 422 `doi_not_found`; nothing written | 422 `identifier_not_found`; nothing written |
| `unavailable` | Timeout, provider error, or a registered DOI Semantic Scholar does not describe | Stored as pending (`resolved: false`) | 503 with `Retry-After` (or an operator code); nothing written |

Only DOIs can be pending, because doi.org can confirm they exist. In an
import a pending DOI is reported as `unresolved`, and a retryable failure of
any other identifier as `unavailable` (not saved).

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
stored key again, or re-keys it to a corrected identifier. `resolved` moves
the rows onto the stored snapshot's key and real group, merging them with any
rows already there; `unavailable` still moves a legacy raw key to its
normalized `doi:` form (pending) but otherwise changes nothing; `not_found`
changes nothing. It changes only the caller's own rows and rows in
collections they can edit (owner or editor), and gives the caller a Library
entry for collection rows that moved.

**Legacy repair.** Keys stored before normalization existed (bare DOIs,
`DOI:` labels, doi.org links) are re-keyed to `doi:` by migration
`1d2e3f4a5b6c` (`app/common/key_repair.py`, a frozen copy of the normalizer
over frozen table definitions). Rows already stored under the canonical key
absorb the legacy ones: collection rows keep the earliest position, reading
states keep the most progressed one, duplicate tags, dismissals, Zotero links
and graph edges are dropped. `cached_paper_metadata` is never touched, and keys
that cannot become a DOI (such as `doi:not-a-doi`) are reported as
unrepairable and left for the user to fix through resolve.

Excluded from the repair (neither re-keyed nor reported): `hash:` and `group:`
keys, the strong non-DOI keys `s2:`, `arxiv:`, `pmid:`, `pmcid:` and
`openalex:`, which are valid as stored, and any key that is itself the key of
a cached snapshot. One known limitation: the repair is not alias-aware, so a
raw DOI whose paper is cached under an `s2:` key moves to its `doi:` form, not
onto the `s2:` key. Reads still find the paper through its DOI alias, and the
user's `POST /library/resolve` (Retry) merges it onto the `s2:` key.

The repair is idempotent but irreversible: its downgrade is a no-op. With the
writers stopped, preview it through the `migrate` service with
`python -m scripts.repair_paper_keys --dry-run` (`--apply` runs the same
repair outside Alembic), then take a backup; the migration log shows counts only. See
[Backups](../Operations/Backups.md#before-deploying-migration-1d2e3f4a5b6c).

## Redis — short-TTL API cache

Cache-through in `app/providers/cache.py`; key format
`openbib:cache:{provider}:{query_type}:{sha256(params)[:12]}`, where
`{provider}` is the cache namespace `papers-v3:semantic_scholar`
(`registry.CACHE_NAMESPACE`, which changes when the enabled providers do).

| Query type | TTL (code default) | Rationale |
|------------|-----|-----------|
| Lookup (DOI/arXiv/PMID) | 24 h | Metadata is stable |
| **Search (served page)** | 1 h | Repeat keyword searches within the TTL never hit Semantic Scholar |
| References | 7 d | Fixed once published |
| Citations | 12 h | Counts grow |
| Author | 24 h | Profiles change rarely |

`.env.example` sets its own values for some of these (`CACHE_TTL_*`).

Other key families:

| Key | TTL | Contents |
|-----|-----|----------|
| `openbib:cache:{ns}:search:…` | `CACHE_TTL_SEARCH` | One search response per full signature: `SEARCH_CACHE_VERSION` (`v4`), query, filters, sort, cursor, page and size |
| `openbib:cache:{ns}:search-bulk:{sha256[:32]}` | `CACHE_TTL_SEARCH` | One bulk-search batch (up to 1,000 mapped papers, the upstream total and the continuation token) per query, filters, sort and token; the newest and most-cited sorts slice it through their cursor |
| `openbib:cache:{ns}:references:…` (`ids:<paperId>`) | `CACHE_TTL_REFERENCES` | Reference paperIds of one paper, for base-graph edges |
| `openbib:graph:related:{ns}:{sha16}:meta`, `:raw`, `:order:cited_by_count`, `:order:recent` | `CACHE_TTL_CITATIONS` for citers, `CACHE_TTL_REFERENCES` for references, set when the snapshot is created | Related-list snapshot per (S2 paperId, direction): fill progress, raw compact entries while collecting, then the two ranked lists |
| `openbib:graph:noid:{ns}:{sha16}` | 24 h | An identifier Semantic Scholar answered with 404, so the graph does not look it up again |
| `rate:{scope}:{pseudonym}` | About twice the window | Rate-limit token buckets |

Notes:

- The search cache stores the final grouped response under a single key per
  full query signature — one key, maximum hit rate. `SEARCH_CACHE_VERSION`
  lets a response-shape change skip old entries without changing the namespace,
  which would also cool the graph and reference caches. A provider failure is
  never cached.
- Snapshot creation, appends and ranking run in Lua scripts guarded by the
  snapshot's chunk count, so concurrent requests cannot interleave chunks and
  a hot snapshot still expires. Snapshots are rebuildable like every other
  key here.
- Redis failure closes authentication, search, graph and Zotero routes; normal authenticated CRUD can temporarily continue with a sanitized warning. Provider-cache failure alone does not bypass the rate-limit boundary.
- Nothing in Redis is authoritative; `docker compose down` without `-v`
  keeps Postgres and loses nothing meaningful.

## Intentional side effects of anonymous use

Anonymous exploration (public search, paper details, related-paper ranges,
collection graphs opened through a read link) still upserts
`cached_paper_metadata` rows, and base graphs may persist
`paper_graph_edges` among their seeds. Both hold **global citation facts** with no user
scoping, so this is by design: anonymous traffic warms the snapshot for
everyone without touching any user's data.

## Security and further work

- Zotero credentials now use versioned AES-256-GCM ciphertext. The encryption migration removes plaintext transactionally; see [Security](../Security.md).
- Periodic refresh policy for stale `cached_paper_metadata` rows
  (citation counts age; a lightweight re-fetch on read after N days).

Collection authorization and capability lifecycle: [Collection sharing](CollectionSharing.md).
