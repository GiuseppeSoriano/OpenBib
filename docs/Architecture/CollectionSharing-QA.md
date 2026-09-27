# Collection sharing — local validation (2026-09-27)

Branch: `codex/semantic-scholar-provider`. Validation completed locally before
commit and publication of the branch. No merge or PR is part of this delivery.

## Results

| Check | Result |
|---|---|
| Backend pytest with disposable PostgreSQL 16 + Redis | 221 passed, 3 opt-in Semantic Scholar live tests skipped |
| Frontend Vitest | 133 passed across 24 files |
| Backend Ruff lint and format check | Passed |
| Frontend ESLint | Passed |
| TypeScript + Vite production build | Passed; existing >500 kB bundle warning remains |
| Alembic empty/previous/pre-OTP/current-schema upgrade tests | Passed, including preserved UUIDs, memberships, roles and papers |
| PostgreSQL concurrent metadata edits, duplicate paper additions, revocation vs write | Passed |
| Browser flows against Docker, separate owner/editor/anonymous contexts | Passed |
| Credential/capability scan of Git-eligible files and collected logs | Passed |
| Runtime log scan | No application error/traceback/HTTP 500 found during QA |

The browser run registered two disposable users through the real OTP/Mailpit
flow. It exercised collection creation, link activation, collaborator addition,
anonymous viewing and reload, graph/back navigation, collaborator login returning
to the link, metadata editing, link rotation, collaborator removal and link
disabling. It verified editor access survives link rotation, the old link stops
working, the new link remains read-only, and revocation makes the relevant view
unavailable. No JavaScript page errors were observed. Desktop 1280 px and mobile
390 px layouts were inspected; mobile had no horizontal page overflow.

The cached Titans paper was used in the QA collection. External Zotero mutations
were mocked in unit tests; no real Zotero library was modified.

Browser testing caught an anonymous-session hydration race: a refresh failure
could invalidate an otherwise successful collection read. Collection/graph reads
now wait for authentication hydration. Regression tests also cover revision
snapshots during editing, focus-based revocation, and late graph expansion
responses after changing the access scope.

## Local stack and preservation

The application database remains `openbib_semantic_scholar` and is migrated to
`f8a9b0c1d2e3`. Existing collection read links are disabled. API, web, mail worker,
PostgreSQL, Redis and Mailpit are running; volumes were preserved.

Before migration, a mode-0600 custom-format PostgreSQL backup was created and its
manifest verified at:
`data/backups/openbib-before-collection-sharing-20260927.dump` (ignored by Git).

The QA collection and both QA accounts were removed through application APIs.
The original application counts were restored: 2 users, 1 collection, 1 membership,
7 collection papers. Disposable test PostgreSQL/Redis containers were removed.
Existing local application accounts and the older orphan container were untouched.
Normal account-deletion receipts and registration retention still apply to QA users.

## Manual verification

At `http://localhost:3000/collections`, open your collection and select **Condividi**.
Enable/copy a read link and open it in a private browser. Add another existing,
verified account's email under **Collaboratori** to grant editing access. Disabling
the link does not remove collaborators; removing a collaborator does not revoke a
valid read link they possess. Revocation is checked on the next request/focus,
without real-time push or removal of already downloaded content.
