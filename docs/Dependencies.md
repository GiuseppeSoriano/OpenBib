# Dependency maintenance

Routine Dependabot updates are grouped into backend maintenance, React runtime/types, frontend build/lint tooling, application images and GitHub Actions. Related packages must be upgraded together; do not bypass npm peer resolution with `--force` or `--legacy-peer-deps`.

The reviewed baseline uses Node 24, Python 3.12, React 18, Vite 6 and ESLint 9. Framework and runtime release-line changes need a dedicated migration PR with matching CI and image runtimes. Routine package updates are limited to minor/patch releases and image updates to patches/digests. The `allow.update-types` filter affects version updates, not security updates; security upgrades may still propose a new major and must be assessed promptly. See [Dependabot's option reference](https://docs.github.com/en/code-security/reference/supply-chain-security/dependabot-options-reference#update-types-allow).

Require clean frozen installs, the complete test suites, frontend lint/type/build, Python/npm audits and image vulnerability gates before merging. CI checks that Python, Node and uv versions agree between workflows and Docker images. Human review and branch protection remain mandatory; no auto-merge is enabled here.
