# System Architecture

> Architecture for the **OpenBib MVP** — a prototype targeting < 100 concurrent users,
> designed for vertical-slice development and future horizontal scaling.
>
> The runtime uses Semantic Scholar as its only metadata provider; the OpenAlex,
> arXiv, Crossref and Europe PMC adapters are inactive. See
> [Semantic Scholar integration](../Architecture/SemanticScholar.md) for the
> endpoints, limits and error codes.

---

## 1. High-Level Architecture

```
┌──────────────────────────────────────────────────┐
│                   Client Layer                    │
│  React 18 SPA · TypeScript · Vite · Cytoscape.js │
└──────────────┬───────────────────────────────────┘
               │ HTTPS / REST JSON
┌──────────────▼───────────────────────────────────┐
│                   API Layer                       │
│        FastAPI · Pydantic v2 · JWT Auth           │
├───────────────────────────────────────────────────┤
│                 Service Layer                     │
│   Business logic · Provider orchestration ·       │
│   Deduplication · Recommendations                 │
├──────────┬──────────────────┬─────────────────────┤
│ Repo Layer│   Cache Layer   │   Provider Layer    │
│ SQLAlchemy│     Redis       │ Semantic Scholar    │
│ (async)   │   (TTL-based)   │ (others inactive)   │
├──────────▼──────────────────┤                     │
│     PostgreSQL 16+          │   External APIs     │
└─────────────────────────────┴─────────────────────┘
```

### Request flow summary

1. **Client** sends an authenticated HTTP request to the **API Layer**.
2. **Auth middleware** validates the JWT, extracts user identity, and attaches it to the request context.
3. **Router** dispatches to the appropriate service method.
4. **Service** coordinates the operation — reads/writes via the **Repository Layer**, queries the **Cache Layer**, and if needed calls the **Provider Layer**.
5. **Provider Layer** checks **Redis** first (cache-through); on miss it calls the external API, caches the response, and returns.
6. The response is serialized via **Pydantic** and returned to the client.

---

## 2. Technology Stack

| Layer | Technology | Version | Purpose |
|-------|-----------|---------|---------|
| **Language** | Python | 3.12+ | Backend runtime |
| **Web framework** | FastAPI | 0.110+ | REST API, OpenAPI generation |
| **Validation** | Pydantic | v2 | Request/response schemas, settings |
| **ORM** | SQLAlchemy | 2.0 (async) | Database access |
| **Migrations** | Alembic | latest | Schema versioning |
| **Database** | PostgreSQL | 16+ | Persistent storage |
| **Cache** | Redis | 7+ | API response caching, rate-limit state |
| **Auth** | PyJWT + Argon2-cffi | — | Token generation, password hashing |
| **HTTP client** | httpx | — | Async external API calls |
| **Frontend** | React | 18+ | UI framework |
| **Frontend language** | TypeScript | 5+ | Type-safe frontend code |
| **Build tool** | Vite | 5+ | Frontend bundling, HMR |
| **Routing** | React Router | v6 | Client-side navigation |
| **Server state** | TanStack Query | v5 | Data fetching, caching, sync |
| **Graph visualization** | Cytoscape.js | 3.x | Citation/reference graph rendering |
| **Testing (backend)** | pytest + pytest-asyncio | — | Unit / integration tests |
| **Testing (frontend)** | Vitest + React Testing Library | — | Component / integration tests |
| **Linting** | Ruff (Python), ESLint (TS) | — | Code quality |
| **Formatting** | Ruff (Python), Prettier (TS) | — | Consistent style |
| **Containers** | Docker + Docker Compose | — | Development and deployment |

---

## 3. Backend Architecture

### 3.1 Project layout

