# Privacy operations

Each operator is responsible for their actual service, suppliers, purposes, legal bases, transfers and retention. The official service's legal configuration is maintained separately and mounted read-only in API and frontend. The public frontend contains development-only legal configuration. The bilingual pages at /privacy and /terms describe the product but do not certify legal compliance. Obtain human review before publishing an instance.

Account email/name, password hashes, library/collection content, notes, tags, reading states, preferences and Zotero mappings are required for the selected account features. Search queries and filters go server-side to the selected bibliographic providers; do not submit confidential information in search fields. Connecting Zotero sends the API key to Zotero for validation and user-initiated synchronization sends the selected bibliographic content. SMTP receives recipient addresses and transactional message content.

There are no bundled analytics, advertising tags, heatmaps or external error trackers. The refresh cookie is technical and HttpOnly; browser localStorage is used for theme/language only. No CMP or consent banner is bundled. Adding optional tracking requires a separate privacy assessment and implementation that blocks it until any required consent; do not merely add a banner after loading a tracker.

The account export requires the current password and contains versioned JSON for profile, collection memberships/content, library versions, notes, tags, states, preferences, dismissed items, cached references and Zotero mappings. It excludes password hashes, Zotero secrets, sessions, tokens and security records. BibTeX export is outside this release: reference export remains Zotero-first.

Account deletion requires the password and the text DELETE. Shared collections transfer to the earliest editor, then earliest viewer, with UUID as tie-breaker; collections without another member are deleted. Personal notes and dependent account rows are deleted and surviving collection additions lose their added_by attribution. Already-synchronized Zotero items are not deleted by OpenBib.

Access logs have a 14-day retention and pseudonymized security events 90 days. Backups are operator-configurable: set BACKUPS_ENABLED=false to allow operation without new snapshots and, if no previous snapshots exist, DELETION_JOURNAL_ENABLED=false to remove the S3 dependency. Database loss may then be irreversible; password-protected account export remains available but is not a full recovery backup. The matching legal.json must set backups_enabled=false, deletion_journal_enabled=false and retention.backups_days=0, and list only actual providers. Bump the privacy version and obtain human review when changing this policy.

Existing configurations that omit the new flags retain backups and the deletion journal. Enabled backups require the journal and 30-day retention; the legal flags must match runtime settings. When stopping new backups, keep DELETION_JOURNAL_ENABLED=true and deletion_journal_enabled=true while previous snapshots remain. Deletion receipts and tombstones retain their independent 30-day lifetime. Backup restoration must reapply off-site deletion receipts before reopening the service; replay refuses to run when the journal is disabled. Do not enable S3 versioning or retention rules that silently retain expired personal-data copies.

Maintain an internal record of provider contracts, subprocessors, international-transfer safeguards, access permissions and data-rights requests. Review contact details and document versions whenever these change. Users can contact the configured controller for access, correction, restriction, objection, portability and erasure; evaluate requests and any legal exceptions individually rather than promising that a generic template covers every jurisdiction.

## Localized legal fields

The pages render operator-supplied values inside English or Italian sentences, so every user-visible value in legal.json should carry both languages: `purpose`, `role`, `region` and `transfer_safeguard` of each third party, `data_location`, and `operator.country`. Write each as an object with exactly the keys `en` and `it`; both must be non-empty and no other language key is accepted. A plain string is still valid for backward compatibility, but it is shown unchanged in both languages, and a production API logs a warning listing every field that is still a plain string. `role` may instead stay a plain string when it is one of the identifiers the pages translate themselves: `processor`, `controller`, `independent controller`, `joint controller` or `sub-processor`.

```json
{
  "operator": { "country": { "en": "Italy", "it": "Italia" } },
  "data_location": { "en": "European Union", "it": "Unione europea" },
  "third_parties": [
    {
      "name": "Example Hosting GmbH",
      "purpose": { "en": "Application and database hosting", "it": "Hosting dell'applicazione e del database" },
      "role": "processor",
      "region": { "en": "European Union", "it": "Unione europea" },
      "privacy_url": "https://hosting.test/privacy",
      "transfer_safeguard": { "en": "Standard contractual clauses", "it": "Clausole contrattuali standard" }
    }
  ]
}
```

Do not end these values with a period: the pages place them mid-sentence or add the closing period themselves (trailing `.`, `;` and `:` are dropped when rendered). Updating the code does not translate an existing single-language file; operators must edit the legal.json mounted into both the API and web containers. Converting existing text into equivalent `{en, it}` objects does not change the notice's meaning and needs no `privacy_version` bump; changing the wording does. In production the file is rejected while it still contains template placeholders (`replace-me`, `replace me`, `<your`, `your-`, `todo:` or `example.com`); ordinary English such as "your data" is accepted.
