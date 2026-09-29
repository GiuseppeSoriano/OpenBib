# API Integration Specification

> Detailed specification for integrating the four external providers: **OpenAlex**, **arXiv**, **Crossref**, and **Europe PMC**.

---

## 1. Provider Abstraction

All providers implement a common interface. The system interacts with providers exclusively through this abstraction.

### 1.1 Abstract interface

```python
class BaseProvider(ABC):
    """Abstract base for all external paper data providers."""

    name: str                          # e.g. "openalex", "arxiv"
    capabilities: set[ProviderCapability]

    @abstractmethod
    async def lookup_by_doi(self, doi: str) -> PaperMetadata | None: ...

    @abstractmethod
    async def lookup_by_id(self, provider_id: str) -> PaperMetadata | None: ...

    @abstractmethod
    async def search(self, query: str, filters: SearchFilters, page: int, size: int) -> SearchResult: ...

    @abstractmethod
    async def get_references(self, paper_id: str) -> list[PaperReference]: ...

    @abstractmethod
    async def get_citations(self, paper_id: str) -> list[PaperReference]: ...

    @abstractmethod
    async def get_author(self, author_id: str) -> AuthorMetadata | None: ...
```

### 1.2 Capability flags

```python
class ProviderCapability(Enum):
    LOOKUP_DOI = "lookup_doi"
    LOOKUP_ID = "lookup_id"
    SEARCH = "search"
    REFERENCES = "references"
    CITATIONS = "citations"
    AUTHOR_PROFILE = "author_profile"
    VERSION_TRACKING = "version_tracking"
    FULL_TEXT_LINK = "full_text_link"
```

### 1.3 Common data models

```python
@dataclass
class PaperMetadata:
    canonical_key: str                # doi:{normalized} or hash-based
    title: str
    authors: list[Author]
    abstract: str | None
    publication_date: date | None
    doi: str | None
    arxiv_id: str | None
    pmid: str | None
    pmcid: str | None
    openalex_id: str | None
    venue: str | None
    volume: str | None
    issue: str | None
    pages: str | None
    paper_type: str | None            # article, preprint, review, etc.
    topics: list[str]
    keywords: list[str]
    open_access: bool | None
    pdf_url: str | None
    abstract_url: str | None
    cited_by_count: int | None
    reference_count: int | None
    version: str | None               # arXiv version (v1, v2, ...)
    provider_source: str              # which provider returned this data
    raw_response: dict | None         # original API response for debugging

@dataclass
class Author:
    name: str
    family_name: str | None
    given_name: str | None
    openalex_id: str | None
    orcid: str | None
    affiliations: list[str]

@dataclass
class PaperReference:
    canonical_key: str
    title: str | None
    doi: str | None
    relation_type: str                # "references" or "cited_by"

@dataclass
class SearchResult:
    papers: list[PaperMetadata]
    total_count: int
    page: int
    page_size: int
    provider: str

@dataclass
class SearchFilters:
    year_from: int | None = None
    year_to: int | None = None
    author: str | None = None
    venue: str | None = None
    open_access_only: bool = False
    paper_type: str | None = None
```

---

## 2. OpenAlex

### 2.1 Overview

| Property | Value |
|----------|-------|
| Base URL | `https://api.openalex.org` |
| Format | REST / JSON |
| Auth | Free API key (`api_key` param) or polite pool (`mailto` param) |
| Rate limit | ~10 req/s (unauthenticated), ~100K req/day (with key) |
| Trust role | **Primary source** — richest metadata, covers all disciplines |

### 2.2 Capabilities

`LOOKUP_DOI`, `LOOKUP_ID`, `SEARCH`, `REFERENCES`, `CITATIONS`, `AUTHOR_PROFILE`, `FULL_TEXT_LINK`.

### 2.3 Endpoints used

