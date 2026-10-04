# Verification tools

Local helpers for the manual verification pass. Nothing here runs in CI, and none of it is meant for production stacks.

All checks run against the **real Semantic Scholar Graph API**. There is no mock, so you need a key.

## 1. Semantic Scholar API key

Put the key in the repository-root `.env`. That file is gitignored, so never commit it. Write it on one line, with no quotes and no spaces:

```
SEMANTIC_SCHOLAR_API_KEY=<your key>
```

Alternatively, store the key in a file and set `SEMANTIC_SCHOLAR_API_KEY_FILE=/run/secrets/s2_key`. The file takes precedence; mount it into the `api` container.

Every backend service reads `.env` through `env_file`, but only when its container is created. After adding or changing the key, recreate the containers:

```bash
docker compose up -d --force-recreate api
```

To check that the key is present without printing it, run `grep -c '^SEMANTIC_SCHOLAR_API_KEY=.' .env`. It should print `1`.

With no key, every paper request fails with 503 `provider_not_configured` ("Configure SEMANTIC_SCHOLAR_API_KEY…"). With a key that Semantic Scholar refuses (401/403), it fails with 503 `provider_key_rejected`. `responsive_check.py` reports both as `G-provider-config` failures, never as skips. With a valid key, Semantic Scholar rate-limits the calls, and a 429 becomes 503 `provider_rate_limited`. The adapter also paces itself to one call every 2 s per process, so keep request volume small.

## 2. Bring the stack up

```bash
docker compose up --build -d
curl -fsS http://localhost:8000/api/health
curl -fsS http://localhost:3000/ >/dev/null
docker compose logs migrate | tail -20   # shows the paper-key repair counts
```

## 3. Seed verified users (`seed_audit_user.py`)

This script uses the standard library only and runs with the host's Python 3.10+.

For each `--email`, it does the following:
1. It logs in if the account already exists.
2. Otherwise, it runs the real OTP registration flow:
   - `POST /api/v1/auth/registration/start`;
   - it polls the Mailpit API for a new message and extracts the code with `(?m)^(\d{6})$`;
   - `POST /verify` with the registration cookie;
   - `POST /complete` with `terms_version` and `privacy_version` from `/legal.json`.
3. It logs in and prints `email<TAB>user id<TAB>registered|existing`.

```bash
python tools/seed_audit_user.py --password correct-horse-battery-2 \
    --email audit@example.com --email audit-new@example.com --email editor@example.com \
    --seed audit@example.com --share-with editor@example.com
```

`--seed EMAIL` then runs this inside the `api` container:

```bash
docker compose exec -T api python -m scripts.seed_demo_library --email EMAIL \
    --papers 400 --collections 4 --long-data [--share-with EMAIL] [--reset]
```

This command adds synthetic `10.5555` papers. It makes no provider calls. With `--share-with`, the editor is added and the read link is printed.

| Option | Default |
|---|---|
| `--base-url` / `BASE_URL` | `http://localhost:3000` (the `web` container: `/legal.json` and the `/api` proxy) |
| `--mailpit-url` / `MAILPIT_URL` | `http://localhost:8025` |
| `--password` / `AUDIT_PASSWORD` | required, 8 characters or more, shared by all `--email` accounts |
| `--timeout` | 60 s to wait for each code (the mail-worker polls every few seconds) |

Limits:
- Registration sends are limited to 5 per hour, per IP and per email.
- Logins are limited to 10 per 10 minutes.

To clear the limits between heavy runs:

```bash
docker compose exec -T cache sh -c "redis-cli --scan --pattern 'rate:*' | xargs -r redis-cli del"
```

## 4. Live smoke checks

Keep the volume small. Each request below is one or two Semantic Scholar calls.

```bash
API=http://localhost:3000/api/v1
curl -sS "$API/papers/search?q=graph%20neural%20networks"           # "source": "semantic_scholar"; items carry provider_source
curl -sS "$API/papers/doi%3A10.1109%2Ftnn.2008.2005605"             # "The Graph Neural Network Model"
```

`POST /graph/related` works anonymously. Take `paper_group_key` from the details response above:

```bash
curl -sS -X POST "$API/graph/related" -H 'Content-Type: application/json' \
  -d '{"source_key":"doi:10.1109/tnn.2008.2005605","source_group_key":"<paper_group_key>","direction":"cited_by","order":"cited_by_count"}'
```

