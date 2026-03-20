# Reference Manager

Self-contained literature discovery platform implemented with Python standard library components and SQLite.

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
- graph exploration, recommendations, timelines, feed, notifications, provider documentation, and external-library sync hooks.

## Notes

- external provider integration is implemented through deterministic local mock providers so the application remains runnable offline;
- the HTTP API is exposed under `/api/*`;
- the test suite uses `unittest` and runs with `python3 -m unittest`.
