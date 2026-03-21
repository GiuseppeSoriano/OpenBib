# Reference Manager

Backend-first literature discovery platform implemented with Python standard library components and SQLite.

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
- persistence of references, citations, and provider provenance for each retrieved paper;
- graph exploration, recommendations, timelines, feed, notifications, provider documentation, and external-library sync hooks.

## Environment

Create `.env` from `.env.example` and provide at least:

```bash
OPENALEX_API_KEY=...
CROSSREF_MAILTO=you@example.com
EUROPEPMC_ENABLED=true
EUROPEPMC_EMAIL=you@example.com
```

## Notes

- runtime retrieval is designed for real external providers; tests use a mocked HTTP transport so the suite remains offline and deterministic;
- the HTTP API is exposed under `/api/*`;
- the test suite uses `unittest` and runs with `python3 -m unittest`.
