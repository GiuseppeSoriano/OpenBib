# Paper retrieval: Semantic Scholar only

Implemented on `codex/semantic-scholar-provider`. This document supersedes the
historical multi-provider requirements in `Requirements/04-APIIntegration.md`.

## Audit and call graph

Before this change, importing the registry constructed four HTTP clients:
OpenAlex, Crossref, arXiv and Europe PMC. Search called all four concurrently
and round-robin interleaved the results. DOI, arXiv and PMID lookups used different
sequential fallback chains. Search deduplication compared only canonical keys
and discarded complementary metadata. DOI keys were preferred; otherwise title,
author surnames and year produced a hash. Group keys associate paper versions.

User-facing paths as they stand after the UI/UX audit work (the audit above
describes the code before the Semantic Scholar change):

- Search page → `GET /papers/search` → Redis search cache → relevance search
  (`/paper/search`, paged by `page`) or, for the date and citation sorts, a
  cached bulk-search batch (`/paper/search/bulk`) served in slices through an
  opaque cursor → normalization and deduplication → SQL metadata snapshots of
  the served rows only → grouped response with possible-version hints.
- Paper details → `GET /papers/{key}` → durable SQL snapshot (through any
  alias) → a live `GET /paper/{id}` on a miss. Library, collection and Zotero
  views use those snapshots; they do not perform independent provider requests.