| Operation | Endpoint | Parameters |
|-----------|----------|------------|
| Lookup by DOI | `GET /works/doi:{doi}` | `mailto`, `api_key` |
| Lookup by OpenAlex ID | `GET /works/{openalex_id}` | `mailto`, `api_key` |
| Search | `GET /works` | `search`, `filter`, `sort`, `page`, `per_page`, `mailto` |
| Get references | `GET /works/{id}` | Extract `referenced_works` field |
| Get citations | `GET /works?filter=cites:{id}` | `page`, `per_page` |
| Author lookup | `GET /authors/{id}` | `mailto` |

### 2.4 Search filters mapping

| App filter | OpenAlex filter |
|------------|----------------|
| `year_from` / `year_to` | `filter=publication_year:>{year_from},publication_year:<{year_to}` |
| `author` | `filter=authorships.author.display_name.search:{name}` |
| `venue` | `filter=primary_location.source.display_name.search:{venue}` |
| `open_access_only` | `filter=open_access.is_oa:true` |
| `paper_type` | `filter=type:{type}` |

### 2.5 Response mapping

| OpenAlex field | PaperMetadata field |
|----------------|---------------------|
| `id` | `openalex_id` |
| `doi` | `doi` (strip `https://doi.org/` prefix) |
| `title` | `title` |
| `authorships[].author.display_name` | `authors[].name` |
| `authorships[].author.id` | `authors[].openalex_id` |
| `authorships[].author.orcid` | `authors[].orcid` |
| `authorships[].institutions[].display_name` | `authors[].affiliations` |
| `abstract_inverted_index` | `abstract` (reconstruct from inverted index) |
| `publication_date` | `publication_date` |
| `primary_location.source.display_name` | `venue` |
| `biblio.volume` | `volume` |
| `biblio.issue` | `issue` |
| `biblio.first_page`–`last_page` | `pages` |
| `type` | `paper_type` |
| `topics[].display_name` | `topics` |
| `keywords[].keyword` | `keywords` |
| `open_access.is_oa` | `open_access` |
| `best_oa_location.pdf_url` (else `primary_location.pdf_url` when that location is OA) | `pdf_url` |
| `best_oa_location.landing_page_url` (else `open_access.oa_url`), when it is not the PDF | `abstract_url` |
| `cited_by_count` | `cited_by_count` |
| `referenced_works` | list of OpenAlex IDs → resolve to canonical keys |

### 2.6 Implementation notes

- **Abstract reconstruction**: OpenAlex returns `abstract_inverted_index` (word → positions map). Reconstruct by sorting positions and joining words.
- **Pagination**: Use `page` and `per_page` (max 200 per page). For cursor-based pagination on large result sets, use `cursor=*` and follow `next_cursor`.
- **Polite pool**: Always include `mailto` parameter with a valid email for better rate limits.

---

## 3. arXiv

### 3.1 Overview

| Property | Value |
|----------|-------|
| Base URL | `http://export.arxiv.org/api` |
| Format | Atom 1.0 XML |
| Auth | None required |
| Rate limit | **3-second delay between calls** (enforced by client) |
| Trust role | **Authoritative for preprints** — version tracking, category info |

### 3.2 Capabilities

`LOOKUP_ID`, `SEARCH`, `VERSION_TRACKING`, `FULL_TEXT_LINK`.

Does **not** provide: reference lists, citation lists, author profiles.

### 3.3 Endpoints used

| Operation | Endpoint | Parameters |
|-----------|----------|------------|
| Lookup by arXiv ID | `GET /query?id_list={arxiv_id}` | |
| Search | `GET /query` | `search_query`, `start`, `max_results`, `sortBy`, `sortOrder` |

### 3.4 Query syntax

Search queries use prefix operators combined with boolean logic:

| Prefix | Field | Example |
|--------|-------|---------|
| `ti:` | Title | `ti:attention+mechanism` |
| `au:` | Author | `au:vaswani` |
| `abs:` | Abstract | `abs:transformer` |
| `cat:` | Category | `cat:cs.CL` |
| `all:` | All fields | `all:deep+learning` |

