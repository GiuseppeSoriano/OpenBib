# Non-Functional Requirements

> **Target scale**: Prototype / early-stage product (< 100 concurrent users).
> The architecture must not preclude future horizontal scaling.

---

## 1. Performance

| Metric | Target |
|--------|--------|
| API response time (cached data) | < 500 ms (p95) |
| API response time (provider fetch) | < 3 s (p95) |
| Frontend initial page load | < 2 s on broadband |
| Graph rendering (≤ 200 nodes) | < 1 s to interactive |
| Search results (cached) | < 500 ms |

- Pagination must be enforced on all list endpoints (default page size: 25, max: 100).
- Graph traversal must respect depth and node-count limits to prevent runaway queries.

---

## 2. Caching

All external provider responses are cached in Redis with configurable TTLs.

| Query type | Default TTL | Rationale |
|------------|-------------|-----------|
| Provider lookup (by DOI/ID) | 24 hours | Paper metadata changes rarely |
| Search results | 1 hour | Acceptable staleness for discovery |
| References / cited-by lists | 7 days | Reference lists are stable once published |
| Citation counts | 12 hours | Counts update more frequently |
| Author metadata | 24 hours | Author profiles change infrequently |

### Cache behavior

- **Cache-through pattern**: Check Redis → on miss, fetch from provider → store in Redis → return.
- **Key format**: `{provider}:{query_type}:{sha256(query_params)}`.
- **TTL override**: Admins can adjust TTLs per provider and query type via environment variables.
- **Cache invalidation**: Manual invalidation via API endpoint (admin-only). No automatic invalidation beyond TTL expiry.
- **Fallback on cache error**: If Redis is unreachable, the system fetches directly from the provider (bypass, no caching).

---

## 3. Security

Compliance target: **OWASP Top 10** (2021 edition).

| Area | Requirement |
|------|-------------|
| **Authentication** | 10-minute access JWT in frontend memory, validated against a revocable database session; rotating opaque refresh token in an HttpOnly, Secure, SameSite=Strict cookie with absolute 7-day expiry. |
| **Password storage** | Argon2id with recommended parameters (memory: 64 MB, iterations: 3, parallelism: 4). |
| **Transport** | HTTPS required in production. HSTS header enabled. |
| **Input validation** | All inputs validated and sanitized server-side via Pydantic models. No raw SQL — all queries through ORM. |
| **Rate limiting** | Global rate limit per IP (100 req/min default). Auth endpoints more restrictive (10 req/min). Configurable. |
| **CORS** | Restricted to known frontend origins. |
| **Dependency security** | Automated vulnerability scanning in CI (e.g., `pip-audit`, `npm audit`). |
| **Secrets management** | Production secrets are supplied through read-only Docker secret files; versioned application keys encrypt Zotero credentials, pending email and deletion receipts. Never commit instance secrets. |
| **Authorization** | Role-based access on collections (owner/editor/viewer). Every mutating endpoint checks ownership or role before proceeding. |

---

## 4. Reliability & Resilience

| Requirement | Detail |
|-------------|--------|
| **Provider degradation** | If one provider is unavailable, the system tries the next in the fallback chain. User sees a clear warning, not an error page. |
| **No silent data loss** | User data (notes, tags, states, collections) is never lost due to provider failures, merges, or cache evictions. |
| **Retry with backoff** | Failed provider calls are retried up to 2 times with exponential backoff (1 s, 3 s). |
| **Idempotency** | All write operations are idempotent where possible (e.g., adding a paper that already exists returns success without duplication). |
| **Database backups** | Optional per instance. When enabled: encrypted off-site snapshots and deletion replay, with a maximum 30-day retention. When disabled: no guaranteed database recovery; disclose this in the privacy notice. |
| **Health check** | `GET /health` endpoint returns system status (DB connectivity, Redis connectivity, provider reachability). |

---

## 5. Scalability

The MVP targets < 100 users, but the architecture enables future scaling:

| Concern | MVP approach | Scale-out path |
|---------|-------------|----------------|
| Backend concurrency | FastAPI async workers (uvicorn, 4 workers) | Kubernetes pods with horizontal autoscaler |
| Database | Single PostgreSQL instance | Read replicas, connection pooling (PgBouncer) |
| Cache | Single Redis instance | Redis Cluster or managed Redis |
| Search | PostgreSQL full-text search (`tsvector`) | Elasticsearch / Meilisearch |
| Graph queries | PostgreSQL adjacency-list with BFS | Neo4j or Apache AGE (PostgreSQL extension) |
| File storage | Local filesystem (imports/exports) | S3-compatible object store |