- Collection add, collection import and `POST /library/resolve` resolve
  identifiers before saving: single lookups for an add or a resolve, one
  `POST /paper/batch` per 500 identifiers for an import, and the doi.org handle
  API only to confirm DOIs the provider does not know (see
  [Identifier resolution](#identifier-resolution-and-pending-dois)).
- Library/collection graph → `build_base_graph` → seeds without an S2 ID are
  batch-resolved, then each seed's reference IDs (Redis, otherwise one batch
  `references.paperId` call) → intersection with saved seeds.
- Related papers in the graph → `POST /graph/related` and
  `POST /graph/related/top-up` → a ranked Redis snapshot of the source's
  citations or references → only the served papers are hydrated (SQL first,
  then one batch lookup). `POST /graph/expand` and the whole-list helpers it
  used are removed.
- Similar-paper recommendations query persisted co-citation edges in SQL. They
  do not use an external recommendations endpoint.
- There is no application route/caller for author profiles, author search,
  embeddings or full-text download. Author names and IDs come with paper
  metadata. Old adapters retain their unused methods.
- Zotero is an explicitly connected export/sync destination, not an academic
  discovery provider. Paper/PDF links opened by users are external navigation,
  not server-side metadata fallback.

Existing tests cover mapping, canonical/group keys, round-robin merging,
search API/cache, paper details, hydrated collections, library and citation
orientation/grouping. The old adapters had timeouts and process-local pacing,
but no common retry infrastructure; their errors were frequently swallowed.

## Active architecture

`providers/registry.py` owns a lazy factory catalog, `ENABLED_PROVIDERS` and the
primary graph authority. Only `semantic_scholar` is enabled. The other four
modules remain intact but are not imported or instantiated by application
startup or paper operations. A requested provider list can only narrow the
enabled list; disabled/unknown names return 422 before a cache lookup or request.
There is no automatic fallback and no anonymous mode. Legacy flags in existing
`.env` files do not enable extra providers.

The existing `BaseProvider` and domain models are reused. Full graph paper and
reference-ID operations are now explicit adapter methods. Clients are closed
at application shutdown. Search/graph Redis namespaces include an architecture
version and enabled provider set, preventing reuse of old fanout/OpenAlex cache
entries. Durable SQL snapshots and historical provenance remain readable.

## Required endpoint mapping

The official [Academic Graph documentation](https://api.semanticscholar.org/api-docs/graph)
and its [OpenAPI schema](https://api.semanticscholar.org/graph/v1/swagger.json)
were inspected on 2026-09-26. Endpoint paths below are relative to
`https://api.semanticscholar.org/graph/v1`.

| Application operation | Endpoint | Identifiers/fields | Pagination and behavior |
| --- | --- | --- | --- |
| Search, relevance order | `GET /paper/search` | Plain query (hyphens become spaces); shared paper field set below | `offset=(page-1)*size`, size 1–100. The API requires `offset + limit < 1000`, so only the first 999 ranked results are reachable; a page past the window is 422 `search_window_exceeded` and the last reachable page sets `window_capped`. `total` becomes `total_estimate`. Year and public-PDF filters (plus venue and publication type when given) are passed upstream. |
| Search, newest or most cited | `GET /paper/search/bulk` | `sort=publicationDate:desc` or `citationCount:desc`; query reduced to plain words (`+ \| - " * ( ) ~` removed); shared paper fields | Up to 1,000 rows per call plus a continuation `token`. Bulk search matches every (stemmed) word and has no relevance ranking. The date sort replaces `year` with `publicationDateOrYear=<year_from>-01-01:<min(today, year_to-12-31)>` (open start without `year_from`; a `year_from` in the future returns an empty page), because the API lists future-dated records first. Each batch is cached in Redis and served `size` rows at a time (the UI asks for 20) through `next_cursor`. |
| Detail/cache miss; single add and resolve; graph source lookup | `GET /paper/{id}` | S2 paper ID, `DOI:…`, `ARXIV:…`, `PMID:…`, `PMCID:<digits>` | Single response; 404 means absent. Only the value after the prefix is percent-encoded (`DOI:10.1109%2F…`). DOI URLs/case and arXiv version suffixes are normalized; `s2:` is OpenBib's canonical prefix and is removed before transmission. |
| Import resolution; graph hydration; base-graph seed lookup | `POST /paper/batch` | Body `{"ids": [...]}` with the same identifier forms; shared paper fields | At most 500 ids per call; results come back in input order with `null` for a miss. A response of the wrong length or shape is 502 `provider_bad_response`. |
| Base graph edges among saved papers | `POST /paper/batch` with `fields=paperId,references.paperId` | Seed S2 IDs | One call per 500 seeds, cached per seed in Redis. If the batch fails, references are read seed by seed (`GET /paper/{id}/references`, `paperId` only) within the edge budget, and the response sets `edges_partial`. |
| Related ranges: citing papers | `GET /paper/{id}/citations` | `paperId,title,authors,year,publicationDate,externalIds,citationCount` from nested `citingPaper` | Offset pages of `GRAPH_RELATED_CHUNK_SIZE` (default 1,000) rows, unordered, no total. The API requires `offset + limit < 10000`, so at most 9,999 records are reachable. Rows with a null `paperId` are skipped. See [Related-paper ranges](#related-paper-ranges). |
| Related ranges: referenced papers | `GET /paper/{id}/references` | Same fields, from nested `citedPaper` | Same paging and limit as citations. |
| DOI existence check | `GET https://doi.org/api/handles/{doi}?type=URL` | The DOI only | Not Semantic Scholar: asks the DOI handle registry whether a DOI the provider did not return is registered at all. It never fetches metadata. 404 means not registered; any other failure is treated as "unknown". |

The API also accepts CorpusId, MAG, ACL and certain URL identifiers, but no
additional application workflow was introduced for them. No author,
recommendations or dataset endpoints are used. The batch and bulk-search
endpoints are now used, as listed above: imports and graph hydration needed
them to stay within the one-request-per-second key budget.

Shared requested paper fields are exactly:
`title,abstract,authors,year,publicationDate,externalIds,venue,journal,url,isOpenAccess,openAccessPdf,citationCount,referenceCount,publicationTypes,fieldsOfStudy`.
`paperId` is always returned; `authors` supplies `authorId` and `name`. These
supply existing cards, detail panels, graph ranking, Zotero export and identity.
No raw responses are persisted or exposed. Publication types map to the existing
domain vocabulary (including Zotero conference/book types); arXiv DOI records
are labeled preprints instead of being mistaken for journal publications. DOI, arXiv, PMID and PMCID are retained
from external IDs; unconsumed IDs/embeddings/TLDR are not added to the model.
A nullable indexed S2 ID is added to paper snapshots; author IDs live in the
existing author JSON, and both are included in API/TypeScript models. Missing
optional fields stay null/empty. Year-only publication dates use January 1,
consistent with the existing date-only model; this is not an asserted exact date.

Titles and abstracts are cleaned to plain text in `map_paper`
(`app/common/text.py`: markup unwrapped, entities decoded, section headings
kept as labels); canonical and group keys are still computed from the raw
title. `url` is always the paper's semanticscholar.org landing page and is
stored as `abstract_url`; the UI shows it as "View on Semantic Scholar", never
as full text. `openAccessPdf.url` is stored as `pdf_url` (an empty URL that
only carries a disclaimer counts as absent). It is often a repository landing
page rather than a PDF (the audit's figshare example), so the UI labels it
"Download PDF" only when the URL itself points at a PDF and "Full text /
Repository" otherwise.

The upstream contract does not guarantee disjoint records across pages or
operations. Every search result and combined graph traversal is deduplicated,
as are combined search streams and durable cache writes.

## Identity and storage decisions

1. Match S2 ID first; it can join incomplete records whose other IDs differ.
2. Otherwise use normalized DOI, versionless arXiv, PMID/PMCID or retained
   OpenAlex identity. Matching a weaker identifier cannot override conflicting
   DOIs. DOI normalization removes resolver prefixes and normalizes case;
   arXiv normalization removes URL/prefix and version suffix.
3. Only records with **no strong identifiers** can use title fallback. Require
   exact Unicode/case/whitespace/punctuation-normalized title, full author names,
   year and compatible explicit version. There is no fuzzy/similarity merging;
   search only flags distinct records as `possible_versions` for the user.
4. Merge metadata field by field with stable tie-breaks (longer text, then
   lexical order; stable identifier conflicts use lexical minimum). Fill gaps,
   enrich authors by ID or exact normalized name, union topics/keywords/provenance and keep
   maximum citation/reference counts. Preserve first occurrence for search rank.
   Alias bridges can merge duplicates across operations/pages.
5. Canonical keys remain DOI-first for compatibility with saved user data, then
   `s2:{paperId}` for new DOI-less records. S2 identity is separate from the key.
   Durable enrichment keeps an existing key and group anchor when a DOI becomes
   available later. Detail lookup resolves DOI/arXiv/S2/PMID/PMCID aliases to that
   snapshot, avoiding duplicate rows and orphaned saved state.

Version grouping remains an association, not an identity merge. Existing saved
snapshots are not destructively rewritten; legacy OpenAlex-only/hash-only papers
without interoperable IDs remain readable but cannot fetch a live graph. No
unreliable title search is used to guess their identity. Existing historical
provenance badges may remain visible after enrichment.

Every write path (collection add and import, Library save and resolve) stores
the paper under the key and group of the **stored** snapshot row that
`cache_papers` returns, never the key the caller typed: a DOI added for a
paper already cached as `s2:Y` lands on `s2:Y`, so it cannot create a second
record. Graph nodes and edges follow the same rule.

## Identifier resolution and pending DOIs

Users can add a DOI in any common form, an `s2:` key or semanticscholar.org
link, an arXiv ID or link, `pmid:` or `pmcid:PMC…` (parsing is described in
[Persistence](Persistence.md#paper-identifiers)). A paper already cached under
any of its aliases is used as it is, with no provider call. Otherwise
`registry.resolve_doi` or `registry.resolve_id` returns one of:

| Status | DOI | `s2:`, `arxiv:`, `pmid:`, `pmcid:` |
| --- | --- | --- |
| `found` | Snapshot upserted; the paper is stored under the snapshot's key | Same |
| `not_found` | Semantic Scholar has no record **and** doi.org says the DOI is not registered: 422 `doi_not_found`, nothing saved | Semantic Scholar has no record: 422 `identifier_not_found`, nothing saved |
| `unavailable` | The provider failed or timed out, or the DOI is registered but Semantic Scholar does not describe it (DataCite DOIs from Zenodo or figshare, for example): saved as **pending**, `resolved: false` | 503 with the provider's code (`provider_unavailable` or `provider_rate_limited` with `Retry-After`; `provider_not_configured` or `provider_key_rejected` without one), nothing saved |

Only a DOI can be pending, because only doi.org can confirm that it exists
independently of Semantic Scholar. A failed doi.org check counts as
"unknown", so the DOI stays pending rather than being rejected. A pending
paper is retried with `POST /library/resolve` (the UI's Retry and Fix
identifier actions). One lookup is bounded by `DOI_RESOLVE_TIMEOUT_SECONDS`
(15 s, longer than the 2 s + 4 s rate-limit backoff, so a rate-limited
lookup reports its retry delay instead of timing out).

Imports resolve all of a request's DOIs with `POST /paper/batch` (500 per
call) and send doi.org checks only for the misses,
`IMPORT_RESOLVE_CONCURRENCY` at a time. The other identifiers go through one
more batch call, where a miss is definitive. Both share
`IMPORT_REQUEST_BUDGET_SECONDS` (25 s); whatever is unfinished then is
`unavailable`. Per line, a pending DOI is reported as `unresolved` (saved) and
any other unavailable identifier as `unavailable` (not saved, retry the
line). A batch the provider cannot read at all (`invalid_query`) falls back
to one lookup per identifier.

No provider or doi.org call runs while a request holds the per-user row lock
or a collection lock: the request authorizes and pre-deduplicates, commits,
resolves with no transaction open, then writes in a short transaction that
re-checks edit rights and duplicates.

## Authentication and reliability

`SEMANTIC_SCHOLAR_API_KEY` uses Pydantic `SecretStr` and is sent only in the
`x-api-key` header. `SEMANTIC_SCHOLAR_API_KEY_FILE` follows existing Docker-secret
conventions and takes precedence. Root `.env` is loaded for host development;
`backend/.env` (if present) overrides root values when running there, and process
environment overrides dotenv. Tests reset settings so personal credentials and
backup preferences cannot influence mocked tests. `.env` and `.env.*` are ignored
except the placeholder `.env.example`. Neither flags nor legacy provider keys
activate additional clients.

Every provider failure is a sanitized, coded error (`ProviderError`, an
`ApiError` with `detail={code, message, …}`), without request objects,
credential values or upstream bodies:

| Code | Status | When |
| --- | --- | --- |
| `provider_not_configured` | 503 | `SEMANTIC_SCHOLAR_API_KEY` is empty; no request is sent |
| `provider_key_rejected` | 503 | Semantic Scholar answered 401 or 403 |
| `provider_rate_limited` | 503 + `Retry-After` | 429 after the retries, or a `Retry-After` above 30 s |
| `provider_unavailable` | 503 (+ `Retry-After` after 5xx) | Transport errors, timeouts or 5xx after the retries; collection adds and paper-detail lookups always send a retry hint |
| `provider_bad_response` | 502 | Malformed JSON, invalid or non-advancing pagination, a batch of the wrong shape, incomplete required metadata |
| `invalid_query` | 422 | Any other 400, an unsupported sort, or a bulk query with no words left |
| `search_window_exceeded` | 422 | A relevance page beyond the first 999 results (`offset + limit < 1000`) |

`retry_after` is repeated in the detail. Detail 404 means not found; empty
searches are valid. Graph endpoints wrap these as 503
`related_provider_unavailable` with `reason` = `provider_unavailable`,
`timeout`, `rate_limited` (with `Retry-After`) or `not_configured`. Graph nodes
with null paper IDs are unresolvable and skipped. Real upstream failures
propagate and are never cached as an empty result.

The [official API overview](https://www.semanticscholar.org/product/api) describes
an introductory key limit of 1 request/second. One process-local limiter in
the adapter spaces **every** Semantic Scholar call (searches, single and batch
lookups, import resolution, graph list collection and hydration) by at least
two seconds and serves callers in arrival order, so an interactive request can
wait behind a graph list being collected; the per-request page cap
(`GRAPH_RELATED_PAGES_PER_REQUEST`) bounds that wait. doi.org checks use their
own client and are not paced by it.

A 20-second HTTP timeout and at most two retries (three attempts) cover
transport errors, 429 and transient 5xx. Semantic Scholar sends 429s without
`Retry-After` (verified live on 2026-09-30), so a 429 backs off 2 s, then 4 s,
and a final 429 is reported with a 30-second `Retry-After`. A numeric or
HTTP-date `Retry-After` is honored when present; one above 30 s is surfaced
immediately instead of retried early. Requests never redirect to another host
or provider. Run a **single API worker per key** with this limiter;
multiple workers/replicas sharing a key need shared rate coordination first.

The live API returns a specific 400 (`Requested data for this limit and/or offset
is not available`) when paging beyond available search matches. That exact error
on later pages becomes an empty page; other 400s remain errors.

## Limits and future provider enablement

- Citation and reference lists cannot be sorted upstream and stop at 9,999
  records (`offset + limit < 10000`). Related ranges are therefore ranked over
  a snapshot of at most `GRAPH_RELATED_MAX_RESULTS` (10,000) records in the
  order Semantic Scholar returns them, which it does not specify; for a paper
  with more citers the ranks mean "top of the first 10,000 returned by
  Semantic Scholar", and the UI says so ("first 10,000 of N"). Nothing fails
  above the cap. Collecting a large cold list takes several requests (see
  below).
- Relevance search reaches only the first 999 results (`window_capped`
  tells the UI to suggest refining). The newest and most-cited sorts use bulk
  search, which pages through every match but matches all words and does not
  rank by relevance. The author-name filter applies to the served rows only
  (`filtered_locally: true`) because the API lacks that filter; it can yield a
  short or empty page and does not claim an exhaustive author bibliography.
  `raw_total_count` retains the application's received-page-count semantics;
  the upstream match count is `total_estimate`.
- Citation/reference coverage and optional abstract/PDF metadata depend on S2.
  arXiv IDs remain interoperable, but S2 does not expose the old arXiv adapter's
  version history. This change does not fabricate versions or profiles.
- Re-enable providers only by changing the registry's explicit enablement policy
  and reviewing operation capabilities/identifier translation. Catalog membership
  alone is insufficient. Graph authority is an independent deliberate choice;
  do not pass S2 IDs to other adapters or restore implicit fallbacks.
- Retain the canonical normalization/dedupe layer and old identifier fields for
  interoperability. Define field authority rules before enabling conflicting
  sources; current merging favors populated fields and stable tie-breaks, not an arbitrary live provider.
- Imports and graph hydration already use batch lookups. If several API
  workers or replicas must share one key, add shared (Redis-backed) throttling
  first; the current limiter is per process.

## Related-paper ranges

`POST /graph/related` serves fixed ranges (`GRAPH_RELATED_RANGE_SIZE`, 30) of
a paper's citers or references, ordered by citation count or by recency
(`app/graph/related.py`):

1. The source paper's S2 paperId comes from its snapshot or `s2:` key,
   otherwise from one `GET /paper/{id}` (a 404 is remembered for 24 h).
2. Its citations or references are collected into a Redis snapshot per
   (paperId, direction), `GRAPH_RELATED_CHUNK_SIZE` records per call and at
   most `GRAPH_RELATED_PAGES_PER_REQUEST` calls per request within
   `GRAPH_RELATED_SCAN_BUDGET_SECONDS`. Only compact entries are kept:
   `[s2_id, canonical_key, group_key, date, cited_by]`.
3. When the list ends, Semantic Scholar stops paging or the cap is reached, the
   snapshot is ranked once: duplicates removed, keys and groups replaced by
   the stored ones (one query by `semantic_scholar_id`), and both orders
   sorted with the canonical key as tie-breaker.
4. Until then a range returns no nodes, `scan_incomplete: true`,
   `reason: "ranking"`, the records `scanned` so far and `provider_total` (the
   source's citation or reference count, an estimate). The UI shows "Ranking N
   of about M" and repeats the request automatically up to six times, then
   offers Continue. A list of 10,000 citers needs about ten calls, or three
   requests.
5. Ranges are positions in the eligible list: the first record of each paper
   group, minus the source and the caller's pinned groups
   (`exclude_group_keys`). Only the served papers are hydrated: the database
   first, then one batch lookup. A served paper's stored group that is pinned
   is dropped.

`POST /graph/related/top-up` ("Expand pinned nodes") brings each pinned
source's branch up to the range size over the same ranked lists. A source
still being ranked or rate limited reports `error: "ranking"` or
`"rate_limited"` and is retried later; other sources are unaffected.
Snapshots expire with `CACHE_TTL_CITATIONS` (citers) or
`CACHE_TTL_REFERENCES` (references), and provider errors are never cached.

## Local verification

Apply the migrations before running the modified application. The Semantic
Scholar identity migration is additive; the later `1d2e3f4a5b6c` is an
irreversible key repair, so back up an existing database first (see
[Backups](../Operations/Backups.md#before-deploying-migration-1d2e3f4a5b6c)):

```sh
cd backend
uv run alembic upgrade head
uv run uvicorn app.main:app --reload --port 8000
```

Normal validation (no live provider requests):

```sh
uv run ruff check app tests scripts alembic
uv run ruff format --check app tests scripts alembic
uv run pytest -q
```

Optional live regression (isolated test storage; never the application library):

```sh
RUN_SEMANTIC_SCHOLAR_LIVE=1 uv run pytest -q -m live -s
```

The live test spaces cold requests by five seconds to reduce shared upstream
rate-limit noise. It checks Titans title discovery, its three authors and external IDs,
identical normalization through DOI/arXiv/S2 lookups, search pagination, forced
multi-page references and production-size citations, unique graph results, base-graph edges and live
invalid-key rejection. Mocked tests separately cover missing keys, retries,
malformed data, empty/exhausted pages, disabled providers, API caching, legacy
snapshot hydration, Unicode identity and complementary metadata merging.

Titans reference: DOI `10.48550/arxiv.2501.00663`, arXiv `2501.00663`,
S2 `5e7a795d89910634f001cc3a631023f1dd4e2e23`.

Manually search Titans, open its detail panel, save it, reopen its library and
collection views, load related ranges in both graph directions with both orders, and inspect
any existing saved papers. Search source labels should show Semantic Scholar.
Historical metadata may retain original provider provenance. Operator-maintained
production legal configuration should name the actual active data recipient.

## Validation record (2026-09-26)

| Command/check | Result |
| --- | --- |
| `.venv/bin/ruff check app tests scripts alembic` | Passed |
| `.venv/bin/ruff format --check app tests scripts alembic` | Passed (113 files) |
| `.venv/bin/pytest -q` (SQLite/fake Redis defaults) | 175 passed; 2 PostgreSQL-only and 3 live tests skipped |
| `.venv/bin/pytest -q` with isolated `TEST_DB_URL` and `TEST_REDIS_URL` | 177 passed; 3 opt-in live tests skipped |
| `.venv/bin/python -m scripts.check_migrations` with a disposable migration database | Clean upgrade, previous-head upgrade, encryption round-trip and failure atomicity passed |
| `RUN_SEMANTIC_SCHOLAR_LIVE=1 .venv/bin/pytest -q -m live -s` | 3 passed |
| Node 24, `npm ci --ignore-scripts --no-audit --no-fund`; `npm run lint`; `npm test`; `npm run build` | Passed; 91 frontend tests. Existing Vite large-chunk advisory remains |
| Fresh-process application import | Zero provider instances; all four inactive adapter modules unloaded |
| Git diff and credential checks | Clean whitespace check; actual key absent from tracked/candidate files and validation logs; `.env` ignored and untracked |

The real Titans responses reported 135 references, while traversal returned 130
usable unique reference IDs; count metadata is not a guarantee of resolvable
edges. Three authors, their IDs, DOI and arXiv IDs were checked. Search and three
identifier lookups produced identical normalized metadata, and merged to one
paper. Both graph directions, paginated references, search page 2 and base-graph
edges passed. A deliberately invalid key was rejected as expected.

Initial live runs intermittently exhausted retries on HTTP 429, even below the
nominal key budget. The final independent discovery/graph/authentication tests
passed, but upstream throttling remains a real operational constraint. Normal
tests use mocked transport and do not depend on network availability. No API key
was printed, no production data was modified, and no branch was pushed or PR opened.

### Subsequent Docker/browser QA

The later [Docker and browser QA report](SemanticScholar-QA.md) records the latest
run, a graph error-display fix with three additional frontend tests (94 total),
and recurring upstream 429 failures. That later live run was **not fully green**:
graph/authentication passed, while direct arXiv discovery exhausted retries twice.
See that report for the current operational result and local database isolation.

### Incremental result lists

`GET /papers/search` exposes `has_more`, derived from the provider continuation before filtering or deduplication. The UI appends 20-result pages with “Show more”, merges canonical paper groups across pages, and preserves selected versions. With `sort=relevance` (the default) pages are numbered and continuation stops at the relevance endpoint’s first 999 results (`window_capped`). With `sort=date` or `sort=citations` the response carries an opaque `next_cursor` instead; the client sends it back as `cursor` with the same query and filters, and a cursor from another query, sort or version is 422 `invalid_cursor`. Years outside 1800 to next year, or a start after the end, are 422 `invalid_year_range` before the cache is read. The response also reports `sort`, `total_estimate`, `filtered_locally`, `source` and per-item `possible_versions` (distinct records whose titles, years and authors suggest versions of one work; never merged). Search responses are cached under the `papers-v3` namespace plus `SEARCH_CACHE_VERSION` (`v4`), so a response-shape change does not cool the graph and reference-ID caches.

`GET /library/entries` returns an envelope `{items, total, page, size}` (25 entries per page in the UI, no 100-entry ceiling) with search, reading-state, tag and collection filters and four sort orders; `GET /library/facets` returns the tag and state counts. The default ordering uses creation time plus the stable group key to avoid ambiguous page boundaries when imports share timestamps. These are offset-based pages, not a snapshot: concurrent changes can move boundaries; the UI removes overlaps and refreshes after its own writes.