Operators: `AND`, `OR`, `ANDNOT`. Grouped with parentheses.

Example: `ti:attention AND au:vaswani AND cat:cs.CL`

### 3.5 Response mapping

| Atom field | PaperMetadata field |
|------------|---------------------|
| `<entry><id>` | `arxiv_id` (extract ID from URL) |
| `<entry><title>` | `title` (strip whitespace) |
| `<entry><author><name>` | `authors[].name` |
| `<entry><author><arxiv:affiliation>` | `authors[].affiliations` |
| `<entry><summary>` | `abstract` |
| `<entry><published>` | `publication_date` |
| `<entry><updated>` | used for version detection |
| `<entry><arxiv:doi>` | `doi` |
| `<entry><arxiv:journal_ref>` | `venue` |
| `<entry><arxiv:primary_category>` | `topics[0]` |
| `<entry><category>` | `topics` |
| `<entry><link rel="alternate">` | `abstract_url` |
| `<entry><link title="pdf">` | `pdf_url` |

### 3.6 Version handling

- arXiv IDs have the form `2301.12345` (no version) or `2301.12345v2` (specific version).
- Without version suffix, the API returns the **latest** version.
- The `<updated>` field indicates when the latest version was submitted.
- To get all versions, query the ID without suffix and inspect the returned version.
- The system stores the latest version by default and allows users to view version history.

### 3.7 Implementation notes

- **Rate limiting**: The client must enforce a minimum 3-second delay between consecutive calls to arXiv. Use an async semaphore or token bucket.
- **XML parsing**: Use `xml.etree.ElementTree` or `lxml` to parse Atom responses. Define namespace map for `arxiv:` namespace.
- **Pagination**: `start` (0-based offset) + `max_results` (max 2000). Total results in `<opensearch:totalResults>`. Max reachable: 30,000.
- **DOI availability**: Not all arXiv papers have DOIs. When a DOI is present, use it for canonical key; otherwise fall back to hash-based key.

---

## 4. Crossref

### 4.1 Overview

| Property | Value |
|----------|-------|
| Base URL | `https://api.crossref.org` |
| Format | REST / JSON |
| Auth | Polite pool via `mailto` query parameter |
| Rate limit | ~50 req/s (polite), ~10 req/s (anonymous) |
| Trust role | **Authoritative for DOI resolution** — journal metadata, licensing |

### 4.2 Capabilities

`LOOKUP_DOI`, `SEARCH`, `REFERENCES`.

Does **not** provide: citations (only reference lists), author profiles, version tracking.

### 4.3 Endpoints used

| Operation | Endpoint | Parameters |
|-----------|----------|------------|
| Lookup by DOI | `GET /works/{doi}` | `mailto` |
| Search | `GET /works` | `query`, `query.title`, `query.author`, `filter`, `sort`, `order`, `offset`, `rows`, `mailto` |
| Get references | `GET /works/{doi}` | Extract `reference` field from response |

### 4.4 Search filters mapping

| App filter | Crossref filter/param |
|------------|----------------------|
| `year_from` / `year_to` | `filter=from-pub-date:{year_from},until-pub-date:{year_to}` |
| `author` | `query.author={name}` |
| `venue` | `query.container-title={venue}` |
| `paper_type` | `filter=type:{type}` |

### 4.5 Response mapping

| Crossref field | PaperMetadata field |
|----------------|---------------------|
| `DOI` | `doi` |
| `title[0]` | `title` |
| `author[].given` + `author[].family` | `authors[].name`, `given_name`, `family_name` |
| `author[].ORCID` | `authors[].orcid` |
| `author[].affiliation[].name` | `authors[].affiliations` |
| `abstract` | `abstract` (JATS XML, normalized to plain-text paragraphs) |
| `published-print`, then `published-online`, `posted`, `issued` (`date-parts`) | `publication_date` |
| `container-title[0]` (posted content: else `institution[0].name`, else `group-title`) | `venue` |
| DOI suffix `.vN` / `/vN` (posted content and preprints only) | `version` |
| `volume` | `volume` |
| `issue` | `issue` |
| `page` | `pages` |
| `type` | `paper_type` |
| `subject` | `topics` |
| `is-referenced-by-count` | `cited_by_count` |
| `references-count` | `reference_count` |
| `link[].URL` (`application/pdf`, not `intended-application: text-mining`, CC `license` only) | `pdf_url` |
| `reference[]` | list of references (may have DOI, title, author) |