The response is a `RelatedRangeResponse`. While the citer snapshot is still being collected, it has `reason: "ranking"` and no nodes yet; repeat the call after a few seconds. Once ranked, it has the range itself (`nodes`, `range_start`, `range_end`, `provider_total`).

## 5. Responsive and accessibility pass (`responsive_check.py`)

A Playwright (Python, sync API) regression script for the audit's F03–F10 and S01–S08 findings. **It is not a CI job.** It drives the running stack in a real browser, and every search, paper lookup and graph range goes to the **real Semantic Scholar API** through the `api` container. Run it by hand, after the steps above, against a local stack only (it reads and clears local rate-limit keys if asked).

### Prerequisites

- `.env` with a real `SEMANTIC_SCHOLAR_API_KEY` (section 1), and the stack up (section 2).
- Seeded accounts and data (section 3): `audit@example.com` with `--seed` (400 papers, 4 collections, `--long-data`), `audit-new@example.com` (left empty, for the Get started check) and `editor@example.com` (`--share-with`).
- The official image, pinned: `mcr.microsoft.com/playwright/python:v1.55.0-noble`. It ships the browsers but not the `playwright` Python package, so the command below installs the matching `playwright==1.55.0` first.

```bash
docker pull mcr.microsoft.com/playwright/python:v1.55.0-noble
```

### Run

The container shares the `web` container's network namespace, so the app is at `http://localhost:8080` (nginx inside `web`) and the Redis host `cache` resolves through compose DNS. In Git Bash, prefix the command with `MSYS_NO_PATHCONV=1`.

```bash
WEB=$(docker compose ps -q web)
SHOTS="${TMPDIR:-/tmp}/openbib-shots"   # outside the repository: screenshots show signed-in pages
mkdir -p "$SHOTS"
docker run --rm --init --ipc=host --network container:$WEB \
  -v "$PWD/tools:/tools" -v "$SHOTS:/shots" \
  -e BASE_URL=http://localhost:8080 \
  mcr.microsoft.com/playwright/python:v1.55.0-noble \
  sh -c "pip install -q --root-user-action=ignore playwright==1.55.0 && \
         python /tools/responsive_check.py --out /shots \
           --viewport 390x844 --viewport 1440x900 \
           --email audit@example.com --password correct-horse-battery-2 --clear-rate-limits"
```

| Option | Meaning |
|---|---|
| `--viewport WxH` | Repeatable. `all` = 320x568, 360x800, 390x844, 430x932, 768x1024, 1024x768, 1440x900, 844x390. Default: 390x844 and 1440x900. |
| `--themes light,dark` / `--langs en,it` | Theme and language, set through `localStorage` before the app loads. |
| `--text-scale 1,2` | `2` sets the root font size to 200% (CSSOM, so the strict CSP still applies). |
| `--safe-area 34` | Sets `--safe-area-bottom: 34px` on `:root`, simulating an iPhone home indicator. |
| `--browser chromium\|webkit` | WebKit is a best-effort Safari proxy. |
| `--only ID,...` | Check ids or prefixes, e.g. `--only F04,S01-select`. |
| `--clear-rate-limits` | Deletes the app's `rate:*` keys in Redis (`--redis cache:6379`) before each login. Needed for long matrices: logins are limited to 10 per 10 minutes and `/auth/refresh` to 30 per 5 minutes, per IP. |
| `--provider-pause S` | Pause after each provider-heavy check (default 2 s). |

Touch viewports (width ≤ 430, 768x1024 and 844x390) get `has_touch` and `is_mobile`. Each variant uses one anonymous context and one signed-in context (one UI login), plus a context for the legal fixture and one for `audit-new`. Navigation inside a context is in-app (`history.pushState`), so the refresh limit is rarely hit.

Functional checks (S01, S02, S05, DOI-UI, F06, F07, F08, S07, S08) run once per viewport, in light-en at 1x. Layout checks (G-*, F03, F04, F05, F09, F10, LONG, contrast) run in every variant. The suggested matrix from the plan:

```bash
# all viewports, light-en and dark-it at 1x
... --viewport all --themes light --langs en
... --viewport all --themes dark --langs it --only G-,F03,F04,F05,F09,F10,LONG,contrast
# 2x text on the scaled viewports
... --viewport 320x568 --viewport 390x844 --viewport 844x390 --viewport 1440x900 --text-scale 2 --only G-,F03,F04,F10,LONG
# WebKit as a Safari proxy, with a home-indicator inset
... --browser webkit --viewport 390x844 --viewport 844x390 --safe-area 34
```

