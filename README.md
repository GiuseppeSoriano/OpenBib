# OpenBib — Academic Reference Manager

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

### ⚠️ Upgrading from the RefMan prototype

The database credentials were renamed from `refman` to `openbib`. **Existing dev
volumes were initialized with the old credentials and will fail to start.** Reset
them once (this deletes local dev data):

```bash
docker compose down -v
docker compose up --build -d
docker compose exec api alembic upgrade head
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
# Backend (inside the api container — no host installs needed)
docker compose exec api pytest -q

# Frontend (one-off node container, also maintains package-lock.json)
docker compose run --rm web-test

# Or locally:
cd backend && pytest --cov=app --cov-report=term-missing
cd frontend && npm test
```

---

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `DATABASE_URL` | PostgreSQL connection string | `postgresql+asyncpg://openbib:openbib@localhost:5432/openbib` |
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
| `GET` | `/api/v1/papers/search` | Search papers across providers |
| `GET` | `/api/v1/papers/{key}` | Look up a single paper |
| `GET/PUT` | `/api/v1/papers/{key}/states` | Reading state |
| `GET/POST/DELETE` | `/api/v1/papers/{key}/tags` | Paper tags |
| `GET/POST/DELETE` | `/api/v1/collections/{id}/papers` | Papers in a collection |
| `GET` | `/api/v1/collections/{id}/export/bibtex` | Export collection as BibTeX |
| `POST` | `/api/v1/collections/{id}/import/dois` | Import papers by DOI list |
| `POST` | `/api/v1/collections/{id}/import/keys` | Import papers by canonical key list |
| `GET/POST/DELETE` | `/api/v1/collections/{id}/members` | Collaboration members |
| `GET/POST/PATCH/DELETE` | `/api/v1/notes` | Notes on papers / collections |
| `GET` | `/api/v1/graph/{paper_key}` | Citation graph (BFS expansion) |
| `GET` | `/api/v1/recommendations/{paper_key}` | Co-citation recommendations |
| `GET` | `/api/health` | Health check |

Full interactive docs at `http://localhost:8000/api/docs` when the server is running.

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