### 4.6 Implementation notes

- **Polite pool**: Always include `mailto` parameter with the configured email. This provides better rate limits and priority.
- **Abstract formatting**: Crossref abstracts may contain JATS XML tags (`<jats:p>`, `<jats:italic>`, etc.). Every provider's titles and abstracts go through `app/common/text.py`: known tags are unwrapped, section titles become a `Heading: ` prefix, paragraphs are separated by a blank line, entities are decoded, and text such as `p < 0.05` is kept. Keys are still computed from the raw provider title.
- **References**: The `reference` field contains a list of references, but many entries have incomplete metadata (often just `unstructured` text). When a DOI is present in a reference, use it for resolution; otherwise skip.
- **Date parsing**: Crossref dates are arrays `[[year, month, day]]`. Month and day may be missing.
- **Pagination**: Use `offset` and `rows` (max 1000 per page).

---

## 5. Europe PMC

### 5.1 Overview

| Property | Value |
|----------|-------|
| Base URL | `https://www.ebi.ac.uk/europepmc/webservices/rest` |
| Format | REST / JSON |
| Auth | None required (optional `email` for polite access) |
| Rate limit | Reasonable for non-commercial use (no published hard limit) |
| Trust role | **Authoritative for biomedical literature** — PMID/PMCID resolution, MeSH terms |

### 5.2 Capabilities

`LOOKUP_DOI`, `LOOKUP_ID`, `SEARCH`, `REFERENCES`, `CITATIONS`, `FULL_TEXT_LINK`.

### 5.3 Endpoints used

| Operation | Endpoint | Parameters |
|-----------|----------|------------|
| Search / lookup | `GET /search` | `query`, `format=json`, `pageSize`, `cursorMark`, `resultType=core` |
| Get references | `GET /{source}/{id}/references` | `format=json`, `pageSize`, `page` |
| Get citations | `GET /{source}/{id}/citations` | `format=json`, `pageSize`, `page` |

Where `{source}` is `MED` (PubMed), `PMC`, `PAT`, etc. and `{id}` is the PMID or PMCID.

### 5.4 Search query syntax

Europe PMC uses a Lucene-like query syntax:

| App filter | Europe PMC query |
|------------|------------------|
| Title search | `TITLE:"attention mechanism"` |
| Author search | `AUTH:"Smith J"` |
| DOI lookup | `DOI:"10.1234/example"` |
| PMID lookup | `EXT_ID:12345678 SRC:MED` |
| Year range | `PUB_YEAR:[2020 TO 2024]` |
| Open access | `OPEN_ACCESS:y` |

### 5.5 Response mapping

| Europe PMC field | PaperMetadata field |
|------------------|---------------------|
| `doi` | `doi` |
| `pmid` | `pmid` |
| `pmcid` | `pmcid` |
| `title` | `title` |
| `authorString` | parse into `authors` (split on ", ") |
| `authorList.author[]` | `authors` (if `resultType=core`) |
| `abstractText` | `abstract` |
| `firstPublicationDate` | `publication_date` |
| `journalTitle` | `venue` |
| `journalVolume` | `volume` |
| `issue` | `issue` |
| `pageInfo` | `pages` |
| `pubType` | `paper_type` |
| `meshHeadingList.meshHeading[].descriptorName` | `topics` |
| `keywordList.keyword[]` | `keywords` |
| `isOpenAccess` | `open_access` |
| `fullTextUrlList.fullTextUrl[]` | `pdf_url` (OA PDF), `abstract_url` (HTML with `availabilityCode` `OA` or `F` only) |
| `citedByCount` | `cited_by_count` |