### What it changes

Most checks only read. These write to the seeded `audit@example.com` data, and stay rerunnable:
- **DOI-UI** adds `10.1109/tnn.2008.2005605` to *Demo collection 3*. If it is already there, the check removes it first.
- **S05** imports the GNN DOI and a demo DOI into *Demo collection 2*. A second run reports them as already present.
- **F07** signs out at the end of the signed-in phase.

### Reading the report

`/shots/report.json` has `summary` (`pass`, `fail`, `skip`, and `skip_provider`: the skips the provider caused), `failures`, `provider_events` (every provider error the stack returned, with its body), `app_rate_limit_events`, `stack_error_events` and `results`. Each result has `check`, `variant` (`{viewport}-{theme}-{lang}-{scale}x`), `page`, `status` and `details`; failing details list `failures` and often a `screenshot`. Screenshots are named `{viewport}-{theme}-{lang}-{scale}-{page}.png`. The exit code is 1 when any check failed, 2 when none failed but some were skipped because of the provider (the run is not fully verified), and 0 otherwise.

`skip` means the check could not judge the product: wrong viewport for the check, missing seed data, or **"skipped: provider rate limited or unavailable during the check"**. That last case applies only when every error seen during the check was transient provider trouble, recognised from the response body: `provider_rate_limited`, `provider_unavailable` or `provider_bad_response` (502/503, or a 429 naming the provider), or a `/graph/related` 503 `related_provider_unavailable` whose `reason` is an outage, a timeout or a rate limit. Rerun those checks later, with `--only` and a larger `--provider-pause`. The backend caches search pages, paper metadata and ranking snapshots, so reruns make far fewer provider calls.

These are never skips:
- `provider_not_configured` and `provider_key_rejected` (or `reason: not_configured`): a `G-provider-config` failure, and the run prints a hint to fix the key.
- Any other 5xx, such as a 500 from an OpenBib bug or an nginx 502/504 from a stopped `api` container: a `G-stack-error` failure.
- A bare 429 from OpenBib's own limiter: a `G-ratelimit` failure.

Check ids: `G-overflow`, `G-h1`, `G-console`, `F03-footer`, `F03-actions`, `F10-targets`, `F10-edges`, `F04-header`, `F04-sheet`, `F04-desktop`, `F05-dialog`, `S01-select`, `S01-deep`, `S01-pins`, `S01-resize`, `S01-fail`, `F06`, `F07`, `F08`, `F09` (with `tools/responsive_fixtures/legal.json`), `S02-search`, `S02-library`, `S02-perf`, `S03`, `S04`, `S05`, `S06`, `S07`, `S08`, `DOI-UI`, `LONG`, `contrast`, `G-ratelimit` (OpenBib's own limiter answered 429; listed in `app_rate_limit_events`), `G-provider-config` (missing or rejected key), `G-stack-error` (listed in `stack_error_events`) and `G-sticky` (search opens at the top with the status line clear of the sticky field; `scrollIntoView`, focus and Tab targets land just below it, also at 62.5% and 75% text).

### Verified variants

Each variant below was run once against the live stack and the real Semantic Scholar API (2026-10-03). The script ran without errors in each of them. The failures it reports are product issues.

| Variant | Checks | Result |
|---|---|---|
| Chromium, 390x844 and 1440x900, light-en, 1x | `S01-select`, `S01-deep` (with `capped-10000` and `canvas-tap`) | 8 pass, 0 fail |
| Chromium, 390x844 and 1440x900, light-en, 1x | `G-overflow`, `LONG`, `F04`, `F03`, `F09` | 55 pass, 3 fail, 2 skip: the graph header seed title at 390 and the AddToCollectionMenu long name |
| Chromium, 390x844, dark-it, 2x text, `--safe-area 34` | `F04`, `F09`, `F10`, `G-overflow`, `G-h1`, `LONG` | 34 pass, 8 fail, 1 skip: header, graph header, Library, collection and Settings overflow at 2x |
| WebKit, 390x844, light-en, 1x | `F04`, `F10`, `G-*`, `S02-perf` | 54 pass, 1 fail, 1 skip; `S02-perf` notes that WebKit has no `longtask` API |

Not covered here: real iOS and Android devices, the on-screen keyboard, native pinch and pan, and screen readers. The accessible names are only checked in the DOM.
