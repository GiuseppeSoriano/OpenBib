# Security architecture

The application requires a trusted reverse proxy when processing forwarded client addresses. Operators must prevent direct access that could bypass that trust boundary. Local HTTP and example secrets are development-only. Production settings validate HTTPS, secure cookies, token lifetimes, explicit hosts/origin, secret files, SMTP and legal configuration.

## Credentials and sessions

Passwords use Argon2id, 8–128 characters and automatic rehashing when parameters change. Missing-account login performs a dummy password verification; registration, recovery and resend return generic responses. Initial registration uses a six-digit OTP before collecting a password. Pending challenges use a purpose-derived, versioned HMAC and an opaque HttpOnly browser cookie; no account exists until completion. An unverified legacy account can be reclaimed after mailbox verification, replacing its credentials and revoking old sessions/actions. Password recovery and email changes retain random link tokens in URL fragments with SHA-256 digests. See [registration contracts and limits](Architecture/RegistrationOTP.md).

Access JWTs expire after ten minutes and require sub, sid, jti, iat, exp, iss, aud and type=access. The API checks both user and active database session. Refresh tokens contain 256 random bits, rotate at every use and have an absolute seven-day family lifetime. Replay revokes the entire family, including the replacement session. Logout revokes the family; password reset/change, email change and logout-all revoke every user session. The browser never persists either token in localStorage/sessionStorage.

The production cookie is `__Host-openbib_refresh; HttpOnly; Secure; SameSite=Strict; Path=/`, without Domain. Local HTTP uses `openbib_refresh` without Secure. Cookie mutation endpoints require the production Origin; normal CRUD uses Bearer tokens. The frontend collapses concurrent refreshes and uses Web Locks where available to serialize them across tabs.

Zotero API keys, pending email bodies and off-site deletion receipts use AES-256-GCM with random nonces, HKDF-separated purpose keys, and authenticated context containing owner/object, purpose and key version. The versioned keyring is mounted separately from the database. Logs/errors omit credentials, payloads, raw identifiers and query strings. Validation errors do not echo submitted fields.

## Resource limits

Redis executes each token-bucket update atomically. IP/account/email identifiers are keyed HMAC digests, never raw Redis keys. Limits are 100 anonymous or 300 authenticated requests/minute globally; login 10/10 minutes; registration start/resend share 5/hour per IP and email; registration verification and completion each allow 10/10 minutes per IP; recovery 5/hour; refresh 30/5 minutes; public search 30/minute; graph work 10 anonymous or 30 authenticated/minute; Zotero connect/sync 10/hour. Password-protected account operations have an additional 10/10-minute account limit. Limited responses include 429 and Retry-After.

Sensitive authentication, search, graph and Zotero routes fail closed when Redis is unavailable. Normal authenticated CRUD remains available temporarily with a sanitized warning. Bodies are bounded even without Content-Length: 1 MiB generally, 5 MiB for imports. Imports allow 500 identifiers, graph expansion 20 starting keys/200 existing groups/50 results per node, graph construction 200 seeds, descriptions 5,000 characters and notes 50,000.

## Release and incident controls

CI uses frozen Python/npm dependencies, PostgreSQL/Redis tests, migration tests, dependency audits, CodeQL, full-history Gitleaks, image vulnerability gates and SBOMs. Scanner archives are version- and checksum-pinned; do not replace them with an unverified “latest” installer. Image audit failures of medium severity or above block release; any proposed exception needs a recorded human risk decision.

For a suspected leak, restrict traffic, preserve sanitized evidence, revoke affected sessions, rotate the relevant credentials and review the complete Git history. Removing a secret from a file does not revoke it or remove it from existing clones. Report privately using [SECURITY.md](../SECURITY.md). Assess notification obligations with the operator's legal/security adviser; this repository does not automate breach notifications.