### 5.6 Implementation notes

- **Result types**: Use `resultType=core` for full metadata (including abstract, author details). Default `resultType=lite` omits abstract.
- **Author parsing**: The `authorString` field is a comma-separated string. For richer data, use `authorList` from core results.
- **PMID/PMCID resolution**: Europe PMC is the authority for mapping between PMID, PMCID, and DOI. The `search` endpoint with `EXT_ID:{pmid} SRC:MED` resolves PMID to full metadata.
- **Pagination**: Use `cursorMark=*` for cursor-based pagination (recommended for large result sets). `pageSize` max is 1000.
- **References/citations**: The `/references` and `/citations` endpoints return related papers with basic metadata. Some entries may lack DOIs — use title + author matching as fallback for canonical key generation.

---

## 6. Provider Orchestration

### 6.1 Fallback chain

When resolving a paper, the system tries providers in order until one returns a result:

```
1. OpenAlex    (broadest coverage, richest metadata)
2. Crossref    (DOI authority, journal metadata)
3. arXiv       (preprints, versions)
4. Europe PMC  (biomedical, PMID/PMCID)
```

The fallback chain applies per operation:

| Operation | Fallback order |
|-----------|---------------|
| Lookup by DOI | OpenAlex → Crossref → Europe PMC |
| Lookup by arXiv ID | arXiv → OpenAlex |
| Lookup by PMID | Europe PMC → OpenAlex |
| Search | User-selected provider (default: OpenAlex) |
| References | OpenAlex → Crossref → Europe PMC |
| Citations | OpenAlex → Europe PMC |
| Author profile | OpenAlex (sole provider for MVP) |

### 6.2 Multi-provider enrichment

After the primary provider returns a result, the system may enrich it from other providers:

1. **DOI cross-check**: If the result has a DOI, verify/supplement with Crossref (authoritative DOI source).
2. **arXiv version**: If the result has an arXiv ID, fetch version info from arXiv.
3. **Biomedical IDs**: If the result has a PMID or PMCID, fetch from Europe PMC for cross-linked IDs.

Enrichment is **optional and async** — it does not block the initial response. Enriched data is merged into the cached metadata.

### 6.3 Reconciliation rules

When providers return conflicting data for the same paper:

| Field | Preferred source | Rationale |
|-------|-----------------|-----------|
| DOI | Crossref | DOI registration authority |
| Title | OpenAlex | Best normalization |
| Authors | OpenAlex | Richest author data (IDs, affiliations) |
| Abstract | OpenAlex > Europe PMC > Crossref | Crossref may have JATS XML artifacts |
| Publication date | Crossref > OpenAlex | Crossref has publisher-provided dates |
| Venue | Crossref | Journal metadata authority |
| References list | OpenAlex > Crossref | OpenAlex has richer linked data |
| Citations list | OpenAlex > Europe PMC | Better coverage |
| Version info | arXiv | Sole authority |
| PMID / PMCID | Europe PMC | Sole authority |
| Open access status | OpenAlex | Most accurate OA detection |
| Topics / keywords | OpenAlex (topics) + Europe PMC (MeSH) | Complementary taxonomies |

### 6.4 Error handling per provider

| Scenario | Behavior |
|----------|----------|
| Provider returns HTTP 404 | Paper not found in this provider — try next in chain |
| Provider returns HTTP 429 | Rate limited — back off and retry (max 2 retries with exponential backoff) |
| Provider returns HTTP 5xx | Server error — try next provider, log warning |
| Provider times out (> 10s) | Skip provider, try next, log warning |
| Provider returns malformed data | Skip provider, log error with response body sample |
| All providers fail | Return error to user with message: "Unable to find paper. Please verify the identifier and try again." |

---

## 7. Canonical Key Construction

The canonical key uniquely identifies a paper across providers.

### 7.1 Algorithm