```
backend/
├── alembic/                   # Database migrations
│   └── versions/
├── app/
│   ├── __init__.py
│   ├── main.py                # FastAPI app factory, middleware, lifespan
│   ├── config.py              # Pydantic Settings (env-based)
│   ├── dependencies.py        # FastAPI dependency injection (DB session, current user, etc.)
│   ├── auth/
│   │   ├── router.py          # Login/sessions; OTP registration in registration.py
│   │   ├── service.py         # password hash/verify, token create/validate
│   │   └── schemas.py
│   ├── users/
│   │   ├── router.py          # GET/PATCH /users/me, DELETE /users/me
│   │   ├── service.py
│   │   ├── models.py          # SQLAlchemy User model
│   │   └── schemas.py
│   ├── collections/
│   │   ├── router.py          # CRUD /collections, membership, paper management
│   │   ├── service.py
│   │   ├── models.py          # Collection, CollectionMember, CollectionPaper
│   │   └── schemas.py
│   ├── papers/
│   │   ├── router.py          # GET /papers/{key}, search, states, tags, notes
│   │   ├── service.py         # Orchestrates provider calls, dedup, caching
│   │   ├── models.py          # UserPaperState, UserPaperTag, Note
│   │   └── schemas.py
│   ├── graph/
│   │   ├── router.py          # Base graphs, POST /graph/related and /graph/related/top-up
│   │   ├── service.py         # Base graphs: seeds and the citation edges among them
│   │   ├── related.py         # Ranked related-paper snapshots, ranges and top-ups
│   │   ├── models.py          # PaperGraphEdge
│   │   └── schemas.py
│   ├── recommendations/
│   │   ├── router.py          # GET /recommendations (similar, trending, serendipity)
│   │   └── service.py
│   ├── providers/
│   │   ├── base.py            # Abstract BaseProvider interface
│   │   ├── openalex.py
│   │   ├── arxiv.py
│   │   ├── crossref.py
│   │   ├── europepmc.py
│   │   ├── registry.py        # Provider registry, fallback chain
│   │   └── cache.py           # Redis cache-through wrapper
│   └── common/
│       ├── canonical.py       # Canonical key generation
│       ├── pagination.py      # Pagination helpers
│       └── exceptions.py      # Custom exception types
├── tests/
│   ├── conftest.py            # Fixtures (async DB session, test client, mock providers)
│   ├── test_auth.py
│   ├── test_collections.py
│   ├── test_papers.py
│   ├── test_graph.py
│   └── test_providers.py
├── pyproject.toml
├── Dockerfile
└── alembic.ini
```

### 3.2 Route structure

All routes are prefixed with `/api/v1`.

