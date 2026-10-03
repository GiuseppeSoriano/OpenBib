# Changelog

## Unreleased — UI/UX audit fixes

Resolves the ten confirmed findings (F01–F10) and eight improvement proposals (S01–S08) of the UI/UX audit, on top of Semantic Scholar as the sole provider, OTP registration and collection sharing.

### Upgrade notes

- **Back up the database first.** Migration `1d2e3f4a5b6c` is an irreversible data repair: it re-keys paper identifiers stored before normalization (bare DOIs, `DOI:` labels, doi.org links) to `doi:<lowercase DOI>` and merges the duplicates, and its downgrade is a no-op. Stop `api` and `mail-worker`, then preview it with `docker compose run --rm migrate python -m scripts.repair_paper_keys --dry-run` (not `run api`, which applies the migration first); keys that cannot become a DOI are reported and left for users to fix. See docs/Operations/Backups.md.
- `SEMANTIC_SCHOLAR_API_KEY` is required. New settings: `DOI_RESOLVE_TIMEOUT_SECONDS`, `IMPORT_RESOLVE_CONCURRENCY`, `IMPORT_REQUEST_BUDGET_SECONDS` and `GRAPH_RELATED_*` (see README). Run a single API worker per key.
- doi.org is a new data recipient: when Semantic Scholar does not know an added or imported DOI, only that DOI is sent to doi.org to check that it is registered. Review legal.json and consider a `privacy_version` bump.
- legal.json provider and location fields accept `{en, it}` objects; until they are converted, the English privacy page still shows the original language.
- An opt-in `backup` Compose profile is available; it changes nothing unless enabled.

### Breaking API changes

