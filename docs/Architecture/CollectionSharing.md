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

Account lookup is restricted to owners and uses the existing Redis token bucket,
capacity 20 per hour per owner, fail-closed. Unknown and unverified emails return
the same error. Existing global rate limits still apply.

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
revision and return 409 for stale edits. Duplicate paper additions return 409;
bulk imports skip duplicates and use the same personal-library path as additions.

The collections page, dashboard statistics and paper membership indicators include
individual memberships. The add-to-collection menu filters on `can_edit`.
Opening a collection does not copy it into anyone's personal library. Additions
and imports save only to the acting user's library; personal notes, tags, reading
state and Zotero credentials are never shared.

Read queries have separate in-memory access scopes and are discarded when their
view unmounts. Focus refetches revalidate permissions. A denied read replaces cached
content with an unavailable state; no push/real-time revocation is promised.

## Migration and local verification

Revision `f8a9b0c1d2e3` preserves UUIDs, papers and memberships; drops visibility;
starts all links disabled; converts non-owner `owner` roles to editor. Downgrade
restores all collections as private rather than reconstructing prior exposure.
Take a database backup before deployment and deploy API/frontend together.

Run the PostgreSQL/Redis backend suite, `scripts.check_migrations`, Ruff checks,
frontend Vitest, ESLint and TypeScript/Vite build. Exercise owner/editor/anonymous
browsers, link refresh and graph navigation, rotation/revocation, personal-library
isolation and responsive sharing UI. External Zotero changes are mocked in tests.