| Module | Prefix | Key endpoints |
|--------|--------|---------------|
| Auth | `/auth` | `POST /register`, `POST /login`, `POST /refresh`, `POST /logout` |
| Users | `/users` | `GET /me`, `PATCH /me`, `DELETE /me` |
| Collections | `/collections` | `GET /`, `POST /`, `GET /{id}`, `PATCH /{id}`, `DELETE /{id}`, `GET /{id}/papers`, `POST /{id}/papers`, `DELETE /{id}/papers/{key}`, `POST /{id}/import/dois`, `POST /{id}/import/keys`, `POST /{id}/members`, `DELETE /{id}/members/{user_id}`, read-link routes |
| Papers | `/papers` | `GET /{key}`, `GET /search?q=&year_from=&year_to=&open_access_only=&sort=relevance\|date\|citations&page=&cursor=&size=`, `PUT /{key}/state`, `POST /{key}/tags`, `DELETE /{key}/tags/{tag}` |
| Library | `/library` | `GET /entries?q=&state=&tag=&collection_id=&sort=&page=&size=` (envelope `{items, total, page, size}`), `GET /facets`, `GET /keys`, `POST /entries`, `GET\|PATCH\|DELETE /entries/{group}` (`DELETE ?detach=`), `POST /entries/{group}/versions`, `DELETE /entries/{group}/versions/{key}`, `POST /resolve` |
| Notes | `/notes` | `POST /`, `GET /?target_type=...&target_key=...`, `PATCH /{id}`, `DELETE /{id}` |
| Graph | `/graph` | `GET /paper/{key}`, `GET /collection/{id}`, `GET /library` (base graphs: seeds and the edges among them), `POST /related` (one ranked range of a paper's citers or references), `POST /related/top-up` (expand pinned nodes). `POST /expand` was removed |
| Recommendations | `/recommendations` | `GET /similar/{key}`, `GET /trending`, `GET /serendipity` |
| Import/Export | `/import` | `POST /bibtex`, `POST /doi-list` |
| Export | `/export` | `GET /bibtex?collection_id=...`, `GET /json` (full backup) |
| Health | `/health` | `GET /` |

### 3.3 Middleware stack

1. **CORS** — restricted origins.
2. **Request-ID** — generates/propagates `X-Request-ID`.
3. **Logging** — structured JSON log per request (method, path, status, duration).
4. **Auth** — JWT validation; populates `request.state.user`.
5. **Rate-limiter** — token-bucket per IP via Redis.

### 3.4 Dependency injection

FastAPI's `Depends()` system provides:

- `get_db_session` → async SQLAlchemy session (scoped per request).
- `get_current_user` → validated user from JWT (raises 401 if invalid).
- `get_optional_user` → user or `None` (for endpoints accessible by both authenticated and anonymous users).
- `get_provider_registry` → singleton provider registry with cache layer.
- `get_redis` → Redis connection from pool.

---

## 4. Frontend Architecture

### 4.1 Project layout

```
frontend/
├── public/
├── src/
│   ├── main.tsx               # Entry point, providers (QueryClient, Router, Auth)
│   ├── api/
│   │   └── client.ts          # Axios/fetch wrapper with JWT interceptor
│   ├── auth/
│   │   ├── AuthProvider.tsx    # React Context for auth state
│   │   ├── useAuth.ts
│   │   └── ProtectedRoute.tsx
│   ├── pages/
│   │   ├── LoginPage.tsx
│   │   ├── RegisterPage.tsx
│   │   ├── DashboardPage.tsx
│   │   ├── CollectionDetailPage.tsx
│   │   ├── PaperDetailPage.tsx
│   │   ├── GraphExplorerPage.tsx
│   │   ├── SearchPage.tsx
│   │   ├── PublicCollectionsPage.tsx
│   │   └── SettingsPage.tsx
│   ├── components/
│   │   ├── layout/            # Header, Sidebar, Footer
│   │   ├── papers/            # PaperCard, PaperList, StateSelector, TagEditor
│   │   ├── collections/       # CollectionCard, CollectionList, MemberManager
│   │   ├── graph/             # GraphCanvas (Cytoscape), NodeTooltip, GraphControls
│   │   ├── search/            # SearchBar, FilterPanel, ResultList
│   │   ├── notes/             # NoteEditor, NoteList
│   │   └── common/            # Button, Modal, Spinner, Pagination, ErrorBoundary
│   ├── hooks/
│   │   ├── usePapers.ts       # TanStack Query hooks for paper operations
│   │   ├── useCollections.ts
│   │   ├── useGraph.ts
│   │   └── useSearch.ts
│   └── types/
│       └── index.ts           # Shared TypeScript interfaces
├── index.html
├── vite.config.ts
├── tsconfig.json
├── package.json
└── Dockerfile
```

### 4.2 Key pages

| Page | Purpose | Key components |
|------|---------|----------------|
| **Dashboard** | User home — recent papers, collections, activity | CollectionList, PaperList (recent), QuickSearch |
| **Search** | Unified search across providers | SearchBar, FilterPanel, ResultList, PaperCard |
| **Collection Detail** | Papers in a collection, ordering, bulk actions | PaperList, StateSelector, TagEditor, ShareDialog |
| **Paper Detail** | Full paper metadata, notes, related papers, graph preview | MetadataPanel, NoteEditor, RelatedPapers, MiniGraph |
| **Graph Explorer** | Interactive citation/reference graph | GraphCanvas, GraphControls, NodeTooltip, DetailPanel |
| **Collection sharing** | Revocable read links and verified-account editors | CollectionSharing, CollectionDetailPage |
| **Settings** | Preferences, password change, data export, account deletion | PreferenceForm, ExportButton, DangerZone |

### 4.3 State management

- **Server state**: TanStack Query handles all API data (fetching, caching, synchronization, optimistic updates).
- **Auth state**: React Context (`AuthProvider`) stores JWT tokens, user info, login/logout actions.
- **UI state**: Local `useState` / `useReducer` for component-level concerns (modals, filters, form state).
- **No global state library** (Redux, Zustand) needed at this scale.

---

## 5. Database Schema

### 5.1 Entity-Relationship overview

```
users ──< collections ──< collection_papers
  │           │
  │           └──< collection_members
  │
  ├──< user_paper_states
  ├──< user_paper_tags
  ├──< notes
  └──< user_preferences

paper_graph_edges (source_key ←→ target_key)
```

### 5.2 Table definitions

#### `users`
| Column | Type | Constraints |
|--------|------|-------------|
| id | UUID | PK, default gen |
| email | VARCHAR(255) | UNIQUE, NOT NULL |
| password_hash | VARCHAR(255) | NOT NULL |
| display_name | VARCHAR(100) | NOT NULL |
| created_at | TIMESTAMPTZ | NOT NULL, default NOW |
| updated_at | TIMESTAMPTZ | NOT NULL, default NOW |

#### `collections`
| Column | Type | Constraints |
|--------|------|-------------|
| id | UUID | PK |
| owner_id | UUID | FK → users.id, NOT NULL |
| name | VARCHAR(200) | NOT NULL |
| description | TEXT | |
| revision | INTEGER | NOT NULL, default 1; optimistic metadata concurrency |
| read_link_* | digest, ciphertext, nonce, key version | Nullable; all null when link disabled |
| created_at | TIMESTAMPTZ | NOT NULL |
| updated_at | TIMESTAMPTZ | NOT NULL |

#### `collection_members`
| Column | Type | Constraints |
|--------|------|-------------|
| collection_id | UUID | FK → collections.id, NOT NULL |
| user_id | UUID | FK → users.id, NOT NULL |
| role | ENUM('owner', 'editor', 'viewer') | NOT NULL |
| — | — | PK (collection_id, user_id) |

#### `collection_papers`
| Column | Type | Constraints |
|--------|------|-------------|
| collection_id | UUID | FK → collections.id, NOT NULL |
| paper_canonical_key | VARCHAR(512) | NOT NULL |
| added_by | UUID | FK → users.id |
| position | INTEGER | default 0 |
| added_at | TIMESTAMPTZ | NOT NULL |
| — | — | PK (collection_id, paper_canonical_key) |

#### `user_paper_states`
| Column | Type | Constraints |
|--------|------|-------------|
| user_id | UUID | FK → users.id, NOT NULL |
| paper_canonical_key | VARCHAR(512) | NOT NULL |
| collection_id | UUID | FK → collections.id, NULL (NULL = global) |
| state | VARCHAR(50) | NOT NULL |
| updated_at | TIMESTAMPTZ | NOT NULL |
| — | — | PK (user_id, paper_canonical_key, collection_id) |

Valid states: `unseen`, `seen`, `saved`, `to_read`, `reading`, `read`, `important`, `ignored`, `excluded`.

#### `user_paper_tags`
| Column | Type | Constraints |
|--------|------|-------------|
| user_id | UUID | FK → users.id, NOT NULL |
| paper_canonical_key | VARCHAR(512) | NOT NULL |
| tag | VARCHAR(100) | NOT NULL |
| created_at | TIMESTAMPTZ | NOT NULL |
| — | — | PK (user_id, paper_canonical_key, tag) |

#### `notes`
| Column | Type | Constraints |
|--------|------|-------------|
| id | UUID | PK |
| user_id | UUID | FK → users.id, NOT NULL |
| target_type | ENUM('paper', 'collection', 'author') | NOT NULL |
| target_key | VARCHAR(512) | NOT NULL |
| content | TEXT | NOT NULL |
| created_at | TIMESTAMPTZ | NOT NULL |
| updated_at | TIMESTAMPTZ | NOT NULL |

Index: `(user_id, target_type, target_key)`.

#### `user_preferences`
| Column | Type | Constraints |
|--------|------|-------------|
| user_id | UUID | FK → users.id, NOT NULL |
| key | VARCHAR(100) | NOT NULL |
| value_json | JSONB | NOT NULL |
| — | — | PK (user_id, key) |

#### `paper_graph_edges`
| Column | Type | Constraints |
|--------|------|-------------|
| source_key | VARCHAR(512) | NOT NULL |
| target_key | VARCHAR(512) | NOT NULL |
| relation_type | VARCHAR(50) | NOT NULL |
| provider_source | VARCHAR(50) | NOT NULL |
| created_at | TIMESTAMPTZ | NOT NULL |
| — | — | PK (source_key, target_key, relation_type) |

Relation types: `cites`, `cited_by`, `similar_to`, `authored_by`, `co_authored`, `version_of`.

Note: `belongs_to_collection`, `belongs_to_topic`, and `user_state` (defined in FR Section 2.4) are modeled via dedicated tables (`collection_papers`, topic fields in cached metadata, and `user_paper_states`), not stored in the graph edge table.

Indexes: `(source_key)`, `(target_key)`, `(relation_type)`.

---

## 6. Caching Architecture

### 6.1 Cache layer

Redis acts as a read-through cache for all external provider responses.

```
Service Layer
     │
     ▼
ProviderCache.get(provider, query_type, params)
     │
     ├─ HIT  → deserialize → return
     │
     └─ MISS → Provider.fetch(params)
                  │
                  ├─ store in Redis with TTL
                  └─ return
```

### 6.2 Key schema

```
openbib:cache:{provider}:{query_type}:{sha256(sorted_params)}
```

Examples:
- `openbib:cache:openalex:lookup:sha256("doi=10.1234/example")`
- `openbib:cache:arxiv:search:sha256("query=attention+is+all&start=0&max=25")`

In the current single-provider runtime `{provider}` is the namespace
`papers-v3:semantic_scholar`, search entries carry `SEARCH_CACHE_VERSION`, and
bulk-search batches and related-paper snapshots use their own key families;
see [Persistence](../Architecture/Persistence.md#redis--short-ttl-api-cache).

### 6.3 TTL configuration

| Query type | Default TTL | Env variable |
|------------|-------------|-------------|
| `lookup` | 24 h | `CACHE_TTL_LOOKUP` |
| `search` | 1 h | `CACHE_TTL_SEARCH` |
| `references` | 7 d | `CACHE_TTL_REFERENCES` |
| `citations` | 12 h | `CACHE_TTL_CITATIONS` |
| `author` | 24 h | `CACHE_TTL_AUTHOR` |

### 6.4 Cache failure behavior

If Redis is unreachable:
1. Rate-limited routes fail closed: authentication, search, paper lookup, graph,
   collection add/import, `POST /library/resolve` and Zotero return 503 with
   `Retry-After: 30` before any provider call.
2. Other authenticated CRUD (collections, Library edits, tags, notes) continues
   and logs a sanitized warning.
3. A cache read or write error inside a request that the rate limiter has
   already allowed is skipped (for example the search cache), never fatal.

See [Persistence: Redis](../Architecture/Persistence.md#redis--short-ttl-api-cache).

---

## 7. Data Flows

### 7.1 Paper addition (by DOI)

```
User enters a DOI, DOI link, s2: key or Semantic Scholar link, arXiv ID, pmid: or pmcid:
  → POST /api/v1/collections/{id}/papers  { "paper_canonical_key": "10.1234/..." }
  → Phase 1 (locks held): lock collection, check edit rights
    → strict parse → normalized key (422 invalid_identifier)
    → duplicate check for the key and for a paper cached under any alias (409 already_in_collection)
    → cached? insert now under the stored row's key (no provider call, no phase 2)
    → unknown hash: key → 422 unknown_paper_key
    → otherwise commit (releases the user row and collection locks)
  → Phase 2 (no transaction): resolve
    → Semantic Scholar GET /paper/{id}
    → DOI miss: doi.org handle check
      → not registered → 422 doi_not_found
      → registered, unknown or check failed → pending
    → other identifier miss → 422 identifier_not_found
    → provider failure: DOI → pending; other identifier → 503 with Retry-After
  → Phase 3 (short transaction): re-lock user row and collection, re-check edit rights
    → upsert cached_paper_metadata; take the stored row's key and group
    → duplicate check again (409)
    → insert collection_papers under the stored key
    → Library entry + version pin for the acting user (synthetic group while pending)
  → 201 with the row (resolved: true | false)
```

Imports (`POST /{id}/import/dois`, up to 500 lines) follow the same phases,
resolving all lines with batch lookups, and return a per-line `ImportResult`
(see [Collection sharing](../Architecture/CollectionSharing.md#adding-and-importing-papers)).
A pending paper is retried or corrected with `POST /library/resolve`.

### 7.2 Search

```
User submits a query (the URL holds q, year_from, year_to, oa and sort)
  → GET /api/v1/papers/search?q=...&year_from=&year_to=&open_access_only=&sort=relevance&page=1&size=20
  → Validate years (422 invalid_year_range) and cursor (422 invalid_cursor) before the cache
  → Cache lookup (search type, keyed by SEARCH_CACHE_VERSION and every parameter)
    → MISS, sort=relevance: Semantic Scholar /paper/search, page by page
      (first 999 results; 422 search_window_exceeded past them)
    → MISS, sort=date|citations: Semantic Scholar /paper/search/bulk batch of up to
      1,000 rows (cached per batch), sliced through an opaque cursor
    → Provider failure: coded 503/422, never cached
  → Deduplicate, store only the served rows in cached_paper_metadata
  → Group versions, flag possible_versions
  → Return {items, has_more, next_cursor, total_estimate, window_capped, sort, source, …}
"Show more" asks for page+1 (relevance) or sends next_cursor back as cursor (other sorts).
```

### 7.3 Graph exploration

```
Open a graph (paper, collection or library)
  → GET /api/v1/graph/paper/{key} | /graph/collection/{id} | /graph/library
  → Seeds + the citation edges among them (batched reference IDs, cached in Redis;
    edges_partial when the edge budget runs out)
Select a node → no request; the range controls show 1–30 as current but not loaded
Load a range (tap 1–30, next, last, or double-click the node)
  → POST /api/v1/graph/related
      { source_key, source_group_key, direction: cited_by|cites,
        order: cited_by_count|recent, range_start, last, exclude_group_keys (pins) }
  → Release the user row lock before any provider call
  → Redis snapshot of the source's citations or references
    → still collecting: { reason: "ranking", scanned, provider_total, nodes: [] }
      (the client repeats the request and shows progress)
    → ranked: positions [range_start, range_start + 30) of the eligible list
  → Hydrate only the served papers (database, then one batch lookup)
  → Return { nodes, edges, group_keys, totals, has_more, … }
Expand pinned nodes
  → POST /api/v1/graph/related/top-up: each pinned source's branch up to 30 papers;
    per-source errors ("ranking", "rate_limited", …) do not fail the others
```

`POST /graph/expand`, which returned 422 above 20 nodes, was removed.
Provider failures are 503 `related_provider_unavailable` with a `reason` and,
when rate limited, `Retry-After`; they are never cached.

### 7.4 Recommendation generation

```
GET /api/v1/recommendations/similar/{key}
  → Service: get paper's references and citations from graph
  → Collect "co-citation" papers (papers that share references/citations)
  → Score by overlap count
  → Exclude papers already in user's collections
  → Return top N results
```

---

## 8. Deployment

### 8.1 Docker Compose services

```yaml
services:
  api:
    build: ./backend
    ports: ["8000:8000"]
    env_file: .env
    depends_on: [db, cache]
    volumes: ["./backend:/app"]          # dev: hot reload
    command: uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload

  web:
    build: ./frontend
    ports: ["3000:80"]
    depends_on: [api]

  db:
    image: postgres:16-alpine
    ports: ["5432:5432"]
    environment:
      POSTGRES_USER: ${DB_USER}
      POSTGRES_PASSWORD: ${DB_PASSWORD}
      POSTGRES_DB: ${DB_NAME}
    volumes: ["pgdata:/var/lib/postgresql/data"]

  cache:
    image: redis:7-alpine
    ports: ["6379:6379"]
    command: redis-server --maxmemory 256mb --maxmemory-policy allkeys-lru

volumes:
  pgdata:
```

### 8.2 Environment variables

```env
# Database
DB_USER=openbib
DB_PASSWORD=<strong-random>
DB_NAME=openbib
DB_HOST=db
DB_PORT=5432
DATABASE_URL=postgresql+asyncpg://${DB_USER}:${DB_PASSWORD}@${DB_HOST}:${DB_PORT}/${DB_NAME}

# Redis
REDIS_URL=redis://cache:6379/0

# Auth
JWT_SECRET_KEY=<strong-random-256bit>
JWT_ACCESS_TOKEN_EXPIRE_MINUTES=30
JWT_REFRESH_TOKEN_EXPIRE_DAYS=7

# Providers
SEMANTIC_SCHOLAR_API_KEY=<your-key>   # required; or SEMANTIC_SCHOLAR_API_KEY_FILE
# DOI_RESOLVE_*, IMPORT_* and GRAPH_RELATED_* tuning: see the README configuration table

# Cache TTLs (seconds)
CACHE_TTL_LOOKUP=86400
CACHE_TTL_SEARCH=3600
CACHE_TTL_REFERENCES=604800
CACHE_TTL_CITATIONS=43200
CACHE_TTL_AUTHOR=86400

# CORS
CORS_ORIGINS=["http://localhost:3000"]

# Rate Limits
RATE_LIMIT_GLOBAL=100/minute
RATE_LIMIT_AUTH=10/minute
```

### 8.3 Production considerations

- **Dockerfile**: Multi-stage build (build stage → slim runtime stage). Non-root user.
- **Frontend**: Vite builds static assets → served by Nginx with gzip and cache headers.
- **HTTPS**: Terminated at a reverse proxy (e.g., Caddy or Nginx) in front of the Docker Compose stack.
- **Backups**: `pg_dump` via cron job or managed PostgreSQL service.
- **Monitoring**: Health check endpoint polled by uptime service. Structured logs forwarded to log aggregator.

---

## 9. Migration Path from Current Codebase

The existing prototype (stdlib HTTP server, SQLite, vanilla JS) established core concepts. The production architecture preserves:

| Existing concept | Production equivalent |
|------------------|----------------------|
| `BaseProvider` abstract class | `providers/base.py` abstract interface (expanded) |
| `ReferenceManagerService` | Split into domain-specific services (`papers/service.py`, `collections/service.py`, etc.) |
| `SqliteGraphStore` (BFS) | `graph/service.py` with PostgreSQL adjacency table + BFS |
| `AppConfig` dataclass | Pydantic `Settings` with `.env` loading |
| `server.py` route handler | FastAPI routers with dependency injection |
| `stores.py` (abstract stores) | SQLAlchemy repository modules per domain |
| `canonical_key()` function | `common/canonical.py` (same logic, shared across services) |
| SQLite database | PostgreSQL (Alembic migrations from SQLite schema) |
| Vanilla JS + CSS | React + TypeScript + existing design tokens |

Current implemented sharing contract: [Collection sharing](../Architecture/CollectionSharing.md).
