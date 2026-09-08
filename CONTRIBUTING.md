# Contributing to OpenBib

Thank you for helping improve OpenBib. Bug reports, documentation fixes, design feedback, tests, and focused code changes are all welcome.

## Before you start

- Read and follow the [Code of Conduct](CODE_OF_CONDUCT.md).
- Search [existing issues](https://github.com/GiuseppeSoriano/OpenBib/issues) before opening a new one.
- For a substantial feature or architectural change, open a feature request first. Agreeing on scope before implementation avoids wasted work.
- Report vulnerabilities privately as described in [SECURITY.md](SECURITY.md).

## Development setup

The shortest path to a complete local stack is Docker Compose:

```bash
cp .env.example .env
docker compose up --build -d
```

The application is then available at <http://localhost:3000> and the API docs at <http://localhost:8000/api/docs>.

For live host-based development, start PostgreSQL and Redis with `docker compose up -d db cache`, then follow the backend and frontend setup in the [README](README.md#local-development).

## Making a change

1. Fork the repository and create a short, focused branch from `main`.
2. Use a descriptive branch name such as `fix/search-deduplication` or `feat/collection-sharing`.
3. Keep each pull request limited to one logical change.
4. Add or update tests for behavior changes.
5. Update user-facing documentation and both `en.json` and `it.json` for new UI text.
6. Run the relevant checks locally.
7. Open a pull request using the repository template.

Small commits with clear imperative messages are easiest to review. The project commonly uses prefixes such as `feat:`, `fix:`, `docs:`, `test:`, `refactor:`, and `chore:`, but a specific commit-message tool is not required.

## Quality checks

### Backend

```bash
cd backend
uv run --frozen ruff check app tests scripts alembic
uv run --frozen ruff format --check app tests scripts alembic
uv run --frozen pytest -q
```

When changing Python code, also run Ruff on the files you touched:

```bash
cd backend
ruff check app tests
```

### Frontend

```bash
cd frontend
npm run lint
npm test
npm run build
```

CI must pass before a pull request can be merged. If a test is intentionally not applicable, explain why in the pull request rather than removing coverage.

## Project conventions

- Preserve the canonical paper-key and paper-group-key behavior documented in [Persistence architecture](docs/Architecture/Persistence.md); existing user data depends on it.
- Keep the greedy paper-details route last in the papers router.
- Use async SQLAlchemy patterns in backend request paths.
- Never commit secrets, `.env` files, database dumps, or real Zotero API keys.
- Use semantic CSS tokens instead of hard-coded colors.
- Put frontend component styles in the `components` cascade layer and page styles in the `pages` layer.
- Route all new UI copy through i18next and add matching English and Italian translations.
- Keep frontend types aligned with the backend response schemas.
- Add Alembic migrations for schema changes; do not edit an applied migration.

More architectural context is available in [Persistence architecture](docs/Architecture/Persistence.md) and under [`docs/`](docs/).

## Pull request expectations

A reviewable pull request includes:

- a concise explanation of the problem and solution;
- a linked issue when one exists;
- tests covering the change;
- screenshots or a short recording for visible UI changes;
- migration and rollback notes for database changes;
- documentation updates when behavior or setup changes.

Maintainers may ask for a change to be split into smaller pull requests. Reviews focus on correctness, accessibility, security, maintainability, and consistency with the product's existing architecture.

## Licensing

By submitting a contribution, you agree that it is your original work (or that you have the right to submit it) and that it will be licensed under the repository's [MIT License](LICENSE).
