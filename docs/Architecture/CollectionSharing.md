# Collection sharing

Collections have stable UUIDs and a single authoritative `owner_id`. There is no
visibility setting or anonymous public listing. The owner can activate one
revocable read capability and independently grant editing access by email to an
existing verified account. No email is sent and there are no pending invitations.

## Permissions and identity

`app.collections.access.authorize` is the common boundary for content, imports,
graphs and Zotero reads. Owner-only administration uses `owner_id`, never a
client-supplied role. Members are attached to user IDs, so email changes preserve
access. Legacy viewers are retained and can be removed or promoted by adding
their email. New member grants always assign editor. Only the actual owner may
delete a collection, manage members or read/rotate its capability.

Anonymous and authenticated non-members can read with the capability; no link
allows editing. Link access does not create membership. Disabling a link does not
remove individual memberships; removing a member does not invalidate a link they
already possess. Links can be forwarded. Revocation cannot erase already downloaded
content. Existing account-deletion succession remains unchanged; there is no new
manual ownership-transfer feature.

## API contracts

All paths below are relative to `/api/v1/collections`.

| Endpoint | Contract |
|---|---|
| POST `/` | `name`, optional `description`; rejects obsolete `visibility` |
| GET `/` | Owned and individually accessible collections, once each |
| GET `/{id}` | Metadata, revision, `is_owner`, `can_edit`, `can_manage_access` |
| PATCH `/{id}` | Required current `revision`, optional name/description; 409 on conflict |
| GET `/{id}/members` | Owner-only email/name/role list, excluding owner |
| POST `/{id}/members` | `{email}`; verified existing account, idempotent editor grant |
| DELETE `/{id}/members/{user_id}` | Owner-only revocation; cannot remove owner |
| GET/PUT `/{id}/read-link` | Owner-only status/copy or idempotent activation |
| POST `/{id}/read-link/rotate` | Replace capability; old link stops working |
| DELETE `/{id}/read-link` | Disable capability |
| GET `/public` | 410: old public catalog removed |
| GET `/{id}/papers` | Any reader (owner, member, valid link); each row has `resolved` (false while the paper is a pending DOI with no metadata) |
| POST `/{id}/papers` | Owner or editor; `{paper_canonical_key}` takes any identifier form, see [Adding and importing papers](#adding-and-importing-papers) |
| DELETE `/{id}/papers/{key}` | Owner or editor; matches the stored key exactly, then its normalized form, so legacy keys stay removable |
| POST `/{id}/import/dois`, `/{id}/import/keys` | Owner or editor; up to 500 lines, returns `ImportResult` |

Account lookup is restricted to owners and uses the existing Redis token bucket,
capacity 20 per hour per owner, fail-closed. Unknown and unverified emails return
the same error. Existing global rate limits still apply; see
[Rate limits](#rate-limits).

## Capability transport and persistence

A link is `/collections/{uuid}#share={token}`. The 32-byte cryptographic random
secret is encoded with URL-safe Base64. The fragment is not sent in HTTP URLs.
The frontend forwards `X-Collection-Share-Token` only to the matching collection's
metadata, papers, graph or personal Zotero sync request. It retains the fragment
for graph/back navigation and uses an internal-only return destination for login.
There is no Web Storage capability persistence.

The database stores SHA-256 for constant-time verification and an AES-GCM copy
using the existing versioned keyring, purpose `collection-read-link`, with the
collection UUID as associated data. Only the owner can recover the link for copying.
Disabling clears both digest and encrypted data. `scripts.rotate_credentials`
re-encrypts links as well as Zotero credentials without changing live URLs.
Personal-data exports exclude all read-link secret fields.

Authorization happens before content or graph-cache access. Collection responses,
collection graphs and collection Zotero responses use `Cache-Control: no-store`.
Application logs use route templates and never serialize capability headers or
response bodies. API CORS allows the dedicated header for configured origins only.

## Writes, cache and personal data

Collection writes and access revocations acquire the same collection row lock
before checking permissions. Metadata updates additionally compare a numeric
revision and return 409 for stale edits. Duplicate paper additions return 409
`already_in_collection`; imports report duplicates per line and use the same
personal-library path as additions.

The collections page, dashboard statistics and paper membership indicators include
individual memberships. The add-to-collection menu filters on `can_edit`.
Opening a collection does not copy it into anyone's personal library. Additions
and imports save only to the acting user's library; personal notes, tags, reading
state and Zotero credentials are never shared.

Read queries have separate in-memory access scopes and are discarded when their
view unmounts. Focus refetches revalidate permissions. A denied read replaces cached
content with an unavailable state; no push/real-time revocation is promised.

## Adding and importing papers

`POST /{id}/papers` and the imports accept a DOI in any common form, an `s2:`
key or semanticscholar.org link, an arXiv ID or link, `pmid:`, `pmcid:PMC…`
or an already cached `hash:` key ([parsing rules](Persistence.md#paper-identifiers)).
Identifiers are resolved before anything is saved, and no provider call runs
while a lock is held. Every add and import runs in three phases:

1. **Authorize and pre-deduplicate.** Lock the collection, check edit rights,
   parse the input strictly, and look for the parsed key, and for the key of a
   paper cached under any of its aliases, in the collection. A 409 or 422 here
   writes nothing. Then commit, which releases the per-user row lock that
   authentication takes on every write and the collection lock.
2. **Resolve** with no transaction open: Semantic Scholar first, and doi.org
   only for DOIs it does not know ([resolution rules](SemanticScholar.md#identifier-resolution-and-pending-dois)).
3. **Write** in a short transaction: lock the user row, then the collection,
   and check edit rights again (an editor removed meanwhile gets 403). Upsert
   the snapshot, check duplicates again against both the parsed key and the
   stored row's key, and insert under the **stored** key. The acting user gets
   a Library entry and version pin under the paper's real group (a synthetic
   group while it is pending).

A paper already cached under any alias needs no provider call: it is inserted
under its stored key at the end of phase 1. An import runs the phases once for
all of its lines.

| Add result | Meaning |
|---|---|
| 201, `resolved: true` | Saved with metadata |
| 201, `resolved: false` | A registered DOI Semantic Scholar cannot describe yet, or a provider failure while resolving a DOI: saved as pending; Retry and Fix identifier recover it |
| 409 `already_in_collection` | Already present under this key or an alias (`canonical_key` names it) |
| 422 `invalid_identifier` | Not an accepted identifier form |
| 422 `doi_not_found` | doi.org says the DOI is not registered |
| 422 `identifier_not_found` | Semantic Scholar has no paper for an `s2:`, arXiv, PMID or PMCID identifier |
| 422 `unknown_paper_key` | A `hash:` key that is not cached |
| 503 `provider_unavailable`, `provider_rate_limited` | A non-DOI identifier could not be resolved now; `Retry-After` given, nothing saved |
| 503 `provider_not_configured`, `provider_key_rejected` | Operator problem, no `Retry-After`, nothing saved |

Imports take up to 500 lines per request (the UI sends chunks of 25). Blank
lines are dropped; every other line gets a result, in input order:

```
ImportResult {added, duplicate, invalid, not_found, unresolved, total,
              skipped (deprecated alias of duplicate),
              results: [{line, input, status, canonical_key, title}]}
```

| Line `status` | Saved | Meaning |
|---|---|---|
| `added` | Yes | Resolved and inserted |
| `duplicate` | No | Repeated in the request, or already in the collection under this key or an alias |
| `invalid` | No | Not an accepted identifier form |
| `not_found` | No | Definitely unknown (an unregistered DOI, a missing `s2:`/arXiv/PMID/PMCID record, an uncached `hash:` key) |
| `unresolved` | Yes, pending | A DOI that could not be described now |
| `unavailable` | No | Any other identifier the provider could not resolve now; retry the line |

`line` is the 1-based position in the request list, `input` is truncated to
200 characters, and `unavailable` lines have no counter field (count them in
`results`). Importing the same list again changes no counts.

## Library delete, detach and resolve

A collection row is only touched through the Library when the caller could
edit that collection directly (`access.editable_by`: the owner or an editor).
The same scope applies to:

- `DELETE /library/entries/{group}`: while a pinned version is still in a
  collection the caller can edit, the delete is refused with 409
  `entry_in_collections` and `collections=[{id, name, is_owner}]`.
  `is_owner: false` marks someone else's collection, where removing the paper
  removes it for every member. `?detach=true` re-locks those collections in
  id order, re-checks edit rights, removes the rows, then deletes the entry.
  Rows in collections the caller can only read never block the delete and are
  never removed.
- Removing a saved version is refused with 409 while that version is in a
  collection the caller can edit.
- `POST /library/resolve` re-keys only the caller's own rows and rows in
  collections they can edit, locked in id order after the provider call. When
  collection rows move, the caller gets a Library entry for them. An editor's
  correction therefore also changes the key in a shared collection; other
  members' Library pins under the old key stay as they were.

## Rate limits

Token buckets in Redis, keyed by scope and pseudonymized identity. All are
fail-closed: with Redis down the request gets 503 with `Retry-After: 30`. The
authentication scopes and the global per-IP limit are not listed here.

| Scope | Limit | Applies to |
|---|---|---|
| `collection-add` | 60 per minute per user | `POST /{id}/papers` |
| `collection-import` | 30 per minute per user | Both import endpoints (each chunk counts) |
| `collection-members` | 20 per hour per owner | `POST /{id}/members` |
| `paper-resolve` | 30 per minute per user | `POST /library/resolve` |
| `paper-lookup` | 60 per minute per user, 20 per IP | Live lookups in `GET /papers/{key}` (cached details are free) |
| `graph-build` | 30 per minute per user, 10 per IP | `GET /graph/collection/{id}` and `GET /graph/library` (signed in only); `GET /graph/paper/{key}` and the legacy `GET /graph/{key}` count 10 per minute per IP. One bucket per identity across these routes |
| `graph-related` | 60 per minute per user, 20 per IP | `POST /graph/related` |
| `graph-expand` | 30 per minute per user, 10 per IP | `POST /graph/related/top-up` |
| `search` | 30 per minute per IP | `GET /papers/search` |
| `zotero-connect` | 10 per hour per user | `PUT /zotero/credentials` |
| `zotero-sync` | 10 per hour per user | Collection and Library sync |

## Migration and local verification

Revision `f8a9b0c1d2e3` preserves UUIDs, papers and memberships; drops visibility;
starts all links disabled; converts non-owner `owner` roles to editor. Downgrade
restores all collections as private rather than reconstructing prior exposure.
Take a database backup before deployment and deploy API/frontend together.

Run the PostgreSQL/Redis backend suite, `scripts.check_migrations`, Ruff checks,
frontend Vitest, ESLint and TypeScript/Vite build. Exercise owner/editor/anonymous
browsers, link refresh and graph navigation, rotation/revocation, personal-library
isolation and responsive sharing UI. External Zotero changes are mocked in tests.