- `POST /graph/expand` is removed. Use `POST /graph/related` (one ranked range of a paper's citers or references) and `POST /graph/related/top-up` (expand pinned nodes). The base-graph `order` parameter is deprecated and ignored.
- `GET /library/entries` returns an envelope `{items, total, page, size}` instead of an array, and gains `q`, `state`, `tag`, `collection_id` and `sort` parameters; `GET /library/facets` is new.
- Errors that clients act on are coded: `detail` is an object `{code, message, …}` rather than a string. This covers 409 `already_in_collection` and `entry_in_collections` (with `collections=[{id, name, is_owner}]`); 422 `invalid_identifier`, `doi_not_found`, `identifier_not_found`, `unknown_paper_key`, `invalid_year_range`, `invalid_cursor`, `invalid_query`, `search_window_exceeded`, `range_start_not_aligned` and `target_per_source_too_large`; 502 `provider_bad_response` (a malformed provider response); and 503 `provider_not_configured`, `provider_key_rejected`, `provider_rate_limited`, `provider_unavailable` and `related_provider_unavailable`, with `Retry-After` when a retry makes sense.
- Collection adds resolve the identifier first: unknown identifiers are rejected instead of stored, a DOI Semantic Scholar cannot describe is stored as pending, and paper rows gain `resolved`.
- Imports return one result per non-blank line (`results[]` with `added`, `duplicate`, `invalid`, `not_found`, `unresolved` or `unavailable`) plus counters; `skipped` remains as a deprecated alias of `duplicate`. Invalid lines are never stored.
- Dashboard statistics: `distinct_papers` now counts logical papers (paper groups), not distinct versions.
- Zotero: newly created items carry the cleaned plain-text title and `abstractNote`, and their `url` is the stored landing page, which for Semantic Scholar records is the semanticscholar.org page. Items that are already linked are not rewritten.
- Search responses gain `sort`, `next_cursor`, `total_estimate`, `window_capped`, `filtered_locally`, `source` and per-item `possible_versions`; existing fields are unchanged.

### Fixed and improved

- **F01, DOI input.** Bare DOIs, `doi:`/`DOI:` prefixes, doi.org links, `s2:` keys and Semantic Scholar links, arXiv IDs and links, `pmid:` and `pmcid:` all normalize to one key before deduplication, and a paper already cached under another alias is added under its stored key: one record, no duplicates. The add form explains the accepted forms, validates input, and shows inline errors with a retry countdown.
- **F02, unresolved records.** Unresolved Library and collection cards show their identifier with Retry, Fix identifier and Remove/Delete. `POST /library/resolve` retries or corrects a record. Deleting a Library entry still used by collections lists them and can remove it from them (`?detach=true`).
- **F03, mobile footer.** The fixed tab bar reserves its height and the safe-area inset after the footer, so footer links and final actions stay reachable.
- **F04, graph controls.** On desktop the controls sit in a bottom bar that takes real space instead of covering the canvas. Phones and short landscape screens get a "Graph controls" sheet and a one-line selection summary.
- **F05, dialogs.** Dialogs are labelled, move and contain focus, make the background inert, close on Escape (top dialog only) and return focus to their trigger.
- **F06, abstracts.** Provider titles and abstracts are rendered as plain text with labelled paragraphs instead of raw markup.
- **F07, search state.** The query, filters and sort live in the URL, so reload, copied links and back/forward keep the search; scroll position is restored.
- **F08, version labels.** Version choices are told apart by posted date, server, citations or an ordinal, with unique accessible names.
- **F09, privacy page.** Localized legal fields render in the page's language without doubled punctuation.
- **F10, touch targets.** Header, footer, dialog, toast and graph controls reach 44 px on touch screens.
- **S01, related papers.** Citers and references load in ranked ranges of 30 (by citations or recency, up to the first 10,000 records Semantic Scholar returns), with session-only pins that are excluded from later ranges, "Expand pinned nodes", ranking progress for large lists, and failures that keep existing nodes.
- **S02, refinement and discovery.** Search adds year, open-access and sort controls with "Show more". The Library is paginated (no 100-entry ceiling), searchable and filterable by state, tag and collection, and sortable.
- **S03, provider status.** One status line says where results come from and how many there are, and explains rate limits (with a countdown), operator configuration problems and the relevance window (the first 999 results).
- **S04, possible duplicates.** Distinct results that look like versions of one work are marked "Possible other version" and linked, never merged; citation counts name their source.
- **S05, import and Zotero.** Imports show a valid/invalid summary before submitting, per-line corrections, progress and per-line results with retry. A visible "Connect Zotero to sync" link replaces a disabled button.
- **S06, onboarding and wording.** A "Get started" path for new users, explained dashboard statistics, a visible search heading, and copy without internal terms.
- **S07, full-text links.** "Download PDF" appears only for direct PDF links, repository landing pages read "Full text / Repository", and the Semantic Scholar page is a separate "View on Semantic Scholar" link.
- **S08, recovery.** Settings has Zotero and "Your data" sections with export help and a notice when the instance keeps no backups; privacy, terms and the Library link to the export, and the dashboard reminds users to export when there are no backups. The optional backup profile, with a tested restore runbook, is documented.
- Also fixed: the remove-saved-version route was unreachable; saving a pending paper again could create a second Library entry; the Library list stopped at 100 entries; provider failures in the graph were cached as "no related papers"; several controls had incorrect accessible labels.

## Unreleased — public-release hardening

Backups can be explicitly disabled without disabling authenticated SMTP, account deletion or other production security checks. Legal configuration and bilingual privacy pages disclose the selected policy; previous configurations retain backup/deletion-journal protection. An independently enabled deletion journal can protect previous snapshots while new backups are suspended.

The operator's public postal address may be omitted from legal configuration; identity and contact fields remain required. Operators remain responsible for reviewing the legal suitability of their published notices.

Breaking alpha API changes remain under /api/v1. Registration now returns 202 and requires legal versions; verification requires the email token and final new_password. Login/verification return only a short-lived access token. Refresh consumes/rotates an HttpOnly cookie without a request body; refresh_token is no longer returned in JSON. Logout is server-side and asynchronous in the client.

Account lifecycle endpoints add verification/resend, forgot/reset password, verified email change, password change, logout-all, legal acceptance, password-protected JSON export and password-confirmed deletion. Direct email editing and unauthenticated deletion are removed. UserRead adds email_verified and legal_acceptance_required. Collection responses expose capabilities rather than owner_id.

Zotero credentials migrate transactionally from plaintext to versioned authenticated encryption. The schema adds sessions, action tokens, encrypted email outbox, deletion tombstones, legal/verification timestamps and membership joined_at. Downgrade beyond encryption requires an isolated pre-migration backup restore.

The application gains secret-file configuration, Redis token buckets, body/input bounds, an encrypted email outbox, legal pages, account portability, deletion-replay support and expanded security CI. Local development includes Mailpit and loopback-only ports. No analytics, tracker or cookie banner is introduced.

The repository includes application source, local development tooling, tests and community documentation. Contributions follow the pull-request review and automated checks described in CONTRIBUTING.md.