- API processes share server-side authentication sessions in PostgreSQL and atomic rate-limit buckets in Redis.
- Database connections use a pool (SQLAlchemy async pool, default: 5 connections, max: 20).

---

## 6. Usability

| Requirement | Target |
|-------------|--------|
| Mobile responsiveness | All pages usable on screens ≥ 375 px wide |
| Accessibility | WCAG 2.1 Level AA compliance |
| Core task efficiency | Search → save → explore cycle completes in ≤ 3 clicks |
| Onboarding | New user completes first paper save within 2 minutes (no tutorial needed) |
| Error messages | All errors human-readable; provider errors include "what you can do" guidance |
| Loading states | Skeleton loaders for async data; no blank screens |
| Keyboard navigation | All core actions accessible via keyboard |

---

## 7. Maintainability

| Requirement | Detail |
|-------------|--------|
| **Code organization** | Layered backend: routes → services → repositories → providers. Frontend: pages → components → hooks → API client. |
| **Type safety** | Pydantic v2 models for all API request/response schemas. TypeScript strict mode on frontend. |
| **API documentation** | Auto-generated OpenAPI spec via FastAPI. Always up to date with implementation. |
| **Testing** | Backend: ≥ 80% line coverage on service layer (pytest). Frontend: component tests for critical flows (Vitest + React Testing Library). |
| **Linting & formatting** | Backend: Ruff (linter + formatter). Frontend: ESLint + Prettier. Enforced in CI. |
| **Database migrations** | Alembic for all schema changes. No manual DDL in production. |
| **Dependency management** | Backend: `pyproject.toml` with pinned versions. Frontend: `package-lock.json`. |
| **CI pipeline** | Lint → Type check → Test → Build on every push. |

---

## 8. Data Privacy & Compliance

| Requirement | Detail |
|-------------|--------|
| **Data isolation** | All user data is scoped to the authenticated user. No cross-user data leakage. |
| **Minimal data collection** | Only data required for functionality is collected. No analytics tracking beyond basic server logs. |
| **Data export** | Users can export all their data (FR-085) in a versioned JSON format; BibTeX export is deferred (Zotero-first release). |
| **Account deletion** | Users can delete their account. All personal data (collections, notes, tags, states, preferences) is permanently removed. Shared collections are transferred to the next owner or deleted. |
| **Cookie policy** | Only the opaque refresh-session cookie and localStorage theme/language preferences. No analytics, trackers or optional-consent banner. |
| **Provider data** | Cached provider data contains only publicly available paper metadata. No personal data from providers is stored. |

---

## 9. Interoperability

| Requirement | Detail |
|-------------|--------|
| **API standard** | RESTful JSON API with OpenAPI 3.1 specification. |
| **Import formats** | BibTeX (`.bib`), DOI lists (plain text, one per line). |
| **Export formats** | JSON (full user account export); Zotero sync for references. BibTeX is deferred. |
| **External identifiers** | DOI, arXiv ID, PMID, PMCID, OpenAlex ID — all preserved and queryable. |
| **Future extensions** | RIS import/export, CSL-JSON, Zotero RDF — documented as post-MVP. |

---

## 10. Observability

| Requirement | Detail |
|-------------|--------|
| **Logging** | Structured JSON logs (level, timestamp, request ID, user ID, endpoint, duration). |
| **Log levels** | DEBUG for development; INFO for production; WARN/ERROR for issues. |
| **Health endpoint** | `GET /health` returns `{ "status": "ok", "db": "ok", "cache": "ok", "providers": { ... } }`. |
| **Request tracing** | Unique request ID header (`X-Request-ID`) propagated through all layers. |
| **Error tracking** | Unhandled exceptions logged with full stack trace and request context. Integration-ready for Sentry or similar (post-MVP). |
| **Metrics** | Provider call counts, cache hit/miss ratios, response times — logged for manual analysis. Prometheus/Grafana integration deferred. |

---

## 11. Deployment & Infrastructure

| Requirement | Detail |
|-------------|--------|
| **Containerization** | All services run in Docker containers, orchestrated via Docker Compose. |
| **Services** | `api` (FastAPI + Uvicorn), `web` (React build served by Nginx), `db` (PostgreSQL 16+), `cache` (Redis 7+). |
| **Configuration** | All configuration via environment variables (12-factor app). `.env` file for local development. |
| **Local development** | Single `docker compose up` starts the entire stack. Hot-reload enabled for both backend and frontend. |
| **Production readiness** | Dockerfile uses multi-stage builds. Non-root container user. No dev dependencies in production image. |
| **Backup** | PostgreSQL data persisted on Docker volume. Backup script included for `pg_dump`. |
