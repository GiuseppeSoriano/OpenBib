# RefMan — Academic Reference Manager

A full-stack application for searching, organizing, and exploring academic papers across multiple providers (OpenAlex, arXiv, Crossref, Europe PMC).

## Architecture

| Layer | Stack |
|-------|-------|
| **Frontend** | React 18 · TypeScript 5 · Vite · TanStack Query · Cytoscape.js |
| **Backend** | Python 3.12 · FastAPI · SQLAlchemy 2.0 (async) · Pydantic v2 |
| **Database** | PostgreSQL 16 · Redis 7 |
| **Deploy** | Docker Compose (4 services) |

## Prerequisites

- [Docker](https://docs.docker.com/get-docker/) and [Docker Compose](https://docs.docker.com/compose/install/) v2+
- **OR** for local development:
  - Python 3.12+
  - Node.js 20+
  - PostgreSQL 16+
  - Redis 7+

---

## Quick Start (Docker Compose)

```bash
# 1. Clone and enter the repository
git clone <repo-url>
cd ReferenceManager
git checkout feat/production-architecture

# 2. Create your environment file
cp .env.example .env
# Edit .env and set at least:
#   JWT_SECRET_KEY=<random-secret-string>
#   OPENALEX_EMAIL=<your-email>
#   CROSSREF_MAILTO=<your-email>

# 3. Start all services
docker compose up --build -d

# 4. Run database migrations
docker compose exec api alembic upgrade head

# 5. Open the application
#    Frontend:  http://localhost:3000
#    API docs:  http://localhost:8000/api/docs
#    Health:    http://localhost:8000/api/health
```

### Stopping

```bash
docker compose down          # stop containers
docker compose down -v       # stop and delete data volumes
```

---

## Local Development

### Backend

```bash
cd backend

# Create a virtual environment
python -m venv .venv
# Windows
.venv\Scripts\activate
# macOS/Linux
source .venv/bin/activate

# Install dependencies
pip install -e ".[dev]"

# Make sure PostgreSQL and Redis are running, then:
cp ../.env.example ../.env
# Edit ../.env with your local connection strings

# Run migrations
alembic upgrade head

# Start the API server (auto-reload)
uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
```

The API will be available at `http://localhost:8000`.
Interactive docs at `http://localhost:8000/api/docs`.

### Frontend

```bash
cd frontend

# Install dependencies
npm install

# Start dev server (proxies /api to backend)
npm run dev
```

The frontend will be available at `http://localhost:5173`.

### Running Tests

```bash
cd backend

# Run all tests
pytest

# With coverage
pytest --cov=app --cov-report=term-missing

# Run a specific test file
pytest tests/test_auth.py -v
```

---

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `DATABASE_URL` | PostgreSQL connection string | `postgresql+asyncpg://refman:refman@localhost:5432/refman` |
| `REDIS_URL` | Redis connection string | `redis://localhost:6379/0` |
| `JWT_SECRET_KEY` | Secret for JWT signing (CHANGE IN PRODUCTION) | `change-me-...` |
| `JWT_ACCESS_EXPIRE_MINUTES` | Access token lifetime | `30` |
| `JWT_REFRESH_EXPIRE_MINUTES` | Refresh token lifetime | `10080` (7 days) |
| `OPENALEX_API_KEY` | OpenAlex API key (optional) | — |
| `OPENALEX_EMAIL` | Email for OpenAlex polite pool | — |
| `CROSSREF_MAILTO` | Email for Crossref polite pool | — |
| `CORS_ORIGINS` | Allowed CORS origins (JSON array) | `["http://localhost:3000","http://localhost:5173"]` |

See [.env.example](.env.example) for the complete list.

---

## Project Structure

```
ReferenceManager/
├── backend/
│   ├── app/
│   │   ├── auth/           # JWT authentication
│   │   ├── collections/    # Collection CRUD with RBAC
│   │   ├── common/         # Shared utilities
│   │   ├── graph/          # Citation graph + BFS traversal
│   │   ├── notes/          # Polymorphic notes
│   │   ├── papers/         # Paper states, tags, search
│   │   ├── providers/      # OpenAlex, arXiv, Crossref, Europe PMC
│   │   ├── recommendations/ # Co-citation similarity
│   │   ├── users/          # User profile management
│   │   ├── config.py       # Pydantic settings
│   │   ├── database.py     # Async SQLAlchemy engine
│   │   ├── dependencies.py # FastAPI dependency injection
│   │   └── main.py         # App factory + middleware
│   ├── alembic/            # Database migrations
│   ├── tests/              # pytest test suite
│   ├── Dockerfile
│   └── pyproject.toml
├── frontend/
│   ├── src/
│   │   ├── components/     # Layout, shared UI
│   │   ├── contexts/       # Auth context
│   │   ├── lib/            # Axios API client
│   │   ├── pages/          # Route pages
│   │   ├── styles/         # Global CSS + design tokens
│   │   └── types/          # TypeScript interfaces
│   ├── Dockerfile
│   └── package.json
├── docs/
│   └── Requirements/       # Vision, FR, NFR, Architecture, API docs
├── docker-compose.yml
├── .env.example
├── CLAUDE.md               # AI assistant context file
└── README.md
```

---

## API Routes

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/v1/auth/register` | Create account |
| `POST` | `/api/v1/auth/login` | Sign in |
| `POST` | `/api/v1/auth/refresh` | Refresh JWT |
| `GET` | `/api/v1/users/me` | Current user profile |
| `PATCH` | `/api/v1/users/me` | Update profile |
| `GET` | `/api/v1/collections` | List collections |
| `POST` | `/api/v1/collections` | Create collection |
| `GET` | `/api/v1/collections/{id}` | Collection detail |
| `GET` | `/api/v1/papers/search` | Search papers |
| `GET` | `/api/v1/graph/{paper_key}` | Citation neighborhood |
| `GET` | `/api/v1/recommendations/{paper_key}` | Similar papers |
| `GET` | `/api/health` | Health check |

Full interactive docs at `/api/docs` when the server is running.

---

## Design

The UI follows the **Neutral Elegance** palette:

| Role | Color | Hex |
|------|-------|-----|
| Dark Charcoal (sidebar, text) | ■ | `#463F3A` |
| Warm Gray (secondary text) | ■ | `#8A817C` |
| Light Gray (borders) | ■ | `#BCB8B1` |
| Off White (background) | ■ | `#F4F3EE` |
| Dusty Rose (accent, CTAs) | ■ | `#E0AFA0` |

---

## License

This project is for personal/academic use.

Open [http://127.0.0.1:8000](http://127.0.0.1:8000).

## Included capabilities

- account registration, login, logout, profile updates, recovery-token demo;
- collections with seeds, duplication, merge, snapshots, sharing, and audit trail;
- paper ingestion from DOI, title, URL, manual fallback, import pipelines, and export formats;
- deduplication, merge lineage, record-quality states, notes, statuses, tags, and feedback;
- backend retrieval adapters for OpenAlex, Crossref, and Europe PMC with `.env` configuration;
- local paper catalog with on-demand cached references/citations snapshots and provider provenance;
- persistent backend cache for provider lookup/search/relations responses;
- differentiated TTLs for references and citations live snapshots;
- retrieval-run tracking for ingest, refresh, and graph expansion workflows;
- explicit separation between saved library and temporary discovery results;
- configurable graph projections (`sqlite` fallback or `neo4j`) and configurable read models (`sqlite` fallback or `mongodb`);
- graph exploration, recommendations, timelines, feed, notifications, provider documentation, and external-library sync hooks.

## Environment

Create `.env` from `.env.example` and provide at least:

```bash
OPENALEX_API_KEY=...
CROSSREF_MAILTO=you@example.com
EUROPEPMC_ENABLED=true
EUROPEPMC_EMAIL=you@example.com
REFERENCE_CACHE_TTL_SECONDS=604800
CITATION_CACHE_TTL_SECONDS=43200
```

To run with real external stores:

```bash
GRAPH_STORE_BACKEND=neo4j
READ_MODEL_STORE_BACKEND=mongodb
MONGODB_URI=mongodb://127.0.0.1:27017
MONGODB_DATABASE=reference_manager
NEO4J_URI=bolt://127.0.0.1:7687
NEO4J_USERNAME=neo4j
NEO4J_PASSWORD=your_password
NEO4J_DATABASE=neo4j
```

The Python runtime must have `pymongo` and `neo4j` installed.

## Seed Demo Data

To wipe the current demo dataset and repopulate the transactional store, graph store, and read-model store with a small verification dataset:

```bash
PYTHONPATH=. python3 scripts/seed_demo_data.py
```

The seed creates:

- the frontend demo account `demo.preview@reference-manager.test` with password `Preview2026Demo`;
- a collaborator account `demo.collaborator@reference-manager.test` with the same password;
- five saved papers, two collections, reading states, shared notes, collaborator membership, and a small internal citation graph.

## Notes

- runtime retrieval is designed for real external providers; tests use a mocked HTTP transport so the suite remains offline and deterministic;
- the HTTP API is exposed under `/api/*`;
- `/api/system` reports the active transactional, graph, and read-model backends;
- retrieval-oriented endpoints currently include `/api/papers/add`, `/api/papers/:id/relations`, `/api/papers/refresh`, `/api/papers/expand`, and `/api/retrieval-runs`;
- the test suite uses `unittest` and runs with `python3 -m unittest`.