```python
def build_canonical_key(doi: str | None, title: str | None, authors: list[str] | None, year: int | None) -> str:
    if doi:
        normalized_doi = doi.strip().lower()
        normalized_doi = normalized_doi.removeprefix("https://doi.org/")
        normalized_doi = normalized_doi.removeprefix("http://doi.org/")
        return f"doi:{normalized_doi}"

    # Fallback: hash-based key
    parts = []
    if title:
        normalized_title = re.sub(r'[^a-z0-9 ]', '', title.lower()).strip()
        parts.append(normalized_title)
    if authors:
        sorted_names = sorted(a.split()[-1].lower() for a in authors if a.strip())
        parts.append(",".join(sorted_names))
    if year:
        parts.append(str(year))

    combined = "|".join(parts)
    hash_val = hashlib.sha256(combined.encode()).hexdigest()[:16]
    return f"hash:{hash_val}"
```

### 7.2 Key properties

- **DOI-based keys** are deterministic and globally unique.
- **Hash-based keys** are best-effort — collisions are possible but unlikely with title + authors + year.
- **Normalization**: DOIs lowercased and stripped of URL prefix. Titles stripped of special characters. Author last names sorted alphabetically.
- **Stability**: Once a paper is assigned a canonical key, it does not change — even if a DOI is later discovered. The DOI is added as an alias.

### 7.3 Key deduplication

When adding a paper to a collection:
1. Compute canonical key from available identifiers.
2. Check if the key (or any alias) already exists in the collection.
3. If match found → return existing entry (no duplicate).
4. If no match → check by fuzzy title match (Levenshtein distance < threshold) within the collection.
5. If fuzzy match found → prompt user to confirm whether it's the same paper.
6. If no match → insert new entry.

---

## 8. Rate Limiting Strategy

### 8.1 Client-side rate limiting

Each provider client implements its own rate limiter to respect upstream limits:

| Provider | Strategy | Parameters |
|----------|----------|------------|
| OpenAlex | Token bucket | 10 req/s (no key) or as per plan |
| arXiv | Fixed delay | 3 seconds between calls |
| Crossref | Token bucket | 50 req/s (polite pool) |
| Europe PMC | Token bucket | 10 req/s (conservative default) |

### 8.2 Implementation

```python
class ProviderRateLimiter:
    """Async rate limiter using asyncio.Semaphore and sleep."""

    def __init__(self, calls_per_second: float = 10, min_delay: float = 0):
        self.semaphore = asyncio.Semaphore(1)
        self.min_interval = max(1.0 / calls_per_second, min_delay)
        self.last_call = 0.0

    async def acquire(self):
        async with self.semaphore:
            now = time.monotonic()
            wait = self.min_interval - (now - self.last_call)
            if wait > 0:
                await asyncio.sleep(wait)
            self.last_call = time.monotonic()
```

---

## 9. Testing Strategy for Providers

### 9.1 Unit tests

- Mock all HTTP calls using `respx` (for httpx) or `aioresponses`.
- Test each provider's response mapping with sample JSON/XML fixtures.
- Test canonical key generation with edge cases (missing DOI, Unicode titles, single-author papers).
- Test fallback chain behavior (first provider fails → second succeeds).

### 9.2 Integration tests

- Test against real provider APIs with known papers (e.g., "Attention Is All You Need" — DOI `10.48550/arXiv.1706.03762`).
- Run in CI with a `--integration` flag (skipped by default to avoid rate limits).
- Validate that response mapping produces correct `PaperMetadata` for known papers.

### 9.3 Test fixtures

Maintain a `tests/fixtures/` directory with sample API responses:

```
tests/fixtures/
├── openalex/
│   ├── work_by_doi.json
│   ├── search_results.json
│   └── author.json
├── arxiv/
│   ├── single_paper.xml
│   └── search_results.xml
├── crossref/
│   ├── work_by_doi.json
│   └── search_results.json
└── europepmc/
    ├── search_result.json
    ├── references.json
    └── citations.json
```
