# Changelog

## Unreleased — public-release hardening

Backups can be explicitly disabled without disabling authenticated SMTP, account deletion or other production security checks. Legal configuration and bilingual privacy pages disclose the selected policy; previous configurations retain backup/deletion-journal protection. An independently enabled deletion journal can protect previous snapshots while new backups are suspended.

Breaking alpha API changes remain under /api/v1. Registration now returns 202 and requires legal versions; verification requires the email token and final new_password. Login/verification return only a short-lived access token. Refresh consumes/rotates an HttpOnly cookie without a request body; refresh_token is no longer returned in JSON. Logout is server-side and asynchronous in the client.

Account lifecycle endpoints add verification/resend, forgot/reset password, verified email change, password change, logout-all, legal acceptance, password-protected JSON export and password-confirmed deletion. Direct email editing and unauthenticated deletion are removed. UserRead adds email_verified and legal_acceptance_required. Collection responses expose capabilities rather than owner_id.

Zotero credentials migrate transactionally from plaintext to versioned authenticated encryption. The schema adds sessions, action tokens, encrypted email outbox, deletion tombstones, legal/verification timestamps and membership joined_at. Downgrade beyond encryption requires an isolated pre-migration backup restore.

The application gains secret-file configuration, Redis token buckets, body/input bounds, an encrypted email outbox, legal pages, account portability, deletion-replay support and expanded security CI. Local development includes Mailpit and loopback-only ports. No analytics, tracker or cookie banner is introduced.

The repository includes application source, local development tooling, tests and community documentation. Contributions follow the pull-request review and automated checks described in CONTRIBUTING.md.
