# Reference Manager

Backend-first literature discovery platform with a transactional SQLite core, configurable graph store, and configurable read-model store.

## Run

```bash
python3 app.py
```

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
