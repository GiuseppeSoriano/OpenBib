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

Actual user-facing paths:

- Search page → `GET /papers/search` → Redis fanout cache → registry search →
  provider normalization → round-robin deduplication → SQL metadata snapshots →
  grouped response. The UI currently requests page 1; the public API supports pages.
- Paper details → `GET /papers/{key}` → durable SQL snapshot → DOI lookup on a
  miss. Library, collection and Zotero views use those snapshots; they do not
  perform independent provider requests. Collection DOI import initially stores
  identifiers without doing bulk network hydration.
- Library/collection graph → `build_base_graph` → each seed's reference IDs →
  intersection with saved seeds. Previously OpenAlex IDs and `referenced_works`
  were hardwired throughout this path.
- Graph expansion → `fetch_related` → cached fully mapped citing/referenced
  papers → metadata snapshots and citing-to-cited edges. Previously used
  OpenAlex filters and upstream sorting, with exceptions converted to empty lists.
- Similar-paper recommendations query persisted co-citation edges in SQL. They
  do not use an external recommendations endpoint.
- There is no application route/caller for author profiles, author search,
  embeddings, full-text download, or provider batch hydration. Author names and
  IDs come with paper metadata. Old adapters retain their unused methods.
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
| Title/free-text discovery | `GET /paper/search` | Plain query; shared paper field set below | `offset=(page-1)*size`, size 1–100, first 1,000 results. API relevance order retained. Year, venue, publication type and public-PDF filters passed upstream. |
| Detail/cache miss; legacy graph resolution | `GET /paper/{id}` | S2 paper ID, `DOI:…`, `ARXIV:…`, `PMID:…`, `PMCID:…` | Single response; 404 means absent. DOI URLs/case and arXiv version suffixes normalized. `s2:` is OpenBib's canonical prefix and is removed before transmission. |
| Graph expansion: citing papers | `GET /paper/{id}/citations` | Shared paper fields from nested `citingPaper` | Follow `next` offsets; up to 1,000 rows/request. Merge duplicates before local citation-count/date sorting and UI limit. |
| Graph expansion: referenced papers | `GET /paper/{id}/references` | Shared paper fields from nested `citedPaper` | Same traversal and sorting as citations. |
| Base graph edges among saved papers | `GET /paper/{id}/references` | Only `paperId` | Follow all pages; unique IDs intersect saved seeds' S2 IDs. |

The API also accepts CorpusId, MAG, ACL and certain URL identifiers, but no
additional application workflow was introduced for them. No batch, author,
recommendations, bulk search or dataset endpoints were needed.

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
   year and compatible explicit version. There is no fuzzy/similarity matching.
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

## Authentication and reliability

`SEMANTIC_SCHOLAR_API_KEY` uses Pydantic `SecretStr` and is sent only in the
`x-api-key` header. `SEMANTIC_SCHOLAR_API_KEY_FILE` follows existing Docker-secret
conventions and takes precedence. Root `.env` is loaded for host development;
`backend/.env` (if present) overrides root values when running there, and process
environment overrides dotenv. Tests reset settings so personal credentials and
backup preferences cannot influence mocked tests. `.env` and `.env.*` are ignored
except the placeholder `.env.example`. Neither flags nor legacy provider keys
activate additional clients.

Missing/rejected keys produce useful sanitized 503 errors, without request
objects, credential values or upstream bodies. Detail 404 means not found;
empty searches are valid. Other invalid requests return 422; malformed JSON,
invalid pagination and incomplete required paper metadata return 502. Graph
nodes with null paper IDs are unresolvable and skipped. Real upstream failures
propagate rather than being cached as an empty result.

The [official API overview](https://www.semanticscholar.org/product/api) describes
an introductory key limit of 1 request/second. A shared process-local limiter
spaces requests by at least two seconds conservatively. A 20-second HTTP timeout
and at most two retries cover transport errors, 429 and transient 5xx. Backoff is
exponential (429 starts at five seconds), honors numeric/HTTP-date `Retry-After`,
and surfaces long delays instead of retrying early. Requests never redirect to
another host or provider. Run a **single API worker per key** with this limiter;
multiple workers/replicas sharing a key need shared rate coordination first.

The live API returns a specific 400 (`Requested data for this limit and/or offset
is not available`) when paging beyond available search matches. That exact error
on later pages becomes an empty page; other 400s remain errors.

## Limits and future provider enablement

- Graph endpoints cannot sort upstream. To keep the UI's ranking meaningful,
  traverse all pages, deduplicate, then sort with canonical key as tie-breaker.
  Traversals beyond 10,000 upstream rows fail explicitly rather than silently
  presenting a partial graph. Large cold graphs can take several seconds.
- Search supports 1,000 ranked results, not bulk export. The author-name filter
  applies to the returned ranked page because the API lacks that filter; it can
  yield a short/empty page. It does not claim an exhaustive author bibliography.
  `raw_total_count` retains the application's received-page-count semantics,
  rather than becoming an upstream global hit count.
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
- If high concurrency or bulk imports are introduced, add shared throttling,
  cache-write concurrency controls and batch hydration based on measured need.

## Local verification

Apply the additive migration before running the modified application:

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
collection views, expand both graph directions with both sort modes, and inspect
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

`GET /papers/search` exposes `has_more`, derived from the provider continuation before filtering or deduplication. The UI appends 20-result pages with “Show more”, merges canonical paper groups across pages, and preserves selected versions. Continuation stops at the relevance endpoint’s first 1,000 results. The search cache namespace is `papers-v3` to exclude older payloads without continuation metadata.

The personal library appends 25-entry pages, without a 100-entry UI ceiling. Its ordering uses creation time plus the stable group key to avoid ambiguous page boundaries when imports share timestamps. An additional empty page can be requested when the total is an exact multiple of 25. These are offset-based pages, not a snapshot: concurrent changes can move boundaries; the UI removes overlaps and refreshes after its own writes.
