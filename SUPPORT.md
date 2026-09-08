# OpenBib Support

OpenBib is maintained as an open source alpha project. Community support is best-effort and no response-time guarantee is provided.

## Before asking for help

1. Read the [README](README.md), especially the quick-start and configuration sections.
2. Search the [existing issues](https://github.com/GiuseppeSoriano/OpenBib/issues) for the same symptom.
3. Confirm that you are using the latest `main` revision.
4. Run `docker compose ps` and inspect relevant logs with `docker compose logs --tail 200 api web db cache`.
5. Remove secrets, access tokens, API keys, personal bibliographic data, and private URLs before sharing output.

If the problem persists, open a question or bug report using the repository's [issue chooser](https://github.com/GiuseppeSoriano/OpenBib/issues/new/choose). Include your operating system, browser, Docker/Python/Node versions, the exact command you ran, relevant sanitized logs, and a minimal reproduction.

Feature ideas belong in the feature-request form. Security vulnerabilities must follow [SECURITY.md](SECURITY.md) and must never be posted publicly.
