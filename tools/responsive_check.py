"""Responsive and accessibility regression pass for OpenBib (Playwright, sync API).

Local verification helper, not a CI job. It drives a running stack whose data
comes from the REAL Semantic Scholar API (no mock), so provider rate limits
are expected: a check that fails while the stack answered a transient provider
error (``provider_rate_limited``, ``provider_unavailable``, ``provider_bad_response``,
or a ``related_provider_unavailable`` outage, timeout or rate limit) is reported as
``skip``, with the details kept. A missing or rejected key
(``provider_not_configured``, ``provider_key_rejected``) and any other 5xx are
failures, never skips.

Run it inside the official Playwright image sharing the ``web`` container's
network namespace (see tools/README.md):

    docker run --rm --init --ipc=host --network container:$(docker compose ps -q web) \\
      -v "$PWD/tools:/tools" -v "$TMPDIR/openbib-shots:/shots" \\
      -e BASE_URL=http://localhost:8080 \\
      mcr.microsoft.com/playwright/python:v1.55.0-noble \\
      python /tools/responsive_check.py --out /shots --viewport 390x844 --viewport 1440x900 \\
        --email audit@example.com --password correct-horse-battery-2 --clear-rate-limits

Output: ``<out>/report.json`` (one entry per check and variant: pass, fail or
skip, with details) and ``{viewport}-{theme}-{lang}-{scale}-{page}.png``
screenshots. The exit code is 1 when any check failed, 2 when none failed but
some were skipped because of the provider (the run is then not fully verified).
"""

from __future__ import annotations

import argparse
import contextlib
import json
import os
import re
import socket
import sys
import time
import traceback
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import parse_qs, quote, urlparse

from playwright.sync_api import Error as PlaywrightError
from playwright.sync_api import Page, sync_playwright

ALL_VIEWPORTS = (
    "320x568",
    "360x800",
    "390x844",
    "430x932",
    "768x1024",
    "1024x768",
    "1440x900",
    "844x390",
)
GNN_KEY = "doi:10.1109/tnn.2008.2005605"
GNN_DOI = "10.1109/tnn.2008.2005605"
GNN_TITLE = "The Graph Neural Network Model"
# Decision 4 (G15): a paper with more than 10,000 citers shows the capped label. (The plan's
# doi:10.1038/nature14539 is not found by DOI on Semantic Scholar; ResNet has ~240,000 citers.)
CAPPED_KEY = "doi:10.1109/cvpr.2016.90"
CAPPED_LABEL_RE = re.compile(
    r"first 10,000 returned by Semantic Scholar \(about ([\d,]+) in all\)"
    r"|primi 10\.000 restituiti da Semantic Scholar \(circa ([\d.]+) in tutto\)"
)
GNN_FIGSHARE = "figshare.com/articles/journal_contribution/The_graph_neural_network_model"
SEARCH_Q = "graph neural networks"
NO_MATCH_Q = "zzzzopenbibauditnomatch928374"
# F07 submits a query other than SEARCH_Q: the Search tab restores the last search, and
# resubmitting the same query must not add a history entry.
F07_Q = "graph neural network"
LONG_COLLECTION_PREFIX = "Long data check"
LONG_TITLE_START = "On "
VERSIONS_TITLE = "Scaling laws for citation graphs"
HTML_ABSTRACT_TITLE = "PharmaGNN"
UNRESOLVED_MARKER = "openbib-demo.unresolved"
# Strings that only the Italian side of tools/responsive_fixtures/legal.json has.
IT_FIXTURE_STRINGS = (
    "Ricerca dei metadati bibliografici",
    "Stati Uniti d'America",
    "Clausole contrattuali tipo",
    "Spazio economico europeo",
)
EN_FIXTURE_STRINGS = ("Bibliographic metadata, citation", "United States of America")
FIXTURE = Path(__file__).resolve().parent / "responsive_fixtures" / "legal.json"
TOUCH_MIN = 44
LONG_TASK_LIMIT_MS = 200
# Error bodies (``{"detail": {"code": ..., "reason": ...}}``) of transient provider trouble,
# and of a missing or rejected Semantic Scholar key.
PROVIDER_TRANSIENT_RE = re.compile(
    r'"(?:code|reason)"\s*:\s*"(?:provider_rate_limited|provider_unavailable'
    r'|provider_bad_response|rate_limited|timeout)"'
)
PROVIDER_CONFIG_RE = re.compile(
    r'provider_not_configured|provider_key_rejected|"reason"\s*:\s*"not_configured"'
)

CHECK_IDS = (
    "G-overflow", "G-h1", "G-console", "F03-footer", "F03-actions", "F10-targets",
    "F10-edges", "F04-header", "F04-sheet", "F04-desktop", "F05-dialog", "S01-select",
    "S01-deep", "S01-pins", "S01-resize", "S01-fail", "F06", "F07", "F08",
    "F09", "S02-search", "S02-library", "S02-perf", "S03", "S04", "S05", "S06", "S07",
    "S08", "DOI-UI", "LONG", "contrast", "G-ratelimit", "G-provider-config",
    "G-stack-error", "G-sticky",
)  # fmt: skip


def classify_problem(status: int, body: str) -> str:
    """``provider`` (transient, a skip), ``provider_config`` (no or rejected key),
    ``app_rate_limit`` (OpenBib's own bare 429) or ``stack_error`` (anything else)."""
    if PROVIDER_CONFIG_RE.search(body):
        return "provider_config"
    if status in (429, 502, 503, 504) and PROVIDER_TRANSIENT_RE.search(body):
        return "provider"
    if status == 429:
        return "app_rate_limit"
    return "stack_error"


class Skip(Exception):  # noqa: N818 - reads as "raise Skip(reason)"
    """A check that cannot run here (no data, wrong viewport, provider limits)."""


@dataclass
class Variant:
    viewport: str
    theme: str
    lang: str
    scale: int
    browser: str
    safe_area: int

    @property
    def width(self) -> int:
        return int(self.viewport.split("x")[0])

    @property
    def height(self) -> int:
        return int(self.viewport.split("x")[1])

    @property
    def touch(self) -> bool:
        return self.width <= 430 or self.viewport in ("768x1024", "844x390")

    @property
    def compact(self) -> bool:
        """Mirror of COMPACT_QUERY: (max-width: 639px), (max-height: 500px)."""
        return self.width <= 639 or self.height <= 500

    @property
    def phone(self) -> bool:
        return self.width <= 639

    @property
    def name(self) -> str:
        return f"{self.viewport}-{self.theme}-{self.lang}-{self.scale}x"

    @property
    def functional(self) -> bool:
        """Functional checks run once per viewport, in light-en at 1x."""
        return self.theme == "light" and self.lang == "en" and self.scale == 1


def parse_args(argv=None) -> argparse.Namespace:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawTextHelpFormatter)
    p.add_argument("--base-url", default=os.environ.get("BASE_URL", "http://localhost:8080"))
    p.add_argument("--viewport", action="append", help="WxH, repeatable, or 'all'")
    p.add_argument("--themes", default="light")
    p.add_argument("--langs", default="en")
    p.add_argument("--text-scale", default="1", help="comma list of 1 and/or 2 (root font 200%%)")
    p.add_argument("--browser", default="chromium", choices=("chromium", "webkit"))
    p.add_argument("--only", default="", help="comma list of check ids or id prefixes")
    p.add_argument("--out", default=os.environ.get("OUT_DIR", "shots"))
    p.add_argument("--email", default=os.environ.get("AUDIT_EMAIL", "audit@example.com"))
    p.add_argument("--password", default=os.environ.get("AUDIT_PASSWORD"))
    p.add_argument("--new-email", default=os.environ.get("NEW_EMAIL", "audit-new@example.com"))
    p.add_argument("--safe-area", type=int, default=0, help="px for --safe-area-bottom (e.g. 34)")
    p.add_argument(
        "--clear-rate-limits",
        action="store_true",
        help="delete the app's rate:* keys in Redis before each login (local stacks only)",
    )
    p.add_argument("--redis", default=os.environ.get("REDIS_HOSTPORT", "cache:6379"))
    p.add_argument(
        "--provider-pause", type=float, default=2.0, help="s between provider-heavy steps"
    )
    p.add_argument("--headed", action="store_true")
    args = p.parse_args(argv)
    views = args.viewport or ["390x844", "1440x900"]
    args.viewports = list(ALL_VIEWPORTS) if "all" in views else views
    for view in args.viewports:
        if not re.fullmatch(r"\d+x\d+", view):
            p.error(f"bad --viewport {view!r}")
    args.theme_list = [t for t in args.themes.split(",") if t]
    args.lang_list = [lang for lang in args.langs.split(",") if lang]
    args.scale_list = [int(s) for s in args.text_scale.split(",") if s]
    args.only_list = [c.strip() for c in args.only.split(",") if c.strip()]
    unknown = [o for o in args.only_list if not any(c.startswith(o) for c in CHECK_IDS)]
    if unknown:
        p.error(f"unknown --only ids {unknown}; known: {', '.join(CHECK_IDS)}")
    if not args.password:
        p.error("--password (or AUDIT_PASSWORD) is required")
    return args


# --------------------------------------------------------------------------- utilities


def clear_rate_limits(hostport: str) -> int:
    """Delete ``rate:*`` keys over a raw RESP connection (no redis client in the image)."""
    host, _, port = hostport.partition(":")

    def command(sock, *parts):
        payload = f"*{len(parts)}\r\n" + "".join(f"${len(p.encode())}\r\n{p}\r\n" for p in parts)
        sock.sendall(payload.encode())
        return read_reply(sock.makefile("rb"))

    def read_reply(f):
        line = f.readline().rstrip(b"\r\n")
        kind, rest = line[:1], line[1:]
        if kind in (b"+", b"-"):
            return rest.decode()
        if kind == b":":
            return int(rest)
        if kind == b"$":
            size = int(rest)
            if size < 0:
                return None
            data = f.read(size + 2)[:-2]
            return data.decode()
        if kind == b"*":
            return [read_reply(f) for _ in range(int(rest))]
        raise RuntimeError(f"unexpected RESP reply {line!r}")

    deleted = 0
    with socket.create_connection((host, int(port or 6379)), timeout=5) as sock:
        cursor = "0"
        while True:
            cursor, keys = command(sock, "SCAN", cursor, "MATCH", "rate:*", "COUNT", "500")
            if keys:
                deleted += command(sock, "DEL", *keys)
            if cursor == "0":
                return deleted


def parse_color(value: str):
    m = re.match(r"rgba?\(([^)]+)\)", value or "")
    if not m:
        return None
    parts = [float(x) for x in re.split(r"[,\s/]+", m.group(1).strip()) if x]
    alpha = parts[3] if len(parts) > 3 else 1.0
    return parts[0], parts[1], parts[2], alpha


def blend(fg, bg):
    r, g, b, a = fg
    return (r * a + bg[0] * (1 - a), g * a + bg[1] * (1 - a), b * a + bg[2] * (1 - a), 1.0)


def luminance(rgb) -> float:
    def channel(c):
        c = c / 255
        return c / 12.92 if c <= 0.03928 else ((c + 0.055) / 1.055) ** 2.4

    return 0.2126 * channel(rgb[0]) + 0.7152 * channel(rgb[1]) + 0.0722 * channel(rgb[2])


def contrast(a, b) -> float:
    la, lb = sorted((luminance(a), luminance(b)), reverse=True)
    return round((la + 0.05) / (lb + 0.05), 2)


def rect_overlap(a, b, tolerance=0.5) -> bool:
    return (
        a["x"] + tolerance < b["x"] + b["width"]
        and b["x"] + tolerance < a["x"] + a["width"]
        and a["y"] + tolerance < b["y"] + b["height"]
        and b["y"] + tolerance < a["y"] + a["height"]
    )


def norm_title(text: str) -> str:
    return re.sub(r"\s+", " ", text or "").strip().lower()[:60]


class Report:
    def __init__(self, out: Path, args: argparse.Namespace):
        self.out = out
        self.started = time.strftime("%Y-%m-%dT%H:%M:%S")
        self.args = {
            k: v for k, v in vars(args).items() if k not in ("password", "only_list", "viewport")
        }
        self.results: list[dict] = []
        self.provider_events: list[dict] = []
        self.app_events: list[dict] = []
        self.stack_events: list[dict] = []

    def add(self, check, variant, status, details, page=None):
        entry = {"check": check, "variant": variant.name if variant else "-", "status": status}
        if page:
            entry["page"] = page
        entry["details"] = details
        self.results.append(entry)
        mark = {"pass": ".", "fail": "F", "skip": "s"}[status]
        where = f" {page}" if page else ""
        print(f"[{mark}] {entry['variant']} {check}{where}: {summarise(details)}", flush=True)

    def write(self):
        counts = {
            s: sum(1 for r in self.results if r["status"] == s) for s in ("pass", "fail", "skip")
        }
        # Skips the provider caused (the check could not be verified), apart from the
        # not-applicable ones.
        counts["skip_provider"] = sum(
            1 for r in self.results if r["status"] == "skip" and "provider_events" in r["details"]
        )
        data = {
            "started": self.started,
            "finished": time.strftime("%Y-%m-%dT%H:%M:%S"),
            "options": self.args,
            "summary": counts,
            "failures": [r for r in self.results if r["status"] == "fail"],
            "provider_events": self.provider_events,
            "app_rate_limit_events": self.app_events,
            "stack_error_events": self.stack_events,
            "results": self.results,
        }
        (self.out / "report.json").write_text(json.dumps(data, indent=2, default=str), "utf-8")
        return counts


def summarise(details) -> str:
    if isinstance(details, dict):
        if details.get("failures"):
            return "; ".join(str(f) for f in details["failures"])[:300]
        if details.get("reason"):
            return str(details["reason"])[:300]
        return "ok"
    return str(details)[:300]


# --------------------------------------------------------------------------- browser session

INIT_SCRIPT = """
(([theme, lang, scale, safe]) => {
  try { localStorage.setItem('openbib.theme', theme); localStorage.setItem('openbib.lang', lang); }
  catch (e) {}
  // CSSOM writes are allowed by the strict CSP (no <style> or style attributes).
  const apply = () => {
    const root = document.documentElement;
    if (!root) return false;
    if (scale !== 1) root.style.fontSize = (scale * 100) + '%';
    if (safe) root.style.setProperty('--safe-area-bottom', safe + 'px');
    return true;
  };
  if (!apply()) document.addEventListener('readystatechange', apply, { once: true });
  window.__longTasks = [];
  window.__longTaskSupported = !!(window.PerformanceObserver
    && (PerformanceObserver.supportedEntryTypes || []).includes('longtask'));
  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) window.__longTasks.push(Math.round(entry.duration));
    }).observe({ type: 'longtask', buffered: true });
  } catch (e) {}
})
"""

SPA_NAV = """(path) => {
  const idx = history.state && typeof history.state.idx === 'number' ? history.state.idx : 0;
  const key = Math.random().toString(36).slice(2, 10);
  history.pushState({ usr: null, key, idx: idx + 1 }, '', path);
  dispatchEvent(new PopStateEvent('popstate', { state: history.state }));
}"""


class Session:
    """One browser context (one login at most) with request and console trackers."""

    def __init__(self, runner, variant: Variant, label: str):
        self.runner = runner
        self.args = runner.args
        self.variant = variant
        self.label = label
        options = {
            "viewport": {"width": variant.width, "height": variant.height},
            "color_scheme": variant.theme,
            "locale": "it-IT" if variant.lang == "it" else "en-US",
            "has_touch": variant.touch,
            "base_url": self.args.base_url,
        }
        if variant.touch and variant.browser == "chromium":
            options["is_mobile"] = True
        self.context = runner.browser.new_context(**options)
        self.context.add_init_script(
            script=f"{INIT_SCRIPT}({json.dumps([variant.theme, variant.lang, variant.scale, variant.safe_area])})"
        )
        self.requests: list[dict] = []
        self.inflight: set = set()
        self.console: list[dict] = []
        self.problems: list[dict] = []
        self.related: list[dict] = []
        self.console_paused = False
        self.loaded = False
        self.signed_in = False
        self.page = self._attach(self.context.new_page())

    def _attach(self, page: Page) -> Page:
        page.set_default_timeout(15000)
        page.on("request", self._on_request)
        page.on("requestfinished", lambda r: self.inflight.discard(id(r)))
        page.on("requestfailed", lambda r: self.inflight.discard(id(r)))
        page.on("response", self._on_response)
        page.on("console", self._on_console)
        page.on("pageerror", lambda e: self._console_error(f"pageerror: {e}", ""))
        return page

    def new_tab(self):
        """A fresh tab in the same context: Chromium caps history.length at 50."""
        old = self.page
        self.page = self._attach(self.context.new_page())
        self.inflight.clear()
        self.loaded = False
        old.close()

    # trackers ---------------------------------------------------------------
    def _on_request(self, request):
        if request.resource_type in ("fetch", "xhr"):
            self.inflight.add(id(request))
            if "/api/" in request.url:
                try:
                    post = request.post_data
                except Exception:  # binary bodies
                    post = None
                self.requests.append(
                    {"t": time.time(), "method": request.method, "url": request.url, "post": post}
                )

    def _on_response(self, response):
        url = response.url
        if "/api/v1/graph/related" in url and response.request.method == "POST":
            self.related.append(
                {
                    "t": time.time(),
                    "url": url,
                    "status": response.status,
                    "response": response,
                    "post": response.request.post_data,
                }
            )
        if "/api/" in url and (response.status == 429 or response.status >= 500):
            self.problems.append(
                {"t": time.time(), "url": url, "status": response.status, "response": response}
            )

    def _on_console(self, msg):
        if msg.type != "error":
            return
        location = (msg.location or {}).get("url", "")
        self._console_error(msg.text, location)

    def _console_error(self, text, location):
        if self.console_paused:
            return
        if "/auth/refresh" in location and "401" in text:
            return  # the expected startup refresh of an anonymous visit
        if re.search(r"status of (429|5\d\d)", text) and "/api/" in location:
            return  # recorded (and classified) through problems
        self.console.append({"t": time.time(), "text": text[:400], "url": location})

    def mark(self) -> dict:
        return {"req": len(self.requests), "con": len(self.console), "prob": len(self.problems)}

    def requests_since(self, mark, pattern: str, method: str | None = None) -> list[dict]:
        return [
            r
            for r in self.requests[mark["req"] :]
            if re.search(pattern, r["url"]) and (method is None or r["method"] == method)
        ]

    def provider_trouble_since(self, mark) -> list[dict]:
        events = []
        for item in self.problems[mark["prob"] :]:
            if "event" not in item:
                body = ""
                with contextlib.suppress(Exception):  # the body may be gone after navigation
                    body = item["response"].text()[:300]
                kind = classify_problem(item["status"], body)
                item["event"] = {
                    "url": item["url"],
                    "status": item["status"],
                    "body": body,
                    "kind": kind,
                }
                report = self.runner.report
                target = {
                    "provider": report.provider_events,
                    "provider_config": report.provider_events,
                    "app_rate_limit": report.app_events,
                }.get(kind, report.stack_events)
                target.append({"variant": self.variant.name, **item["event"]})
            events.append(item["event"])
        return events

    # navigation -------------------------------------------------------------
    def goto(self, path: str, settle=True):
        self.page.goto(path, wait_until="domcontentloaded")
        self.loaded = True
        if settle:
            self.settle()

    def nav(self, path: str, settle=True):
        """In-app navigation (no reload), sparing the /auth/refresh rate limit."""
        if not self.loaded:
            return self.goto(path, settle)
        self.close_overlays()
        self.page.evaluate(SPA_NAV, path)
        self.page.wait_for_timeout(150)
        if settle:
            self.settle()

    def reload(self):
        self.page.reload(wait_until="domcontentloaded")
        self.settle()

    def settle(self, timeout=20000, quiet=700):
        """Wait until no fetch/XHR has been in flight for ``quiet`` ms."""
        deadline = time.time() + timeout / 1000
        idle_since = None
        while time.time() < deadline:
            if self.inflight:
                idle_since = None
            elif idle_since is None:
                idle_since = time.time()
            elif (time.time() - idle_since) * 1000 >= quiet:
                return True
            self.page.wait_for_timeout(100)
        return False

    def close_overlays(self):
        for _ in range(3):
            if not self.page.locator("[data-overlay-layer]").count():
                return
            self.page.keyboard.press("Escape")
            self.page.wait_for_timeout(150)

    def shot(self, name: str, full_page=False):
        slug = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")[:60] or "page"
        v = self.variant
        path = self.runner.out / f"{v.viewport}-{v.theme}-{v.lang}-{v.scale}-{slug}.png"
        try:
            self.page.screenshot(path=str(path), full_page=full_page)
        except PlaywrightError as exc:
            print(f"    screenshot {path.name} failed: {exc}", flush=True)
        return path.name

    # auth -------------------------------------------------------------------
    def login(self, email: str):
        if self.args.clear_rate_limits:
            try:
                clear_rate_limits(self.args.redis)
            except OSError as exc:
                print(f"    could not clear rate limits: {exc}", flush=True)
        self.goto("/login")
        page = self.page
        page.locator("input[type=email]").fill(email)
        page.locator("input[type=password]").fill(self.args.password)
        page.locator("form button[type=submit]").click()
        page.wait_for_function("() => !location.pathname.startsWith('/login')", timeout=20000)
        page.locator(".user-avatar").first.wait_for(state="visible", timeout=15000)
        self.signed_in = True
        self.settle()

    def logout(self):
        page = self.page
        # The account menu: the sidebar's account button, or the avatar in the phone app bar
        # (pages with their own phone header, like Search and Settings, have no app bar).
        menu = page.locator("[data-testid=user-menu]:visible")
        if not menu.count():
            self.nav("/")
        menu.first.click()
        page.locator(".menu-item--danger").click()
        page.wait_for_function("() => !document.querySelector('.user-avatar')", timeout=15000)
        self.signed_in = False
        self.settle()

    def close(self):
        with contextlib.suppress(PlaywrightError):
            self.context.close()

    # DOM probes -------------------------------------------------------------
    def overflow(self) -> dict:
        return self.page.evaluate(
            """() => ({scrollWidth: document.documentElement.scrollWidth,
                       // Mobile emulation zooms out to fit overflowing content, which
                       // widens innerWidth; the layout viewport stays at the device width.
                       innerWidth: Math.min(window.innerWidth, document.documentElement.clientWidth),
                       rawInnerWidth: window.innerWidth,
                       bodyScrollWidth: document.body.scrollWidth})"""
        )

    def overflowing_elements(self, limit=5) -> list[str]:
        return self.page.evaluate(
            """(limit) => {
              const w = document.documentElement.clientWidth, out = [];
              for (const el of document.querySelectorAll('body *')) {
                const r = el.getBoundingClientRect();
                if (r.width && r.right > w + 1 && getComputedStyle(el).position !== 'fixed') {
                  let ok = false;
                  for (let p = el.parentElement; p; p = p.parentElement) {
                    const ox = getComputedStyle(p).overflowX;
                    if (ox === 'auto' || ox === 'scroll' || ox === 'hidden' || ox === 'clip') {
                      ok = true; break;
                    }
                  }
                  if (!ok) out.push(`${el.tagName.toLowerCase()}.${[...el.classList].join('.')}`
                    + ` right=${Math.round(r.right)}`);
                }
                if (out.length >= limit) break;
              }
              return out;
            }""",
            limit,
        )

    def rect(self, locator) -> dict | None:
        try:
            return locator.bounding_box(timeout=3000)
        except PlaywrightError:
            return None

    def hit(self, x: float, y: float) -> dict:
        """What elementFromPoint returns at (x, y): tag, text and closest a/button."""
        return self.page.evaluate(
            """([x, y]) => {
              const el = document.elementFromPoint(x, y);
              if (!el) return null;
              const target = el.closest('a, button, input, select, textarea, [role=tab]') || el;
              return {tag: target.tagName.toLowerCase(), text: (target.innerText || '').trim().slice(0, 80),
                      href: target.getAttribute('href'), label: target.getAttribute('aria-label'),
                      cls: target.className && String(target.className).slice(0, 80)};
            }""",
            [x, y],
        )

    def edge_hits(self, locator) -> list[bool]:
        """Taps 2px inside each edge of the control land on that control."""
        locator.scroll_into_view_if_needed(timeout=3000)
        return locator.evaluate(
            """(el) => {
              const r = el.getBoundingClientRect(), cx = r.left + r.width / 2, cy = r.top + r.height / 2;
              const pts = [[r.left + 2, cy], [r.right - 2, cy], [cx, r.top + 2], [cx, r.bottom - 2]];
              return pts.map(([x, y]) => { const h = document.elementFromPoint(x, y);
                return !!h && (h === el || el.contains(h)); });
            }"""
        )


# --------------------------------------------------------------------------- runner


class Result:
    def __init__(self):
        self.failures: list[str] = []
        self.info: dict = {}

    def expect(self, condition, message) -> bool:
        if not condition:
            self.failures.append(message)
        return bool(condition)


class Runner:
    def __init__(self, args):
        self.args = args
        self.out = Path(args.out)
        self.out.mkdir(parents=True, exist_ok=True)
        self.report = Report(self.out, args)
        self.browser = None
        self.collections: dict = {}
        self.config_warned = False

    def selected(self, check_id: str) -> bool:
        only = self.args.only_list
        return not only or any(check_id == o or check_id.startswith(o) for o in only)

    def run(self, check_id, session: Session, fn, page=None, provider=False, since=None):
        """Run one check; a failure seen during transient provider trouble is a skip."""
        if not self.selected(check_id):
            return None
        result, mark, status = Result(), since or session.mark(), None
        try:
            fn(result)
        except Skip as exc:
            status = "skip"
            result.info["reason"] = str(exc)
        except Exception as exc:  # a broken step is a failure of this check only
            first = (str(exc).strip().splitlines() or [""])[0][:240]
            result.failures.append(f"error: {type(exc).__name__}: {first}")
            result.info["trace"] = traceback.format_exc(limit=4)[-1200:]
        events = session.provider_trouble_since(mark)
        by_kind: dict[str, list[dict]] = {}
        for event in events:
            by_kind.setdefault(event["kind"], []).append(event)
        trouble = by_kind.get("provider", [])
        if status is None:
            status = "fail" if result.failures else "pass"
        # Only transient provider trouble excuses a failure; a missing key or a stack error
        # never does (they are reported below as failures of their own).
        if status == "fail" and trouble and set(by_kind) == {"provider"}:
            status = "skip"
            result.info["reason"] = "skipped: provider rate limited or unavailable during the check"
        if trouble:
            result.info["provider_events"] = trouble
        details = dict(result.info)
        if result.failures:
            details["failures"] = result.failures
        self.report.add(check_id, session.variant, status, details, page)
        self._event_failure(
            "G-ratelimit",
            "OpenBib answered 429",
            by_kind.get("app_rate_limit"),
            check_id,
            session,
            page,
        )
        self._event_failure(
            "G-provider-config",
            "Semantic Scholar key missing or rejected",
            by_kind.get("provider_config"),
            check_id,
            session,
            page,
        )
        self._event_failure(
            "G-stack-error",
            "the stack answered 5xx",
            by_kind.get("stack_error"),
            check_id,
            session,
            page,
        )
        if provider and self.args.provider_pause:
            session.page.wait_for_timeout(int(self.args.provider_pause * 1000))
        return status

    def _event_failure(self, check, what, events, check_id, session, page):
        if not events:
            return
        paths = sorted(
            {re.sub(r"/papers/[^/]+/", "/papers/{key}/", urlparse(e["url"]).path) for e in events}
        )
        self.report.add(
            check,
            session.variant,
            "fail",
            {
                "failures": [f"{what} to {len(events)} request(s) during {check_id}"],
                "endpoints": paths,
                "sample": events[:3],
            },
            f"{check_id}:{page}",
        )
        if check == "G-provider-config" and not self.config_warned:
            self.config_warned = True
            print(
                "!! Semantic Scholar answered provider_not_configured/provider_key_rejected: "
                "check SEMANTIC_SCHOLAR_API_KEY in .env and recreate the api container.",
                flush=True,
            )

    def variants(self):
        for viewport in self.args.viewports:
            for theme in self.args.theme_list:
                for lang in self.args.lang_list:
                    for scale in self.args.scale_list:
                        yield Variant(
                            viewport, theme, lang, scale, self.args.browser, self.args.safe_area
                        )

    def main(self) -> int:
        with sync_playwright() as pw:
            launcher = getattr(pw, self.args.browser)
            self.browser = launcher.launch(headless=not self.args.headed)
            try:
                for variant in self.variants():
                    print(f"== {variant.name} ({self.args.browser})", flush=True)
                    for phase in (run_anonymous, run_signed_in, run_new_user):
                        try:
                            phase(self, variant)
                        except Exception as exc:  # keep going with the next phase
                            self.report.add(
                                f"phase:{phase.__name__}",
                                variant,
                                "fail",
                                {
                                    "failures": [f"{type(exc).__name__}: {exc}"[:400]],
                                    "trace": traceback.format_exc(limit=5)[-1500:],
                                },
                            )
                        self.report.write()
            finally:
                self.browser.close()
        counts = self.report.write()
        print(f"== summary: {counts} -> {self.out / 'report.json'}", flush=True)
        if counts["fail"]:
            return 1
        return 2 if counts["skip_provider"] else 0


# --------------------------------------------------------------------------- page-level checks

HEADER_JS = """() => {
  // Visitors get .topnav; signed-in members the shell's .topbar (slim bar or phone app bar).
  const header = document.querySelector('.topnav, .topbar');
  if (!header) return null;
  const visible = (el) => { const r = el.getBoundingClientRect(), cs = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none'; };
  const items = [...header.querySelectorAll(
      '.topnav-brand, .topnav-actions > *, .topbar-brand, .breadcrumb, .topbar-actions > *,'
      + ' :scope > button, :scope > .menu-root')]
    .filter(visible).map((el) => { const r = el.getBoundingClientRect();
      return {name: (el.getAttribute('aria-label') || el.innerText || el.className).trim().slice(0, 40),
              x: r.x, y: r.y, width: r.width, height: r.height}; });
  return {items, scrollWidth: header.scrollWidth, clientWidth: header.clientWidth,
          innerWidth: Math.min(innerWidth, document.documentElement.clientWidth)};
}"""


GRAPH_HEADER_JS = r"""() => {
  const row = document.querySelector('.graph-header-row');
  if (!row) return null;
  const visible = (el) => { const r = el.getBoundingClientRect(), cs = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none'; };
  const box = (el) => { const r = el.getBoundingClientRect();
    return {name: (el.getAttribute('aria-label') || el.innerText || el.className).trim().slice(0, 40),
            x: r.x, y: r.y, width: r.width, height: r.height}; };
  const items = [...row.querySelectorAll(
      ':scope > *:not(.graph-header-actions), .graph-header-actions > *')]
    .filter(visible).map(box);
  const seed = row.querySelector('.graph-title-seed');
  const h1 = row.querySelector('h1');
  const seedInfo = seed && (() => { const cs = getComputedStyle(seed);
    return {text: seed.textContent.replace(/^:\s*/, ''), clientWidth: seed.clientWidth,
            scrollWidth: seed.scrollWidth, overflow: cs.textOverflow}; })();
  return {items, seed: seedInfo, h1: h1 ? h1.textContent : '',
          scrollWidth: row.scrollWidth, clientWidth: row.clientWidth,
          innerWidth: Math.min(innerWidth, document.documentElement.clientWidth)};
}"""
# Visible width (px) the seed title must keep in the graph header: a few characters.
SEED_TITLE_MIN_PX = 40


# An element neither scrolls sideways nor sticks out of the viewport.
BOX_FIT_JS = """(el) => { const r = el.getBoundingClientRect();
  const vw = Math.min(innerWidth, document.documentElement.clientWidth);
  const fits = el.scrollWidth <= el.clientWidth + 1 && r.left >= -1 && r.right <= vw + 1;
  return {fits, scrollWidth: el.scrollWidth, clientWidth: el.clientWidth,
          left: Math.round(r.left), right: Math.round(r.right), viewport: vw}; }"""


def page_checks(runner: Runner, s: Session, pages):
    """G-overflow, G-h1 and G-console on each page, plus a screenshot."""
    for label, path in pages:
        mark = s.mark()
        try:
            s.nav(path)
        except PlaywrightError as exc:
            runner.report.add("G-overflow", s.variant, "fail", {"failures": [f"nav: {exc}"]}, label)
            continue
        s.page.wait_for_timeout(300)
        shot = s.shot(label)

        def overflow(r, shot=shot):
            ov = s.overflow()
            r.info.update(ov, screenshot=shot)
            if r.expect(ov["scrollWidth"] <= ov["innerWidth"] + 1, "horizontal overflow"):
                return
            r.info["offenders"] = s.overflowing_elements()

        def h1(r):
            texts = s.page.evaluate(
                "() => [...document.querySelectorAll('h1')].map(h => h.innerText.trim().slice(0, 80))"
            )
            r.info["h1"] = texts
            r.expect(len(texts) == 1, f"{len(texts)} h1 elements")

        def console(r, mark=mark):
            errors = s.console[mark["con"] :]
            r.info["errors"] = errors
            r.expect(not errors, f"{len(errors)} console errors")

        runner.run("G-overflow", s, overflow, label, since=mark)
        runner.run("G-h1", s, h1, label, since=mark)
        runner.run("G-console", s, console, label, since=mark)


def header_checks(runner: Runner, s: Session, who: str):
    s.nav("/")
    v = s.variant

    def header(r):
        data = s.page.evaluate(HEADER_JS)
        if not data:
            raise Skip("no .topnav or .topbar")
        r.info["items"] = [i["name"] for i in data["items"]]
        r.expect(
            data["scrollWidth"] <= data["clientWidth"] + 1,
            f"header overflows: scrollWidth {data['scrollWidth']} > {data['clientWidth']}",
        )
        items = data["items"]
        for i, a in enumerate(items):
            r.expect(a["x"] + a["width"] <= data["innerWidth"] + 1, f"'{a['name']}' past the edge")
            for b in items[i + 1 :]:
                r.expect(not rect_overlap(a, b), f"'{a['name']}' overlaps '{b['name']}'")

    runner.run("F04-header", s, header, f"header-{who}")
    controls = header_controls(s)

    def targets(r):
        if not v.touch:
            raise Skip("not a touch viewport")
        sizes = {}
        r.expect(controls, "no header controls found")
        for name, loc in controls:
            box = s.rect(loc)
            if not box:
                continue
            sizes[name] = [round(box["width"]), round(box["height"])]
            r.expect(
                box["width"] >= TOUCH_MIN - 0.5 and box["height"] >= TOUCH_MIN - 0.5,
                f"{name} is {round(box['width'])}x{round(box['height'])}",
            )
        r.info["sizes"] = sizes

    def edges(r):
        bad = {}
        for name, loc in controls:
            if not loc.is_visible():
                continue
            hits = s.edge_hits(loc)
            if not all(hits):
                bad[name] = hits
        r.info["misses"] = bad
        r.expect(not bad, f"edge taps miss: {sorted(bad)}")

    runner.run("F10-targets", s, targets, f"header-{who}")
    runner.run("F10-edges", s, edges, f"header-{who}")


def header_controls(s: Session):
    page = s.page
    controls = [
        ("theme toggle", page.locator("[data-testid=theme-toggle]").first),
        ("language", page.locator("[data-testid=language-menu]").first),
        ("search", page.locator(".topnav-search, [data-testid=palette-button]").first),
        ("account", page.locator(".user-menu-btn, .sidebar-account").first),
        ("sign in", page.locator(".topnav-signin").first),
    ]
    footer = page.locator(".app-footer a")
    for index in range(footer.count()):
        controls.append((f"footer link {index + 1}", footer.nth(index)))
    tabs = page.locator(".tabbar-link")
    for index in range(tabs.count()):
        controls.append((f"tab {index + 1}", tabs.nth(index)))
    return [(name, loc) for name, loc in controls if loc.count() and loc.is_visible()]


def scroll_to_end(s: Session):
    s.page.evaluate("() => window.scrollTo(0, document.documentElement.scrollHeight)")
    s.page.wait_for_timeout(400)


def footer_check(runner: Runner, s: Session, label: str, path: str, provider=False):
    """F03: at max scroll the Privacy/Terms links are hit-testable, and a tap navigates."""

    def check(r):
        s.nav(path)
        s.page.wait_for_timeout(300)
        scroll_to_end(s)
        r.info["screenshot"] = s.shot(f"footer-{label}")
        inner_h = s.page.evaluate("() => window.innerHeight")
        for href in ("/privacy", "/terms"):
            link = s.page.locator(f'.app-footer a[href="{href}"]')
            box = s.rect(link)
            if not r.expect(box, f"no footer link {href}"):
                continue
            cx, cy = box["x"] + box["width"] / 2, box["y"] + box["height"] / 2
            r.expect(0 <= cy <= inner_h, f"{href} link centre y={round(cy)} outside the viewport")
            hit = s.hit(cx, cy)
            r.expect(hit and hit.get("href") == href, f"elementFromPoint at {href} centre is {hit}")
        terms = s.page.locator('.app-footer a[href="/terms"]')
        if s.variant.touch:
            terms.tap()
        else:
            terms.click()
        s.page.wait_for_timeout(500)
        r.expect(s.page.evaluate("() => location.pathname") == "/terms", "tap did not open /terms")

    runner.run("F03-footer", s, check, label, provider=provider)


def last_action_check(runner: Runner, s: Session, label: str, path: str, selector: str):
    """F03 / G33: at max scroll the last in-page action is reachable and not covered."""

    def check(r):
        s.nav(path)
        s.page.wait_for_timeout(300)
        scroll_to_end(s)
        target = s.page.locator(selector)
        if not target.count():
            raise Skip(f"no {selector} on {path}")
        target = target.last
        target.scroll_into_view_if_needed()
        s.page.wait_for_timeout(200)
        box = s.rect(target)
        hit = target.evaluate(
            """(el) => { const r = el.getBoundingClientRect();
              const h = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
              return {ok: !!h && (h === el || el.contains(h)),
                      got: h ? h.tagName + '.' + String(h.className).slice(0, 60) : null}; }"""
        )
        r.info.update(box=box, hit=hit, screenshot=s.shot(f"last-action-{label}"))
        r.expect(hit["ok"], f"last action covered by {hit['got']}")

    runner.run("F03-actions", s, check, label)


# The top edge of what the sticky headers cover (top nav or bar, search field and chips) and
# the bottom edge of the free area (above the phone tab bar).
STICKY_JS = """() => {
  let top = 0;
  for (const el of document.querySelectorAll('.topnav, .topbar, .search-top, .search-bar')) {
    const cs = getComputedStyle(el), r = el.getBoundingClientRect();
    if ((cs.position === 'sticky' || cs.position === 'fixed') && r.height > 0
        && cs.visibility !== 'hidden' && r.top < innerHeight / 2) top = Math.max(top, r.bottom);
  }
  const tabbar = document.querySelector('.tabbar');
  const tr = tabbar && tabbar.getBoundingClientRect();
  const bottom = tr && tr.height > 0 && getComputedStyle(tabbar).display !== 'none'
    ? Math.min(innerHeight, tr.top) : innerHeight;
  const box = (el) => { if (!el) return null; const r = el.getBoundingClientRect();
    return {top: Math.round(r.top * 10) / 10, bottom: Math.round(r.bottom * 10) / 10}; };
  const active = document.activeElement;
  return {top: Math.round(top * 10) / 10, bottom: Math.round(bottom * 10) / 10, y: scrollY,
          status: box(document.querySelector('[data-testid=search-status]')),
          active: active && active.closest('.search-results') ? box(active) : null,
          activeName: active ? active.tagName.toLowerCase() + '.' + active.className : null};
}"""


# The third result's box, and the gap SearchPage.css leaves between the sticky field and a
# row scrolled into view: --space-xs past the field plus the row's scroll-margin-top.
ROW_BOX_JS = """() => {
  const row = document.querySelectorAll('.search-result')[2];
  const r = row.getBoundingClientRect();
  const root = document.documentElement;
  const xs = getComputedStyle(root).getPropertyValue('--space-xs').trim();
  const rem = parseFloat(getComputedStyle(root).fontSize);
  const space = xs.endsWith('rem') ? parseFloat(xs) * rem : parseFloat(xs) || 0;
  const gap = space + (parseFloat(getComputedStyle(row).scrollMarginTop) || 0);
  return {top: Math.round(r.top * 10) / 10, bottom: Math.round(r.bottom * 10) / 10,
          gap: Math.round(gap * 10) / 10};
}"""


def sticky_search_check(runner: Runner, s: Session, label: str):
    """G-sticky: a search opens with the status line clear of the sticky field, and a
    result brought into view (scrollIntoView, focus, Tab) never lands under it. A
    scrollIntoView target also lands snugly below it (the scroll padding follows the
    measured field), at the variant's text size and at 62.5% and 75%."""
    page = s.page

    def clear(r, what, box, state):
        if not r.expect(box, f"{what}: nothing to measure"):
            return
        r.expect(
            box["top"] >= state["top"] - 0.5,
            f"{what} top {box['top']} under the sticky header (ends at {state['top']})",
        )
        r.expect(box["top"] < state["bottom"], f"{what} top {box['top']} below the viewport")

    def snug(r, what, box, state):
        # scrollIntoView aligns the row's top to the scroll padding: just under the
        # header (gap: --space-xs past the field plus the row's scroll-margin-top). A
        # padding that overestimates the header lands it far lower. Skipped when the page
        # is clamped at the top and cannot scroll that far.
        if not box or state["y"] <= 1:
            return
        limit = state["top"] + box["gap"] + 4
        r.expect(
            box["top"] <= limit,
            f"result after {what} at {box['top']}, more than {box['gap']}px gap below the "
            f"sticky header (ends at {state['top']}): scroll padding overestimates it",
        )

    def check(r):
        # A fresh load (no remembered search positions) of a page scrolled down, as the
        # landing page is once its autofocused field scrolls into view at large text.
        s.goto("/")
        page.evaluate("() => window.scrollTo(0, 600)")
        page.wait_for_timeout(200)
        r.info["from_y"] = page.evaluate("() => scrollY")
        s.nav(f"/search?q={quote(SEARCH_Q)}")
        wait_search(s)
        page.wait_for_timeout(300)
        state = page.evaluate(STICKY_JS)
        r.info.update(arrive=state, screenshot=s.shot(f"sticky-{label}"))
        r.expect(state["y"] <= 1, f"search opened scrolled to y={state['y']}")
        clear(r, "status line", state["status"], state)
        if state["status"]:
            r.expect(
                state["status"]["bottom"] <= state["bottom"] + 0.5,
                f"status line bottom {state['status']['bottom']} past {state['bottom']}",
            )
        count = page.locator(".search-result").count()
        if count < 3:
            raise Skip(f"{count} results: too few to scroll back to one")
        rows = ".search-result"
        steps = {
            "scrollIntoView": f"() => document.querySelectorAll('{rows}')[2].scrollIntoView()",
            "focus": f"() => document.querySelectorAll('{rows}')[2].focus()",
            # Keyboard: focus the first control of row 2 off screen, then Tab to the next.
            "Tab": f"""() => document.querySelectorAll('{rows}')[1]
                       .querySelector('a[href], button').focus({{preventScroll: true}})""",
        }
        for how, script in steps.items():
            scroll_to_end(s)
            page.evaluate(script)
            if how == "Tab":
                scroll_to_end(s)
                page.keyboard.press("Tab")
            page.wait_for_timeout(300)
            state = page.evaluate(STICKY_JS)
            if how == "Tab":
                r.info["tab_focus"] = state["activeName"]
                box = state["active"]
            else:
                box = page.evaluate(ROW_BOX_JS)
            r.info[how] = {"target": box, "header": state["top"], "y": state["y"]}
            clear(r, f"result after {how}", box, state)
            if how == "scrollIntoView":
                snug(r, how, box, state)
        r.info["screenshot_tab"] = s.shot(f"sticky-{label}-tab")
        # Small text: the field is mostly fixed-pixel controls, so a rem-based padding
        # estimate falls short and hides the target under the header.
        size = page.evaluate("() => document.documentElement.style.fontSize")
        try:
            for small in ("62.5%", "75%"):
                page.evaluate(f"() => {{ document.documentElement.style.fontSize = '{small}'; }}")
                page.wait_for_timeout(300)
                scroll_to_end(s)
                page.evaluate(steps["scrollIntoView"])
                page.wait_for_timeout(300)
                state = page.evaluate(STICKY_JS)
                box = page.evaluate(ROW_BOX_JS)
                what = f"scrollIntoView at {small} text"
                r.info[what] = {"target": box, "header": state["top"], "y": state["y"]}
                clear(r, f"result after {what}", box, state)
                snug(r, what, box, state)
        finally:
            page.evaluate(f"() => {{ document.documentElement.style.fontSize = '{size}'; }}")

    runner.run("G-sticky", s, check, label, provider=True)


def legal_fixture_check(runner: Runner, variant: Variant):
    """F09 with tools/responsive_fixtures/legal.json in a fresh context (no cached config)."""
    s = Session(runner, variant, "legal")
    try:
        body = FIXTURE.read_text("utf-8")
        s.context.route(
            "**/legal.json",
            lambda route: route.fulfill(status=200, content_type="application/json", body=body),
        )
        s.goto("/privacy")
        s.page.locator(".legal-page h1").wait_for(timeout=15000)

        def check(r):
            text = s.page.locator(".legal-page").inner_text()
            r.info["screenshot"] = s.shot("privacy-fixture", full_page=True)
            if variant.lang == "en":
                for needle in IT_FIXTURE_STRINGS:
                    r.expect(needle not in text, f"Italian fixture text in en: {needle!r}")
                for needle in EN_FIXTURE_STRINGS:
                    r.expect(needle in text, f"missing English fixture text {needle!r}")
            else:
                for needle in IT_FIXTURE_STRINGS[:2]:
                    r.expect(needle in text, f"missing Italian fixture text {needle!r}")
            doubled = [m.start() for m in re.finditer(r"(?<!\.)\.\.(?!\.)", text)]
            r.expect(
                not doubled,
                f"'..' at {doubled[:5]}: "
                + "; ".join(text[max(0, i - 40) : i + 3] for i in doubled[:3]),
            )
            ov = s.overflow()
            r.expect(ov["scrollWidth"] <= ov["innerWidth"] + 1, f"overflow {ov}")

        runner.run("F09", s, check, "privacy")
    finally:
        s.close()


def settings_links_check(runner: Runner, s: Session):
    """S08: #your-data focus, privacy and Library links; S05: #zotero focuses the key input."""

    def your_data(r):
        s.nav("/settings#your-data")
        s.page.wait_for_timeout(600)
        focus = s.page.evaluate(
            "() => { const a = document.activeElement; return a && (a.id || a.tagName); }"
        )
        r.info["focused"] = focus
        r.expect(focus == "your-data", f"focus is on {focus!r}, not #your-data")
        s.nav("/privacy")
        r.expect(
            s.page.locator('.legal-page a[href="/settings#your-data"]').count() > 0,
            "privacy page has no link to /settings#your-data",
        )
        s.nav("/library")
        r.expect(
            s.page.locator('a[href="/settings#your-data"]').count() > 0,
            "Library has no Export data link",
        )

    def notices_present(page) -> dict:
        return page.evaluate(
            """() => ({
              settings: !!document.querySelector('#your-data .settings-notice a[href="/privacy"]'),
              dashboard: !!document.querySelector(
                '.dashboard-backup-note a[href="/settings#your-data"]'),
            })"""
        )

    def visit_both(page) -> dict:
        # Phones show the section index at /settings; the anchor opens the section there.
        s.nav("/settings#your-data")
        page.locator("#your-data").wait_for(timeout=15000)
        page.wait_for_timeout(400)
        found = notices_present(page)
        s.nav("/")
        page.locator(
            ".dashboard-columns, .dashboard-actions, .dashboard-onboarding"
        ).first.wait_for(timeout=15000)
        page.wait_for_timeout(400)
        found["dashboard"] = notices_present(page)["dashboard"]
        return found

    def backup_notices(r):
        page = s.page
        legal = page.evaluate("async () => (await (await fetch('/legal.json')).json())")
        r.info["backups_enabled"] = legal.get("backups_enabled")
        if legal.get("backups_enabled") is not False:
            raise Skip("the stack's legal.json does not have backups_enabled:false")
        off = visit_both(page)
        r.info["backups_disabled"] = off
        r.expect(
            off["settings"], "Settings #your-data has no no-backups notice with a /privacy link"
        )
        r.expect(off["dashboard"], "the dashboard of a non-empty Library has no export reminder")
        legal["backups_enabled"] = True
        body = json.dumps(legal)
        handler = lambda route: route.fulfill(  # noqa: E731
            status=200, content_type="application/json", body=body
        )
        s.context.route("**/legal.json", handler)
        try:
            s.goto("/settings")  # a reload, so the app reads the routed legal.json
            on = visit_both(page)
        finally:
            s.context.unroute("**/legal.json", handler)
            s.goto("/")
        r.info["backups_enabled_fixture"] = on
        r.expect(not on["settings"], "no-backups notice shown with backups_enabled:true")
        r.expect(not on["dashboard"], "export reminder shown with backups_enabled:true")

    runner.run("S08", s, your_data, "settings")
    runner.run("S08", s, backup_notices, "backup-notices")


DIALOG_NAME_JS = r"""(d) => {
  const ids = (d.getAttribute('aria-labelledby') || '').split(/\s+/).filter(Boolean);
  const text = ids.map((id) => (document.getElementById(id)?.textContent || '').trim()).join(' ');
  return (text || d.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim();
}"""


def open_dialog(s: Session, trigger):
    """Focus the trigger and press Enter, so the return target is deterministic."""
    trigger.scroll_into_view_if_needed()
    trigger.focus()
    s.page.keyboard.press("Enter")
    dialog = s.page.locator("[role=dialog]").last
    dialog.wait_for(state="visible", timeout=10000)
    s.page.wait_for_timeout(250)
    return dialog


def dialog_flow(s: Session, r: Result, trigger, name_pattern: str, tabs=15):
    """F05: name, focus inside, Tab/Shift+Tab containment, #root inert, Escape returns focus."""
    page = s.page
    dialog = open_dialog(s, trigger)
    name = dialog.evaluate(DIALOG_NAME_JS)
    r.info["name"] = name
    r.expect(re.search(name_pattern, name, re.I), f"dialog name {name!r} !~ {name_pattern!r}")
    inside = "(d) => d.contains(document.activeElement)"
    r.expect(dialog.evaluate(inside), "focus is not inside the dialog on open")
    r.expect(page.evaluate("() => !!document.getElementById('root')?.inert"), "#root is not inert")
    escaped = []
    for key in ("Tab", "Shift+Tab"):
        for step in range(tabs):
            page.keyboard.press(key)
            if not dialog.evaluate(inside):
                escaped.append(f"{key} #{step + 1}")
                break
    r.expect(not escaped, f"focus left the dialog after {escaped}")
    page.keyboard.press("Escape")
    page.wait_for_timeout(400)
    r.expect(page.locator("[role=dialog]").count() == 0, "Escape did not close the dialog")
    returned = trigger.evaluate("(el) => el === document.activeElement")
    if not returned:
        r.info["focused_after"] = page.evaluate(
            "() => document.activeElement && document.activeElement.outerHTML.slice(0, 120)"
        )
    r.expect(returned, "focus did not return to the trigger")
    return name


def discover_collections(runner: Runner, s: Session):
    s.nav("/collections")
    s.page.wait_for_timeout(300)
    links = s.page.evaluate(
        """() => [...document.querySelectorAll('a[href^="/collections/"]')]
          .map((a) => ({href: a.getAttribute('href'), text: a.innerText.trim()}))"""
    )
    found = {}
    for link in links:
        match = re.match(r"/collections/([0-9a-f-]{36})", link["href"] or "")
        if not match:
            continue
        if link["text"].startswith(LONG_COLLECTION_PREFIX):
            found.setdefault("long", match.group(1))
        for number in range(1, 5):
            if link["text"].startswith(f"Demo collection {number}"):
                found.setdefault(f"demo{number}", match.group(1))
    runner.collections = found
    print(f"    collections: {sorted(found)}", flush=True)
    return found


def dialog_checks(runner: Runner, s: Session):
    cols = runner.collections

    def details(r):
        s.nav("/library")
        trigger = s.page.locator(".library-list .paper-title-btn").first
        title = trigger.inner_text().strip()
        dialog_flow(
            s,
            r,
            trigger,
            r"^Paper details\b.*" + re.escape(title[:20]) if s.variant.lang == "en" else r".+",
        )

    def long_note(r):
        s.nav("/library?q=unbroken")
        trigger = s.page.locator(".library-list .paper-title-btn").first
        if not trigger.count():
            raise Skip("long-data title not in the Library (seed with --long-data)")
        open_dialog(s, trigger)
        s.page.wait_for_timeout(800)
        body = s.page.locator("[role=dialog] .panel-body")
        sizes = body.evaluate("(b) => [b.scrollHeight, b.clientHeight]")
        moved = body.evaluate(
            "(b) => { const before = b.scrollTop; b.scrollTop += 300; "
            "return b.scrollTop !== before; }"
        )
        r.info.update(sizes=sizes, screenshot=s.shot("details-long-note"))
        r.expect(sizes[0] > sizes[1], f"panel body does not scroll: {sizes}")
        r.expect(moved, "panel body scrollTop did not change")
        s.close_overlays()

    def confirm(r):
        s.nav("/library")
        dialog_flow(
            s,
            r,
            s.page.locator(".library-delete").first,
            r"Delete" if s.variant.lang == "en" else r".+",
        )

    def import_modal(r):
        if "demo2" not in cols:
            raise Skip("no Demo collection 2")
        s.nav(f"/collections/{cols['demo2']}")
        trigger = (
            s.page.locator(".cd-header .page-header-actions button")
            .filter(has_text=re.compile("Import DOIs|Importa DOI"))
            .first
        )
        dialog_flow(s, r, trigger, r".+")

    def sharing(r):
        if "long" not in cols:
            raise Skip("no long-data collection")
        s.nav(f"/collections/{cols['long']}")
        trigger = s.page.locator(".cd-header .page-header-actions button.btn-primary").first
        if not trigger.count():
            raise Skip("no Share button (not the owner?)")
        dialog_flow(s, r, trigger, r".+")

    runner.run("F05-dialog", s, details, "paper-details")
    runner.run("F05-dialog", s, long_note, "details-long-note")
    runner.run("F05-dialog", s, confirm, "confirm-delete")
    runner.run("F05-dialog", s, import_modal, "import-modal")
    runner.run("F05-dialog", s, sharing, "sharing")


def long_data_checks(runner: Runner, s: Session):
    cols = runner.collections

    def check(r):
        if "long" not in cols:
            raise Skip("no long-data collection (seed with --long-data)")
        pages = {
            "collection-long": f"/collections/{cols['long']}",
            "library-long": "/library?q=unbroken",
            "graph-collection-long": f"/graph/collection/{cols['long']}",
            "collections-long": "/collections",
            "dashboard-long": "/",
        }
        for label, path in pages.items():
            s.nav(path)
            s.page.wait_for_timeout(800)
            ov = s.overflow()
            r.info[label] = {"overflow": ov, "screenshot": s.shot(label)}
            if not r.expect(ov["scrollWidth"] <= ov["innerWidth"] + 1, f"{label} overflows"):
                r.info[label]["offenders"] = s.overflowing_elements()
        s.nav("/library?q=unbroken")
        trigger = s.page.locator(".library-list .paper-title-btn").first
        if trigger.count():
            open_dialog(s, trigger)
            s.page.wait_for_timeout(800)
            panel = s.page.locator("[role=dialog]").last
            widths = panel.evaluate("(p) => [p.scrollWidth, p.clientWidth]")
            r.info["panel"] = {"widths": widths, "screenshot": s.shot("details-long")}
            r.expect(widths[0] <= widths[1] + 1, f"details panel overflows {widths}")
            s.close_overlays()

    def surfaces(r):
        if "long" not in cols:
            raise Skip("no long-data collection (seed with --long-data)")
        page = s.page
        # The ~200-character unresolved DOI card.
        s.nav(f"/collections/{cols['long']}")
        page.wait_for_timeout(800)
        card = page.locator(".unresolved-card").first
        if r.expect(card.count(), "no unresolved card in the long-data collection"):
            r.info["unresolved_card"] = widths = card.evaluate(BOX_FIT_JS)
            r.expect(widths["fits"], f"unresolved long-DOI card overflows {widths}")
        # The 200-character collection name in the AddToCollectionMenu.
        s.nav("/library")
        trigger = page.locator(".library-list [data-testid=add-to-collection]").first
        if r.expect(trigger.count(), "no Add to collection button on a Library card"):
            trigger.click()
            menu = page.locator(".menu-popover[role=menu]").first
            menu.locator(".menu-item-label").filter(has_text=LONG_COLLECTION_PREFIX).first.wait_for(
                timeout=15000
            )
            r.info["add_menu"] = box = menu.evaluate(BOX_FIT_JS)
            box["screenshot"] = s.shot("add-menu-long")
            r.expect(box["fits"], f"AddToCollectionMenu with the long name overflows {box}")
            page.keyboard.press("Escape")
            page.wait_for_timeout(300)
        # The 300-character title in the collection graph's popup (or summary) and list.
        open_graph(s, f"/graph/collection/{cols['long']}")
        root = open_papers_list(s)
        r.info["graph_list"] = box = root.evaluate(BOX_FIT_JS)
        r.expect(box["fits"], f"graph Papers list overflows {box}")
        row = root.locator(".graph-list-select").filter(has_text="unbroken identifiers").first
        if r.expect(row.count(), "long-title paper not in the graph Papers list"):
            row.click()
            page.wait_for_timeout(700)
            if s.variant.compact:
                s.close_overlays()
            selector = ".graph-summary" if s.variant.compact else ".graph-popup"
            popup = page.locator(selector).first
            if r.expect(popup.count(), f"no {selector} for the long-title node"):
                r.info["graph_popup"] = box = popup.evaluate(BOX_FIT_JS)
                box["screenshot"] = s.shot("graph-popup-long")
                r.expect(box["fits"], f"{selector} with the long title overflows {box}")

    runner.run("LONG", s, check, "long-data", provider=True)
    runner.run("LONG", s, surfaces, "long-surfaces", provider=True)


def doi_ui_checks(runner: Runner, s: Session):
    cols = runner.collections
    page = s.page

    def add_form(r):
        if "demo3" not in cols:
            raise Skip("no Demo collection 3")
        s.nav(f"/collections/{cols['demo3']}")
        rows = page.locator(".paper-card").filter(has_text=GNN_TITLE)
        if rows.count():  # a previous run added it: remove it first (rerunnable)
            rows.first.locator(".cd-remove").first.click()
            page.locator("[role=dialog] .btn-danger").click()
            page.wait_for_timeout(1500)
            s.settle()
        field = page.locator(".cd-add-form input")
        submit = page.locator(".cd-add-form button[type=submit]")
        field.fill(GNN_DOI)
        submit.click()
        page.locator(".toast").first.wait_for(timeout=30000)
        s.settle()
        r.info["toast"] = page.locator(".toast").first.inner_text()
        r.expect(re.search(r"Added|Aggiunt", r.info["toast"]), f"toast {r.info['toast']!r}")
        count = page.locator(".paper-card").filter(has_text=GNN_TITLE).count()
        r.expect(count == 1, f"{count} rows for the added paper")
        field.fill(f"doi:{GNN_DOI}")
        submit.click()
        page.locator(".cd-add-error").wait_for(timeout=20000)
        r.info["duplicate_error"] = page.locator(".cd-add-error").inner_text()
        r.expect(field.get_attribute("aria-invalid") == "true", "duplicate: no aria-invalid")
        mark = s.mark()
        field.fill("not-a-doi")
        submit.click()
        page.wait_for_timeout(800)
        r.info["invalid_error"] = page.locator(".cd-add-error").inner_text()
        r.expect(field.get_attribute("aria-invalid") == "true", "not-a-doi: no aria-invalid")
        sent = s.requests_since(mark, r"/collections/.+/papers", "POST")
        r.expect(not sent, f"not-a-doi sent {len(sent)} request(s)")
        r.info["screenshot"] = s.shot("doi-add-form")

    def unresolved(r):
        found = {}
        targets = [("library", "/library")]
        if "long" in cols:
            targets.append(("library-long", f"/library?collection_id={cols['long']}"))
            targets.append(("collection", f"/collections/{cols['long']}"))
        for label, path in targets:
            if label == "library-long" and "library" in found:
                continue
            s.nav(path)
            card = page.locator(".unresolved-card").first
            if not card.count():
                continue
            buttons = card.evaluate(
                "(c) => [...c.querySelectorAll('button, a')].map((b) => "
                "((b.innerText || '').trim() + ' ' + (b.getAttribute('aria-label') || '')).trim())"
            )
            found["library" if label.startswith("library") else label] = {
                "identifier": card.locator(".paper-identifier").inner_text(),
                "actions": buttons,
                "explore_graph": card.locator('a[href^="/graph/"]').count(),
            }
        r.info.update(found)
        r.expect("library" in found, "no unresolved card in the Library")
        r.expect("collection" in found or "long" not in cols, "no unresolved collection row")
        lib = found.get("library", {})
        if lib:
            r.expect(UNRESOLVED_MARKER in lib["identifier"], f"identifier {lib['identifier']!r}")
            for word in ("Try again", "Fix identifier", "Delete"):
                r.expect(
                    any(word.lower() in b.lower() for b in lib["actions"]),
                    f"Library card lacks {word!r}: {lib['actions']}",
                )
        col = found.get("collection", {})
        if col:
            for word in ("Try again", "Fix identifier", "Remove"):
                r.expect(any(word in b for b in col["actions"]), f"collection row lacks {word!r}")
            r.expect(col["explore_graph"] == 0, "unresolved collection row offers Explore graph")

    runner.run("DOI-UI", s, add_form, "add-form", provider=True)
    runner.run("DOI-UI", s, unresolved, "unresolved")


def import_checks(runner: Runner, s: Session):
    """S05: live summary, per-line results, modal stays until Done; Zotero link to #zotero."""
    cols = runner.collections
    page = s.page

    def check(r):
        if "demo2" not in cols:
            raise Skip("no Demo collection 2")
        s.nav(f"/collections/{cols['demo2']}")
        page.locator(".cd-header .page-header-actions button").filter(
            has_text=re.compile("Import DOIs")
        ).first.click()
        dialog = page.locator("[role=dialog]").last
        area = dialog.locator("textarea")
        area.fill("not-a-doi")
        page.wait_for_timeout(300)
        text = dialog.inner_text()
        r.expect("0 valid · 1 invalid" in text, "no '0 valid · 1 invalid' summary")
        button = dialog.locator("button[type=submit]")
        r.expect(button.is_disabled(), "import button enabled with no valid line")
        area.fill(f"{GNN_DOI}\nnot-a-doi\n10.5555/openbib-demo.versions.v1")
        page.wait_for_timeout(300)
        label = button.inner_text().strip()
        r.info["button"] = label
        r.expect(label == "Import 2 DOIs", f"button reads {label!r}")
        button.click()
        dialog.locator(".cd-import-results-heading").wait_for(timeout=90000)
        lines = dialog.locator(".cd-import-results li").all_inner_texts()
        r.info.update(
            lines=[re.sub(r"\s+", " ", x) for x in lines], screenshot=s.shot("import-results")
        )
        r.expect(len(lines) >= 2, f"{len(lines)} result lines")
        r.expect(page.locator("[role=dialog]").count() == 1, "modal closed before Done")
        dialog.locator("button").filter(has_text=re.compile("^Done$")).click()
        page.wait_for_timeout(400)
        r.expect(page.locator("[role=dialog]").count() == 0, "Done did not close the modal")

    def zotero(r):
        if "demo2" not in cols:
            raise Skip("no Demo collection 2")
        s.nav(f"/collections/{cols['demo2']}")
        link = page.locator('a[href="/settings#zotero"]')
        if not link.count():
            raise Skip("Zotero is connected (no connect link)")
        link.first.click()
        page.wait_for_timeout(1200)
        focus = page.evaluate(
            "() => { const a = document.activeElement; return a && "
            "{tag: a.tagName, inZotero: !!a.closest('#zotero')}; }"
        )
        r.info["focused"] = focus
        r.expect(
            focus and focus["tag"] == "INPUT" and focus["inZotero"],
            "the Zotero API key input is not focused",
        )

    runner.run("S05", s, check, "import", provider=True)
    runner.run("S05", s, zotero, "zotero-link")


CONTRAST_JS = r"""([selector, parentLevels]) => {
  const el = document.querySelector(selector);
  if (!el) return null;
  const layers = (node) => { const out = [];
    for (let e = node; e; e = e.parentElement) { const c = getComputedStyle(e).backgroundColor;
      out.push(c); const m = c.match(/[\d.]+/g);
      if (m && (m.length < 4 || +m[3] === 1)) break; }
    return out; };
  let outer = el; for (let i = 0; i < parentLevels; i++) outer = outer.parentElement || outer;
  const icon = el.querySelector('svg');
  return {color: getComputedStyle(el).color, iconColor: icon ? getComputedStyle(icon).color : null,
          own: layers(el), around: layers(outer.parentElement || outer),
          border: getComputedStyle(el).borderTopColor};
}"""

VAR_COLOR_JS = """(names) => names.map((name) => {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const d = document.createElement('span'); d.style.color = v; document.body.appendChild(d);
  const c = getComputedStyle(d).color; d.remove(); return c; })"""


def composite(layers):
    color = (255.0, 255.0, 255.0, 1.0)
    for layer in reversed(layers or []):
        parsed = parse_color(layer)
        if parsed:
            color = blend(parsed, color)
    return color


def contrast_probe(s: Session, selector: str, parent_levels=0):
    data = s.page.evaluate(CONTRAST_JS, [selector, parent_levels])
    if not data:
        return None
    own, around = composite(data["own"]), composite(data["around"])
    text = blend(parse_color(data["color"]), own)
    icon = blend(parse_color(data["iconColor"]), own) if data["iconColor"] else None
    return {
        "text": contrast(text, own),
        "icon": contrast(icon, own) if icon else None,
        "fill_vs_around": contrast(own, around),
    }


def open_graph(s: Session, path: str, timeout=90000):
    s.nav(path, settle=False)
    s.page.locator(
        "[data-testid=citation-graph], .graph-empty, .graph-base-state[role=alert]"
    ).first.wait_for(timeout=timeout)
    s.settle()
    s.page.wait_for_timeout(600)
    if not s.page.locator("[data-testid=citation-graph]").count():
        raise Skip(f"graph did not render on {path}")


def open_papers_list(s: Session):
    """Desktop: the Papers drawer; compact: the sheet's Papers tab. Returns the list root."""
    page = s.page
    if s.variant.compact:
        if not page.locator("[data-testid=graph-controls-sheet]").count():
            page.locator(".graph-controls-trigger").click()
        sheet = page.locator("[data-testid=graph-controls-sheet]")
        sheet.locator("[role=tab]").nth(1).click()
        return sheet.locator(".graph-paper-list")
    toggle = page.locator(".graph-header-actions button[aria-expanded]").first
    if toggle.get_attribute("aria-expanded") != "true":
        toggle.click()
    return page.locator(".graph-drawer")


def select_from_list(s: Session, title: str):
    root = open_papers_list(s)
    row = root.locator(".graph-list-select").filter(has_text=title).first
    row.click()
    s.page.wait_for_timeout(500)


def contrast_checks(runner: Runner, s: Session):
    def check(r):
        cols = runner.collections
        s.nav(f"/collections/{cols['long']}" if "long" in cols else "/library")
        badge = contrast_probe(s, ".unresolved-card .badge--warning")
        r.info["warning_badge"] = badge
        if r.expect(badge, "no warning badge on the page"):
            r.expect(badge["text"] >= 4.5, f"warning badge text {badge['text']}:1 < 4.5")
        ring = s.page.evaluate(VAR_COLOR_JS, ["--graph-node-selected", "--color-bg"])
        ratio = contrast(parse_color(ring[0]), parse_color(ring[1]))
        r.info["selected_ring_vs_bg"] = ratio
        r.expect(ratio >= 3, f"selected ring {ratio}:1 < 3 against the canvas background")
        if s.variant.compact:
            r.info["note"] = "pressed pin and range chip measured on desktop viewports only"
            return
        open_graph(s, f"/graph/{quote(GNN_KEY, safe='')}")
        open_papers_list(s)
        pin = contrast_probe(s, ".graph-drawer .graph-pin-toggle[aria-pressed=true]")
        r.info["pressed_pin"] = pin
        if r.expect(pin, "no pressed pin toggle in the Papers list"):
            r.expect(pin["icon"] and pin["icon"] >= 3, f"pressed pin icon {pin['icon']}:1 < 3")
            r.expect(pin["fill_vs_around"] >= 3, f"pressed pin fill {pin['fill_vs_around']}:1 < 3")
        select_from_list(s, GNN_TITLE)
        chip = contrast_probe(s, ".graph-range-btn.is-current")
        r.info["current_range"] = chip
        if r.expect(chip, "no current range chip"):
            r.expect(chip["text"] >= 4.5, f"current range text {chip['text']}:1 < 4.5")
        r.info["screenshot"] = s.shot("contrast-graph")

    runner.run("contrast", s, check, "badges-pins", provider=True)


def library_text_checks(runner: Runner, s: Session):
    page = s.page

    def f06(r):
        s.nav(f"/library?q={HTML_ABSTRACT_TITLE}")
        trigger = page.locator(".library-list .paper-title-btn").first
        if not trigger.count():
            raise Skip("seeded HTML abstract not in the Library (seed with --long-data)")
        open_dialog(s, trigger)
        page.wait_for_timeout(800)
        panel = page.locator("[role=dialog]").last
        text = panel.inner_text()
        r.expect("<h4" not in text and "</h4" not in text, "raw <h4> markup in the details text")
        strong = panel.locator("strong").filter(has_text="Background")
        r.expect(strong.count() >= 1, "no bold 'Background' label")
        r.info["screenshot"] = s.shot("details-html-abstract")
        s.close_overlays()

    def s06_tiles(r):
        s.nav("/")
        # The inline figures (In library, Collections, Reading, To read) each name their value.
        tiles = page.locator(".dashboard-figures .dashboard-figure")
        page.wait_for_timeout(500)
        labels = [
            h for h in page.locator(".dashboard-figure .dashboard-figure-label").all()
            if h.is_visible() and h.inner_text().strip()
        ]
        r.info.update(tiles=tiles.count(), visible_hints=len(labels))
        r.expect(tiles.count() == 4, f"{tiles.count()} dashboard figures")
        r.expect(len(labels) == 4, f"{len(labels)} visible figure labels")
        s.nav("/search")
        r.expect(page.locator("h1").count() == 1, "Search has no single h1")

    runner.run("F06", s, f06, "library-details")
    runner.run("S06", s, s06_tiles, "dashboard")


def new_user_check(runner: Runner, variant: Variant):
    """S06: a new, empty account sees Get started and its links."""
    s = Session(runner, variant, "new-user")
    try:
        s.login(runner.args.new_email)

        def check(r):
            s.nav("/")
            s.page.wait_for_timeout(800)
            section = s.page.locator("#dashboard-get-started")
            r.expect(section.count() == 1, "no Get started section")
            links = s.page.locator(
                "section:has(#dashboard-get-started) a, [aria-labelledby=dashboard-get-started] a"
            ).count()
            r.info.update(links=links, screenshot=s.shot("dashboard-new-user"))
            r.expect(links >= 1, "Get started has no links")

        runner.run("S06", s, check, "new-user")
    finally:
        s.close()


def library_count(s: Session) -> int:
    text = s.page.locator(".library-count").inner_text()
    numbers = [int(n.replace(",", "")) for n in re.findall(r"\d[\d,]*", text)]
    return numbers[-1] if numbers else -1


def library_checks(runner: Runner, s: Session):
    page = s.page
    cols = runner.collections

    def filters(r):
        s.nav("/library")
        total = library_count(s)
        r.info["total"] = total
        r.expect(total >= 400, f"Library total {total} < 400 (seed --papers 400)")
        s.nav("/library?q=demo%200007")
        r.info["q"] = library_count(s)
        r.expect(0 < r.info["q"] < total, f"q filter total {r.info['q']}")
        toggle = page.locator(".library-filters-bar button[aria-controls]")
        if s.variant.compact and toggle.count():
            toggle.first.click()
        # The first filter chip is Reading state; its listbox starts with "Any state".
        page.locator(".library-filters-panel button[aria-haspopup=listbox]").first.click()
        options = page.locator("[role=listbox] [role=option]")
        options.first.wait_for(timeout=10000)
        if options.count() > 1:
            options.nth(1).click()
            page.wait_for_timeout(300)
            s.settle()
            r.info["state_url"] = page.evaluate("() => location.search")
            r.expect(
                "state=" in r.info["state_url"] or "q=" in r.info["state_url"],
                "state filter not in the URL",
            )
        if "demo1" in cols:
            s.nav(f"/library?collection_id={cols['demo1']}")
            r.info["collection"] = library_count(s)
            r.expect(0 < r.info["collection"] < total, f"collection filter {r.info['collection']}")
        r.info["screenshot"] = s.shot("library-filters")

    def perf(r):
        s.nav("/library")
        clicks, timings = 0, []
        while clicks < 25:
            more = page.locator(".load-more button")
            if not more.count():
                break
            before = page.locator(".library-list > *").count()
            start = time.time()
            more.click()
            page.wait_for_function(
                f"() => document.querySelectorAll('.library-list > *').length > {before}",
                timeout=20000,
            )
            timings.append(round((time.time() - start) * 1000))
            clicks += 1
        shown = page.locator(".library-list > *").count()
        page.evaluate("() => { window.__longTasks = []; }")
        page.evaluate(
            """async () => { const step = Math.round(innerHeight * 0.8);
              for (let y = 0; y < document.documentElement.scrollHeight; y += step) {
                window.scrollTo(0, y); await new Promise((r) => setTimeout(r, 40)); } }"""
        )
        page.wait_for_timeout(500)
        tasks = page.evaluate("() => window.__longTasks || []")
        supported = page.evaluate("() => window.__longTaskSupported === true")
        r.info.update(
            long_task_api=supported,
            entries=shown,
            load_more_clicks=clicks,
            load_more_ms=timings,
            long_tasks_ms=sorted(tasks, reverse=True)[:10],
        )
        r.expect(shown >= 400, f"only {shown} entries after {clicks} Show more clicks")
        if not supported:  # e.g. WebKit: an empty list would prove nothing
            r.info["note"] = "longtask PerformanceObserver unsupported: long tasks not measured"
            return
        r.expect(
            not any(t > LONG_TASK_LIMIT_MS for t in tasks),
            f"long task over {LONG_TASK_LIMIT_MS} ms while scrolling: {max(tasks or [0])} ms",
        )

    def back_restores(r):
        s.nav("/library?q=demo")
        for _ in range(2):
            more = page.locator(".load-more button")
            if more.count():
                more.click()
                s.settle()
        page.evaluate(
            "() => window.scrollTo(0, Math.round(document.documentElement.scrollHeight / 2))"
        )
        page.wait_for_timeout(400)
        before = page.evaluate(
            "() => ({url: location.pathname + location.search, y: scrollY, "
            "n: document.querySelectorAll('.library-list > *').length})"
        )
        clicked = page.evaluate(
            """() => { const links = [...document.querySelectorAll('.library-list a[href^="/graph/"]')];
              const link = links.find((a) => { const r = a.getBoundingClientRect();
                return r.top > 80 && r.bottom < innerHeight - 80; });
              if (!link) return false; link.click(); return true; }"""
        )
        if not clicked:
            raise Skip("no Explore graph link in the viewport")
        page.wait_for_timeout(1500)
        r.info["graph_page"] = page.evaluate("() => location.pathname")
        page.go_back()
        samples = []
        for _ in range(12):  # how scrollY evolves after Back (restore timing)
            page.wait_for_timeout(250)
            samples.append(
                page.evaluate("() => [Math.round(scrollY), document.documentElement.scrollHeight]")
            )
        r.info["samples_y_height"] = samples
        s.settle()
        after = page.evaluate(
            "() => ({url: location.pathname + location.search, y: scrollY, "
            "n: document.querySelectorAll('.library-list > *').length})"
        )
        r.info.update(before=before, after=after)
        r.expect(after["url"] == before["url"], "filters lost after back")
        r.expect(after["n"] >= before["n"], f"pages lost after back: {after['n']} < {before['n']}")
        r.expect(abs(after["y"] - before["y"]) < 150, f"scrollY {after['y']} != {before['y']}")

    def focus_link(r):
        s.nav("/library")
        captured = []

        def grab(response):
            if re.search(r"/api/v1/library/entries\?", response.url) and response.status == 200:
                page_no = int((parse_qs(urlparse(response.url).query).get("page") or ["1"])[0])
                if page_no >= 3:
                    with contextlib.suppress(Exception):
                        captured.append(response.json())

        page.on("response", grab)
        try:
            for _ in range(2):
                more = page.locator(".load-more button")
                if not more.count():
                    break
                more.click()
                s.settle()
        finally:
            page.remove_listener("response", grab)
        items = [i for data in captured for i in data.get("items", []) if i.get("primary_version")]
        if not r.expect(items, "no resolved entry beyond the first two pages"):
            return
        entry = items[-1]
        key, title = entry["paper_group_key"], entry["primary_version"]["title"]
        r.info.update(group_key=key, title=title)
        s.nav("/library")
        s.nav(f"/library?focus={quote(key, safe='')}")
        dialog = page.locator("[role=dialog]").first
        dialog.wait_for(timeout=20000)
        name = dialog.evaluate(DIALOG_NAME_JS)
        r.info["dialog"] = name
        r.expect(
            norm_title(title)[:40] in norm_title(name),
            f"?focus= opened {name[:80]!r}, not {title[:60]!r}",
        )
        page.keyboard.press("Escape")
        page.wait_for_timeout(400)

    runner.run("S02-library", s, filters, "library-filters")
    runner.run("S02-library", s, focus_link, "focus-deep-link")
    runner.run("S02-perf", s, perf, "library-400")
    runner.run("S02-library", s, back_restores, "graph-back")


def wait_search(s: Session, timeout=60000):
    s.page.wait_for_function(
        "() => document.querySelector('.search-result, .empty-state') || "
        "/Try again|Riprova|error/i.test(document.querySelector('.search-status-text')?.innerText || '')",
        timeout=timeout,
    )
    s.settle()


def search_checks(runner: Runner, s: Session):
    page = s.page
    q = quote(SEARCH_Q)

    def status_and_more(r):
        s.nav(f"/search?q={q}")
        wait_search(s)
        status = page.locator("[data-testid=search-status]")
        r.info["status"] = status.inner_text()
        r.expect("Semantic Scholar" in r.info["status"], "status line does not name the provider")
        before = page.locator(".search-result").count()
        more = page.locator(".load-more button")
        if r.expect(more.count(), f"no Show more after {before} results"):
            more.click()
            page.wait_for_function(
                f"() => document.querySelectorAll('.search-result').length > {before}",
                timeout=60000,
            )
            r.info["results"] = [before, page.locator(".search-result").count()]

    def filters(r):
        s.nav(f"/search?q={q}")
        wait_search(s)
        # The first toggle chip of the row is Open access (phones show it in the chip row too).
        page.locator(".search-filters-row button[aria-pressed]").first.click()
        page.wait_for_timeout(600)
        wait_search(s)
        url = page.evaluate("() => location.search")
        r.info["url"] = url
        r.expect("oa=1" in url, "Open access toggle not in the URL")
        # Wide screens: a Reset text action in the chip row; phones: Reset in the Filters sheet.
        open_filters_sheet(s)
        reset = page.locator(f"{FILTERS_RESET}, {SHEET_RESET}")
        r.expect(reset.count() == 1, f"{reset.count()} active-filter resets, not 1")
        reset.first.click()
        page.wait_for_timeout(600)
        s.close_overlays()
        r.expect("oa=1" not in page.evaluate("() => location.search"), "reset kept oa=1")

    def versions(r):
        s.nav(f"/search?q={q}")
        wait_search(s)
        groups = page.locator("[role=radiogroup]")
        dupes = []
        for index in range(groups.count()):
            names = (
                groups.nth(index)
                .locator("[role=radio]")
                .evaluate_all(
                    "(rs) => rs.map((x) => (x.getAttribute('aria-label') || x.innerText).trim())"
                )
            )
            if len(set(names)) != len(names):
                dupes.append(names)
        r.info["radiogroups"] = groups.count()
        if not groups.count():
            raise Skip("no multi-version result in the live data (see F08 collection graph)")
        r.expect(not dupes, f"duplicate radio names: {dupes[:2]}")

    def possible_version(r):
        s.nav(f"/search?q={q}")
        wait_search(s)
        show = page.locator(".possible-version-note button, .possible-version button")
        if not show.count():
            raise Skip("no possible-version hint in the live results")
        show.first.click()
        page.wait_for_timeout(800)
        focus = page.evaluate("() => document.activeElement && document.activeElement.className")
        r.info["focused"] = focus
        r.expect("search-result" in (focus or ""), f"Show focused {focus!r}, not the result")

    runner.run("S03", s, status_and_more, "search-status", provider=True)
    runner.run("S02-search", s, filters, "search-filters", provider=True)
    runner.run("F08", s, versions, "search-radios")
    runner.run("S04", s, possible_version, "possible-version")


# The chip row's active chips name the applied filters: "Year: 2019–2021", "Sort Most cited"
# (wide), or "Filters · 2", "2019–2021", "Most cited" (phones). The personal toggles
# (signed in only) are left out, so a signed-out copy of the URL shows the same.
FILTERS_RESET = ".search-filters-row > button.btn-quiet"
SHEET_RESET = ".search-sheet-header button.btn-quiet"
FILTERS_SHEET_BUTTON = ".search-filters--compact .search-filters-row button[aria-haspopup=dialog]"


def filters_state(s: Session) -> dict:
    return s.page.evaluate(
        r"""() => ({url: location.pathname + location.search,
                   q: document.querySelector('.search-input')?.value ?? null,
                   row: [...document.querySelectorAll('.search-filters-row .chip--active')]
                     .map((c) => c.innerText.replace(/\s+/g, ' ').trim()).join(' | ')})"""
    )


def open_filters_sheet(s: Session) -> bool:
    """Phones: open the Filters sheet (True); wide screens have no sheet (False)."""
    button = s.page.locator(FILTERS_SHEET_BUTTON)
    if not button.count():
        return False
    button.first.click()
    s.page.locator(".search-sheet").wait_for(timeout=10000)
    s.page.wait_for_timeout(250)
    return True


def apply_years_and_sort(s: Session, year_from: str, year_to: str):
    """Years through the Year popover (wide) or the sheet (phones), then Most cited."""
    page = s.page
    cited = re.compile("Most cited|Più citati")
    if open_filters_sheet(s):
        sheet = page.locator(".search-sheet")
        years = sheet.locator("input[type=number]")
        years.nth(0).fill(year_from)
        years.nth(1).fill(year_to)
        sheet.locator("[role=radio]").filter(has_text=cited).first.click()
        sheet.locator(".search-sheet-submit").click()
        page.wait_for_timeout(500)
        wait_search(s)
        return
    page.locator(".search-filters-row button[aria-haspopup=dialog]").first.click()
    popover = page.locator("[data-testid=search-year-popover]")
    popover.wait_for(timeout=10000)
    years = popover.locator("input[type=number]")
    years.nth(0).fill(year_from)
    years.nth(1).fill(year_to)
    popover.locator("button[type=submit]").click()
    page.wait_for_timeout(500)
    wait_search(s)
    page.locator(".search-filters-row button[aria-haspopup=listbox]").first.click()
    page.locator("[role=listbox] [role=option]").filter(has_text=cited).first.click()
    page.wait_for_timeout(1500)
    wait_search(s)


def search_history_checks(runner: Runner, s: Session):
    """F07: URL state across reload, a copied URL and back; history grows only on submit."""

    def check(r):
        s.new_tab()
        page = s.page
        s.goto("/search")
        page.wait_for_timeout(300)
        field = page.locator(".search-input")
        field.fill("")
        h0 = page.evaluate("() => history.length")
        field.type("graph neur", delay=15)
        r.expect(page.evaluate("() => history.length") == h0, "typing changed history.length")
        field.fill(F07_Q)
        field.press("Enter")
        wait_search(s)
        h1 = page.evaluate("() => history.length")
        r.info["history"] = [h0, h1]
        r.expect(h1 == h0 + 1, f"submit changed history.length by {h1 - h0}, not 1")
        apply_years_and_sort(s, "2019", "2021")
        want = filters_state(s)
        r.info["state"] = want
        for shown in ("2019", "2021", "Most cited"):
            r.expect(shown in want["row"], f"chip row {want['row']!r} does not show {shown!r}")
        query = parse_qs(urlparse(want["url"]).query)
        expected = {"q": [F07_Q], "year_from": ["2019"], "year_to": ["2021"], "sort": ["citations"]}
        for key, value in expected.items():
            r.expect(query.get(key) == value, f"{key}={query.get(key)} in the URL {want['url']}")
        s.reload()
        wait_search(s)
        got = filters_state(s)
        r.expect(got == want, f"after reload {got}")
        fresh = Session(runner, s.variant, "copied-url")
        try:
            fresh.goto(want["url"])
            wait_search(fresh)
            copied = filters_state(fresh)
            r.expect(copied == want, f"copied URL in a new context gives {copied}")
        finally:
            fresh.close()
        s.nav("/library")
        page.go_back()
        page.wait_for_timeout(800)
        wait_search(s)
        back = filters_state(s)
        r.expect(back["url"] == want["url"] and back["q"] == want["q"], f"after back {back}")

    runner.run("F07", s, check, "search-url", provider=True)


def logout_clears_search(runner: Runner, s: Session):
    def check(r):
        s.logout()
        s.nav("/search")
        page = s.page
        page.wait_for_timeout(500)
        state = filters_state(s)
        r.info["state"] = state
        r.expect(
            state["q"] == "" and state["url"] == "/search", f"search kept after logout: {state}"
        )

    runner.run("F07", s, check, "logout")


def links_check(runner: Runner, s: Session):
    """S07: GNN details: Figshare is 'Full text / Repository', S2 is its own chip, new-tab text."""
    page = s.page

    def check(r):
        open_graph(s, f"/graph/{quote(GNN_KEY, safe='')}")
        select_from_list(s, GNN_TITLE)
        if s.variant.compact:
            page.locator("[data-testid=graph-controls-sheet] [role=tab]").nth(0).click()
            scope = page.locator("[data-testid=graph-controls-sheet]")
        else:
            scope = page.locator("[data-testid=graph-node-popup]")
        scope.locator("button").filter(has_text="View details").first.click()
        panel = page.locator("[role=dialog]").last
        panel.locator("a.link-chip").first.wait_for(timeout=30000)
        page.wait_for_timeout(500)
        chips = panel.locator("a.link-chip").evaluate_all(
            "(as) => as.map((a) => ({href: a.href, text: a.innerText.trim(), "
            "sr: a.querySelector('.sr-only')?.textContent || ''}))"
        )
        r.info.update(chips=chips, screenshot=s.shot("details-gnn-links"))
        fig = [c for c in chips if GNN_FIGSHARE in c["href"]]
        if r.expect(fig, "no Figshare full-text chip"):
            r.expect(fig[0]["text"].startswith("Full text / Repository"), f"Figshare chip {fig[0]}")
        s2 = [c for c in chips if "semanticscholar.org/paper/" in c["href"]]
        if r.expect(s2, "no Semantic Scholar chip"):
            r.expect(s2[0]["text"].startswith("View on Semantic Scholar"), f"S2 chip {s2[0]}")
        missing = [c["text"] for c in chips if "(opens in a new tab)" not in c["sr"]]
        r.expect(not missing, f"chips without new-tab text: {missing}")
        s.close_overlays()

    runner.run("S07", s, check, "gnn-details", provider=True)


# --------------------------------------------------------------------------- graph

CANVAS = "[data-testid=citation-graph]"
SHEET = "[data-testid=graph-controls-sheet]"


def canvas_state(s: Session) -> dict:
    return s.page.locator(CANVAS).evaluate(
        """(el) => { const r = el.getBoundingClientRect();
          return {rect: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)],
                  zoom: el.dataset.zoom || null, cx: el.dataset.cx || null, cy: el.dataset.cy || null}; }"""
    )


def graph_controls(s: Session) -> list:
    page = s.page
    selectors = [
        ("home", ".graph-home"),
        ("back", ".graph-back"),
        ("fit/zoom", ".graph-header-actions .graph-view-btn"),
        ("controls trigger", ".graph-controls-trigger"),
        ("segmented", ".graph-bottombar .graph-segmented button"),
        ("range", ".graph-bottombar .graph-range-btn"),
        ("summary", ".graph-summary button"),
    ]
    out = []
    for name, selector in selectors:
        loc = page.locator(selector)
        for index in range(loc.count()):
            if loc.nth(index).is_visible():
                out.append((f"{name} {index + 1}", loc.nth(index)))
    return out


def graph_layout_checks(runner: Runner, s: Session):
    page = s.page
    v = s.variant
    path = f"/graph/{quote(GNN_KEY, safe='')}"

    def sheet(r):
        if not v.compact:
            raise Skip("desktop layout")
        open_graph(s, path)
        r.expect(page.locator(".graph-bottombar").count() == 0, "bottom bar on a compact screen")
        trigger = page.locator(".graph-controls-trigger")
        r.expect(trigger.is_visible(), "no Graph controls trigger")
        r.expect(page.locator(".graph-header-actions .graph-view-btn").first.is_visible(), "no Fit")
        page.locator(".graph-header-actions .graph-view-btn").first.click()
        page.wait_for_timeout(900)
        before = canvas_state(s)
        dialog = open_dialog(s, trigger)
        name = dialog.evaluate(DIALOG_NAME_JS)
        r.info.update(name=name, sheet_shot=s.shot("graph-sheet"))
        if v.lang == "en":
            r.expect(name.startswith("Graph controls"), f"sheet named {name!r}")
        r.expect(dialog.locator("[role=radiogroup]").count() >= 2, "no Direction/Order groups")
        r.expect(dialog.locator("select").count() == 0, "a <select> in the sheet")
        r.expect("Expand entire graph" not in dialog.inner_text(), "'Expand entire graph' shown")
        r.expect(page.evaluate("() => !!document.getElementById('root')?.inert"), "#root not inert")
        body = dialog.locator(".panel-body")
        body.evaluate("(b) => { b.scrollTop = b.scrollHeight; }")
        page.wait_for_timeout(300)
        last = dialog.locator("button:visible").last
        hit = last.evaluate(
            """(el) => { const r = el.getBoundingClientRect();
              const h = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
              return {ok: !!h && (h === el || el.contains(h)), bottom: r.bottom, vh: innerHeight}; }"""
        )
        r.info["last_control"] = hit
        r.expect(hit["ok"], "the sheet's last control is not hit-testable")
        r.expect(
            hit["bottom"] <= hit["vh"] - v.safe_area + 0.5,
            f"last control bottom {round(hit['bottom'])} inside the safe area",
        )
        page.keyboard.press("Escape")
        page.wait_for_timeout(500)
        r.expect(page.locator(SHEET).count() == 0, "Escape left the sheet open")
        r.expect(trigger.evaluate("(el) => el === document.activeElement"), "focus not on trigger")
        after = canvas_state(s)
        r.info.update(before=before, after=after)
        r.expect(
            after["rect"] == before["rect"], f"canvas rect {after['rect']} != {before['rect']}"
        )
        r.expect(
            (after["zoom"], after["cx"], after["cy"])
            == (before["zoom"], before["cx"], before["cy"]),
            "zoom/position changed across the sheet",
        )

    def desktop(r):
        if v.compact:
            raise Skip("compact layout")
        open_graph(s, path)
        bar = page.locator(".graph-bottombar")
        if not r.expect(bar.count() and bar.is_visible(), "no bottom bar"):
            return
        box = s.rect(bar)
        inner_h = page.evaluate("() => innerHeight")
        r.expect(box["y"] + box["height"] <= inner_h + 1, f"bar ends at {box['y'] + box['height']}")
        rows = [s.rect(row) for row in bar.locator(".graph-bar-row").all()]
        for i, a in enumerate(rows):
            for b in rows[i + 1 :]:
                r.expect(not rect_overlap(a, b), "bottom bar rows overlap")
        canvas = canvas_state(s)["rect"]
        r.expect(
            canvas[1] + canvas[3] <= box["y"] + 1, f"canvas bottom {canvas[1] + canvas[3]} > bar"
        )
        r.info["screenshot"] = s.shot("graph-desktop")

    def targets(r):
        open_graph(s, path)
        controls = graph_controls(s)
        sizes, small, misses = {}, [], {}
        for name, loc in controls:
            box = s.rect(loc)
            if not box:
                continue
            sizes[name] = [round(box["width"]), round(box["height"])]
            if v.touch and (box["width"] < TOUCH_MIN - 0.5 or box["height"] < TOUCH_MIN - 0.5):
                small.append(name)
            hits = s.edge_hits(loc)
            if not all(hits):
                misses[name] = hits
        r.info.update(sizes=sizes, misses=misses)
        r.expect(not small, f"under 44px: {small}")
        r.expect(not misses, f"edge taps miss: {sorted(misses)}")

    def header(r):
        open_graph(s, path)
        data = page.evaluate(GRAPH_HEADER_JS)
        if not r.expect(data, "no .graph-header-row"):
            return
        items = data["items"]
        r.info.update(items=[i["name"] for i in items], seed=data["seed"])
        r.expect(
            data["scrollWidth"] <= data["clientWidth"] + 1,
            f"graph header overflows: {data['scrollWidth']} > {data['clientWidth']}",
        )
        for i, a in enumerate(items):
            r.expect(a["x"] + a["width"] <= data["innerWidth"] + 1, f"'{a['name']}' past the edge")
            for b in items[i + 1 :]:
                r.expect(not rect_overlap(a, b), f"'{a['name']}' overlaps '{b['name']}'")
        seed = data["seed"]
        if not r.expect(seed, "no seed title in the graph header"):
            return
        r.expect(
            # The h1 starts with "Citation graph · N pinned": compare the whole text, not
            # norm_title's 60-character prefix.
            norm_title(GNN_TITLE) in " ".join(data["h1"].split()).lower(),
            f"seed title not in the h1's accessible text: {data['h1'][:80]!r}",
        )
        clipped = seed["scrollWidth"] > seed["clientWidth"] + 1
        if clipped:
            r.expect(seed["overflow"] == "ellipsis", "clipped seed title without an ellipsis")
            r.expect(
                seed["clientWidth"] >= SEED_TITLE_MIN_PX,
                f"seed title clipped to {seed['clientWidth']}px of {seed['scrollWidth']}px",
            )
        r.info["screenshot"] = s.shot("graph-header")

    runner.run("F04-header", s, header, "graph-header", provider=True)
    runner.run("F04-sheet", s, sheet, "graph", provider=True)
    runner.run("F04-desktop", s, desktop, "graph")
    runner.run("F10-targets", s, targets, "graph")


def controls_root(s: Session):
    """Where Direction/Order/ranges live: the bottom bar, or the sheet's Controls tab."""
    page = s.page
    if not s.variant.compact:
        return page.locator(".graph-bottombar")
    if not page.locator(SHEET).count():
        page.locator(".graph-controls-trigger").click()
        page.locator(SHEET).wait_for()
    page.locator(f"{SHEET} [role=tab]").nth(0).click()
    return page.locator(SHEET)


def wait_range(s: Session, start_index: int, timeout=180) -> dict | None:
    """The first ranked /graph/related response after ``start_index`` (clicks Continue on stalls)."""
    page = s.page
    deadline = time.time() + timeout
    while time.time() < deadline:
        for item in s.related[start_index:]:
            if item.get("data") is None and item["status"] == 200:
                try:
                    item["data"] = item["response"].json()
                except Exception:
                    item["data"] = {}
            data = item.get("data") or {}
            if (
                item["status"] == 200
                and data.get("nodes") is not None
                and not (data.get("scan_incomplete") and data.get("reason") == "ranking")
                and (data.get("nodes") or data.get("exhausted"))
            ):
                page.wait_for_timeout(700)
                return data
            if item["status"] >= 400:
                if "body" not in item:
                    item["body"] = ""
                    with contextlib.suppress(Exception):
                        item["body"] = item["response"].text()[:300]
                if classify_problem(item["status"], item["body"]) == "provider":
                    raise Skip(f"provider unavailable: /graph/related answered {item['status']}")
                raise AssertionError(
                    f"/graph/related answered {item['status']}: {item['body'][:200]}"
                )
        stall = page.locator(".graph-status-line button").filter(has_text="Continue")
        if stall.count() and stall.first.is_visible():
            stall.first.click()
        page.wait_for_timeout(500)
    return None


def list_sections(s: Session) -> dict:
    """Section heading (without the count) -> row titles, from the Papers list.

    The current range's heading names its bounds ("Current range · 31–60"): the rows go
    under "Current range" and the bounds under the ``RANGE_BOUNDS`` key.
    """
    root = open_papers_list(s)
    data = root.evaluate(
        """(root) => [...root.querySelectorAll('.graph-list-section')].map((sec) => ({
          heading: sec.querySelector('.graph-list-heading').firstChild.textContent.trim(),
          rows: [...sec.querySelectorAll('.graph-list-name')].map((n) => n.innerText.trim())}))"""
    )
    if s.variant.compact:
        s.close_overlays()
    out = {}
    for d in data:
        name, _, bounds = d["heading"].partition(" · ")
        out[name] = d["rows"]
        if bounds:
            out[RANGE_BOUNDS] = bounds
    return out


RANGE_BOUNDS = "__range_bounds__"


def expected_range(data: dict) -> list[str]:
    by_id = {n["id"]: n for n in data.get("nodes", [])}
    return [
        norm_title(by_id[g]["selected_version"].get("title") or "")
        for g in data.get("group_keys", [])
        if g in by_id
    ]


def compare_range(r: Result, s: Session, data: dict, label: str):
    sections = list_sections(s)
    pinned = {norm_title(t) for t in sections.get("Pinned", [])}
    visible = [norm_title(t) for t in sections.get("Current range", [])]
    expected = [t for t in expected_range(data) if t not in pinned]
    r.info[label] = {
        "range": [data.get("range_start"), data.get("range_end")],
        "visible": len(visible),
        "expected": len(expected),
        "bounds": sections.get(RANGE_BOUNDS),
    }
    if data.get("range_start") is not None and data.get("range_end") is not None:
        want = f"{data['range_start'] + 1:,}–{data['range_end']:,}"
        if s.variant.lang == "en" and sections.get(RANGE_BOUNDS) != want:
            r.failures.append(
                f"{label}: Current range heading bounds {sections.get(RANGE_BOUNDS)!r} != {want!r}"
            )
    if visible != expected:
        diff = [
            (i, a, b) for i, (a, b) in enumerate(zip(visible, expected, strict=False)) if a != b
        ][:3]
        r.failures.append(
            f"{label}: Current range ({len(visible)}) != response group_keys "
            f"({len(expected)}); first differences {diff}"
        )
    return sections


def click_range(s: Session, which: str):
    """which: 'current', 'next' (first range after the current one) or 'last'."""
    root = controls_root(s)
    buttons = root.locator(".graph-range-nav .graph-range-btn")
    if which == "current":
        target = root.locator(".graph-range-btn[aria-current=true]").first
    elif which == "last":
        target = buttons.last
    else:
        index = buttons.evaluate_all(
            "(bs) => bs.findIndex((b, i) => i > 0 && bs[i - 1].getAttribute('aria-current') === 'true')"
        )
        if index < 0:
            raise Skip("no range after the current one")
        target = buttons.nth(index)
    label = target.inner_text().strip()
    target.click()
    return label


def toggle_mode(s: Session, group: int, option: int):
    root = controls_root(s)
    root.locator(".graph-segmented").nth(group).locator("button").nth(option).click()


def node_count_text(s: Session) -> str:
    # Papers and links only: the pin count that follows them changes with every pin.
    loc = s.page.locator(".graph-counts > span:not(.graph-counts-pins)")
    return loc.first.inner_text() if loc.count() else ""


def exploration_checks(runner: Runner, s: Session):
    """S01: select, ranges vs response, deep ranges, mode switches, pins, resize, failures."""
    page = s.page
    v = s.variant
    path = f"/graph/{quote(GNN_KEY, safe='')}"
    ctx: dict = {}

    def select(r):
        open_graph(s, path)
        mark = s.mark()
        select_from_list(s, GNN_TITLE)
        root = controls_root(s)
        current = root.locator(".graph-range-btn[aria-current=true]")
        r.expect(current.count() == 1, "no current range after selecting")
        if current.count():
            r.expect(
                current.first.inner_text().strip().startswith("1–30"), "current range is not 1–30"
            )
        page.wait_for_timeout(1500)
        sent = s.requests_since(mark, r"/graph/related")
        r.expect(not sent, f"selecting sent {len(sent)} /graph/related request(s)")
        before = canvas_state(s) if v.compact else None
        start = len(s.related)
        click_range(s, "current")
        if v.compact:
            page.wait_for_timeout(500)
            r.expect(page.locator(SHEET).count() == 0, "loading a range left the sheet open")
            r.expect(
                canvas_state(s)["rect"] == before["rect"] if before else True,
                "canvas rect not restored after the sheet closed",
            )
        data = wait_range(s, start)
        if not r.expect(data, "no ranked /graph/related response"):
            return
        ctx["first"] = data
        compare_range(r, s, data, "cited_by/cited_by_count 1-30")

    def deep(r):
        if "first" not in ctx:
            raise Skip("needs S01-select")
        start = len(s.related)
        r.info["clicked"] = click_range(s, "last")
        data = wait_range(s, start)
        if not r.expect(data, "no response for the last range"):
            return
        r.expect(data["range_start"] >= 30, f"last range starts at {data['range_start']}")
        summary = controls_root(s).locator(".graph-range-summary")
        r.info["summary"] = summary.inner_text() if summary.count() else None
        r.expect(r.info["summary"] and " of " in r.info["summary"], "range summary lacks 'of'")
        old = set(expected_range(data))
        compare_range(r, s, data, "cited_by last")
        start = len(s.related)
        toggle_mode(s, 1, 1)  # Most recent
        data = wait_range(s, start)
        if not r.expect(
            data and data["order"] == "recent" and data["range_start"] == 0,
            "order switch did not auto-load 1-30 (recent)",
        ):
            return
        sections = compare_range(r, s, data, "cited_by/recent 1-30")
        new = set(expected_range(data))
        stale = [
            t
            for t in sections.get("Other papers on the graph", [])
            if norm_title(t) in old and norm_title(t) not in new
        ]
        r.expect(not stale, f"{len(stale)} unpinned papers of the old order stayed on the graph")
        start = len(s.related)
        r.info["deep_recent"] = click_range(s, "next")
        data = wait_range(s, start)
        if r.expect(data and data["range_start"] >= 30, "no deep range in recent order"):
            compare_range(r, s, data, "cited_by/recent 31-60")
        start = len(s.related)
        toggle_mode(s, 0, 1)  # References
        data = wait_range(s, start)
        if r.expect(
            data and data["direction"] == "cites", "direction switch did not load references"
        ):
            compare_range(r, s, data, "cites 1-30")
            ctx["refs"] = data

    def capped(r):
        open_graph(s, f"/graph/{quote(CAPPED_KEY, safe='')}")
        seed = page.locator(".graph-title-seed")
        title = seed.first.text_content().lstrip(": ").strip() if seed.count() else ""
        if not r.expect(title, "no seed title in the graph header"):
            return
        select_from_list(s, title[:40])
        if v.compact:
            s.close_overlays()

        def label() -> str:
            loc = controls_root(s).locator(".graph-range-summary")
            return loc.first.inner_text() if loc.count() else ""

        def check_label(text: str, where: str):
            match = CAPPED_LABEL_RE.search(text or "")
            if r.expect(match, f"{where}: no 'first 10,000 of N' label in {text!r}"):
                total = int(re.sub(r"\D", "", match.group(1) or match.group(2)))
                r.expect(total > 10000, f"{where}: capped label with a total of {total}")

        start = len(s.related)
        click_range(s, "current")
        data = wait_range(s, start)
        if not r.expect(data, "the first range did not load"):
            return
        r.info.update(provider_total=data.get("provider_total"), first_label=label())
        check_label(r.info["first_label"], "first range")
        start = len(s.related)
        r.info["clicked"] = click_range(s, "last")
        data = wait_range(s, start)
        if not r.expect(data, "the last range did not load"):
            return
        r.info.update(
            last_range=[data.get("range_start"), data.get("range_end")], last_label=label()
        )
        check_label(r.info["last_label"], "last range")
        r.info["screenshot"] = s.shot("graph-capped")

    def pins(r):
        if "refs" not in ctx and "first" not in ctx:
            raise Skip("needs a loaded range")
        data = ctx.get("refs") or ctx["first"]
        root = open_papers_list(s)
        section = root.locator(".graph-list-section").filter(has_text="Current range")
        row = section.locator(".graph-list-row").first
        title = norm_title(row.locator(".graph-list-name").inner_text())
        group = next(
            (
                g
                for g in data["group_keys"]
                for n in data["nodes"]
                if n["id"] == g and norm_title(n["selected_version"].get("title") or "") == title
            ),
            None,
        )
        counts = node_count_text(s)
        mark = s.mark()
        row.locator(".graph-pin-toggle").click()
        page.wait_for_timeout(1500)
        r.expect(not s.requests_since(mark, r"/graph/related"), "pinning sent a request")
        r.expect(node_count_text(s) == counts, "pinning changed the graph")
        if v.compact:
            s.close_overlays()
        start, mark = len(s.related), s.mark()
        click_range(s, "next")
        wait_range(s, start)
        posts = [
            json.loads(x["post"] or "{}")
            for x in s.requests_since(mark, r"/graph/related$", "POST")
        ]
        excluded = posts[-1].get("exclude_group_keys", []) if posts else []
        r.info.update(pinned=title, group=group, excluded=excluded[:5])
        r.expect(group and group in excluded, "the next range did not exclude the new pin")
        canvas = page.locator(CANVAS)
        canvas.click(position={"x": 6, "y": 6})
        page.wait_for_timeout(600)
        root = controls_root(s)
        expand = root.locator(".graph-expand button.btn-primary").first
        if not r.expect(expand.count(), "no Expand pinned nodes with nothing selected"):
            return
        mark = s.mark()
        expand.click()
        page.wait_for_timeout(800)
        confirm = page.locator(".graph-expand-actions .btn-primary")
        if confirm.count() and confirm.first.is_visible():
            confirm.first.click()
        deadline = time.time() + 60
        while time.time() < deadline and not s.requests_since(mark, r"/graph/related/top-up"):
            page.wait_for_timeout(500)
        r.expect(
            s.requests_since(mark, r"/graph/related/top-up"), "Expand pinned made no top-up call"
        )
        s.settle(timeout=60000)

    runner.run("S01-select", s, select, "graph", provider=True)
    runner.run("S01-deep", s, deep, "graph", provider=True)
    # Pins works on the GNN graph that deep leaves open: run it before capped navigates away.
    runner.run("S01-pins", s, pins, "graph", provider=True)
    runner.run("S01-deep", s, capped, "capped-10000", provider=True)
    exploration_more(runner, s, ctx)


def exploration_more(runner: Runner, s: Session, ctx: dict):
    page = s.page
    v = s.variant
    path = f"/graph/{quote(GNN_KEY, safe='')}"

    def unpin_all(r):
        open_graph(s, path)
        root = open_papers_list(s)
        for _ in range(20):
            pressed = root.locator(".graph-pin-toggle[aria-pressed=true]")
            if not pressed.count():
                break
            pressed.first.click()
            page.wait_for_timeout(200)
        if v.compact:
            s.close_overlays()
        expand = controls_root(s).locator(".graph-expand button.btn-primary").first
        r.expect(expand.count() and expand.is_disabled(), "Expand pinned is enabled with no pins")
        hint = controls_root(s).locator(".graph-expand .graph-hint")
        r.info["hint"] = hint.inner_text() if hint.count() else None
        r.expect(r.info["hint"], "no hint next to the disabled button")
        if v.compact:
            s.close_overlays()
        s.reload()
        page.locator(CANVAS).wait_for(timeout=60000)
        pinned = page.locator(".graph-counts-pins").first.text_content() or ""
        r.info["pinned_after_reload"] = pinned
        r.expect(re.search(r"\b1\b", pinned), f"pins not reset to the seed on reload: {pinned!r}")

    def resize(r):
        if v.viewport != "1440x900":
            raise Skip("runs at 1440x900")
        open_graph(s, path)
        select_from_list(s, GNN_TITLE)
        start = len(s.related)
        click_range(s, "current")
        if not r.expect(wait_range(s, start), "range did not load"):
            return
        probe = """() => ({sel: document.querySelector('.graph-list-select[aria-current=true]')?.innerText,
          pinned: document.querySelector('.graph-counts-pins')?.textContent,
          counts: document.querySelector('.graph-counts')?.innerText,
          modes: [...document.querySelectorAll('.graph-segmented [role=radio][aria-checked=true]')]
                   .map((b) => b.innerText)})"""
        before = page.evaluate(probe)
        mark = s.mark()
        page.set_viewport_size({"width": 390, "height": 844})
        page.wait_for_timeout(1200)
        page.set_viewport_size({"width": 1440, "height": 900})
        page.wait_for_timeout(1200)
        after = page.evaluate(probe)
        r.info.update(before=before, after=after)
        r.expect(not s.requests_since(mark, r"/graph/related"), "resizing sent /graph/related")
        r.expect(before == after, "state changed across the resize")

    def failures(r):
        open_graph(s, path)
        select_from_list(s, GNN_TITLE)
        start = len(s.related)
        click_range(s, "current")
        if not r.expect(wait_range(s, start), "range did not load"):
            return
        counts = node_count_text(s)
        s.console_paused = True
        try:
            page.route("**/api/v1/graph/related", lambda route: route.abort())
            click_range(s, "next")
            error = page.locator(".graph-status-line--error")
            error.first.wait_for(timeout=20000)
            r.info["range_error"] = error.first.inner_text()
            r.expect(error.locator("button").count(), "range error without Retry")
            r.expect(node_count_text(s) == counts, "a failed range dropped nodes")
            page.unroute("**/api/v1/graph/related")
            start = len(s.related)
            error.locator("button").first.click()
            r.expect(wait_range(s, start), "Retry after a range failure did not load")
            if v.compact:
                s.close_overlays()
            page.route("**/api/v1/graph/**", lambda route: route.abort())
            s.reload()
            base = page.locator(".graph-base-state[role=alert]")
            base.wait_for(timeout=30000)
            r.info["base_error"] = base.inner_text()
            retry = base.locator("button")
            r.expect(retry.count(), "base error without Retry")
            page.unroute("**/api/v1/graph/**")
            retry.first.click()
            page.locator(CANVAS).wait_for(timeout=60000)
        finally:
            page.unroute_all()
            s.console_paused = False
        r.info["screenshot"] = s.shot("graph-after-retry")

    runner.run("S01-pins", s, unpin_all, "unpin-all")
    runner.run("S01-resize", s, resize, "graph", provider=True)
    runner.run("S01-fail", s, failures, "graph", provider=True)


def version_radio_check(runner: Runner, s: Session):
    """F08: the seeded multi-version paper's radios have unique names (collection graph)."""
    cols = runner.collections

    def check(r):
        if "long" not in cols:
            raise Skip("no long-data collection")
        open_graph(s, f"/graph/collection/{cols['long']}")
        select_from_list(s, VERSIONS_TITLE)
        if s.variant.compact:
            scope = controls_root(s)
        else:
            scope = s.page.locator("[data-testid=graph-node-popup]")
        radios = scope.locator("[role=radiogroup] [role=radio]")
        names = radios.evaluate_all(
            "(rs) => rs.map((x) => (x.getAttribute('aria-label') || x.innerText).trim())"
        )
        r.info.update(names=names, screenshot=s.shot("graph-versions"))
        r.expect(len(names) >= 2, f"{len(names)} version radios on the multi-version paper")
        r.expect(len(set(names)) == len(names), "version radio names are not unique")
        s.close_overlays()

    runner.run("F08", s, check, "collection-graph-versions", provider=True)


# --------------------------------------------------------------------------- phases

GNN_PATH = f"/graph/{quote(GNN_KEY, safe='')}"


def canvas_tap_check(runner: Runner, s: Session):
    """S01 (G19) on a single-seed graph (anonymous, no range loaded): Fit, tap the canvas
    centre to select the seed, zoom in twice, tap again: the selection is kept."""
    page = s.page
    v = s.variant

    def selected_title() -> str:
        # The compact summary, or the desktop popup.
        loc = page.locator(".graph-summary-title, .graph-popup-title")
        return loc.first.inner_text() if loc.count() else ""

    def centre() -> tuple[float, float]:
        box = s.rect(page.locator(CANVAS))
        return box["x"] + box["width"] / 2, box["y"] + box["height"] / 2

    def tap(x, y):
        if v.touch:
            page.touchscreen.tap(x, y)
        else:
            page.mouse.click(x, y)
        page.wait_for_timeout(900)  # also keeps taps apart from the 350 ms double click

    def check(r):
        open_graph(s, f"/graph/{quote(GNN_KEY, safe='')}")
        nodes = node_count_text(s)
        r.info["counts"] = nodes
        r.expect(not selected_title(), "a node is selected before any tap")
        fit = page.locator(".graph-header-actions .graph-view-btn")
        (fit.first if v.compact else fit.last).click()  # Fit (compact: the only view button)
        page.wait_for_timeout(900)
        mark = s.mark()
        tap(*centre())
        first = selected_title()
        r.info["after_tap"] = first
        r.expect(norm_title(GNN_TITLE) in norm_title(first), f"centre tap selected {first!r}")
        zoom_before = float(canvas_state(s)["zoom"] or 0)
        page.mouse.move(*centre())
        for _ in range(2):
            page.mouse.wheel(0, -240)
            page.wait_for_timeout(500)
        page.wait_for_timeout(500)
        zoom_after = float(canvas_state(s)["zoom"] or 0)
        r.info.update(zoom_before=zoom_before, zoom_after=zoom_after)
        r.expect(zoom_after > zoom_before, f"zoom did not grow: {zoom_before} -> {zoom_after}")
        r.expect(
            norm_title(GNN_TITLE) in norm_title(selected_title()), "zooming lost the selection"
        )
        tap(*centre())
        second = selected_title()
        r.info["after_zoomed_tap"] = second
        r.expect(
            norm_title(GNN_TITLE) in norm_title(second), f"tap while zoomed selected {second!r}"
        )
        r.expect(not s.requests_since(mark, r"/graph/related"), "tapping sent /graph/related")
        r.info["screenshot"] = s.shot("graph-canvas-tap")

    runner.run("S01-select", s, check, "canvas-tap", provider=True)


def run_anonymous(runner: Runner, v: Variant):
    s = Session(runner, v, "anon")
    try:
        s.goto("/")
        page_checks(
            runner,
            s,
            [
                ("landing", "/"),
                ("search", f"/search?q={quote(SEARCH_Q)}"),
                ("graph-gnn", GNN_PATH),
                ("privacy", "/privacy"),
                ("terms", "/terms"),
                ("register", "/register"),
            ],
        )
        sticky_search_check(runner, s, "search")
        header_checks(runner, s, "anon")
        footer_check(runner, s, "short-search", f"/search?q={NO_MATCH_Q}", provider=True)
        footer_check(runner, s, "privacy", "/privacy")
        if v.functional and runner.selected("S01-select"):
            canvas_tap_check(runner, s)
    finally:
        s.close()
    if runner.selected("F09"):
        legal_fixture_check(runner, v)


def run_signed_in(runner: Runner, v: Variant):
    s = Session(runner, v, "auth")
    try:
        s.login(runner.args.email)
        cols = discover_collections(runner, s)
        detail = f"/collections/{cols.get('demo1') or cols.get('long') or ''}"
        page_checks(
            runner,
            s,
            [
                ("dashboard", "/"),
                ("search-auth", f"/search?q={quote(SEARCH_Q)}"),
                ("library", "/library"),
                ("collections", "/collections"),
                ("collection-detail", detail),
                ("graph-gnn-auth", GNN_PATH),
                ("settings", "/settings"),
                ("privacy-auth", "/privacy"),
                ("terms-auth", "/terms"),
            ],
        )
        sticky_search_check(runner, s, "search-auth")
        header_checks(runner, s, "auth")
        footer_check(runner, s, "library", "/library")
        last_action_check(runner, s, "library-show-more", "/library", ".load-more button")
        last_action_check(
            runner, s, "search-show-more", f"/search?q={quote(SEARCH_Q)}", ".load-more button"
        )
        last_action_check(
            runner,
            s,
            "collection-last-row",
            detail,
            ".paper-actions a, .paper-actions button, .cd-remove",
        )
        # Phones open Settings on the section index (links); wide screens list every section.
        last_action_check(
            runner, s, "settings-last-button", "/settings", ".app-main button, .app-main a[href]"
        )
        last_action_check(
            runner, s, "settings-delete-button", "/settings#delete-account", ".app-main button"
        )
        dialog_checks(runner, s)
        long_data_checks(runner, s)
        graph_layout_checks(runner, s)
        if runner.selected("contrast"):
            contrast_checks(runner, s)
        if v.functional:
            library_text_checks(runner, s)
            settings_links_check(runner, s)
            library_checks(runner, s)
            search_checks(runner, s)
            links_check(runner, s)
            version_radio_check(runner, s)
            doi_ui_checks(runner, s)
            import_checks(runner, s)
            if any(
                runner.selected(c)
                for c in ("S01-select", "S01-deep", "S01-pins", "S01-resize", "S01-fail")
            ):
                exploration_checks(runner, s)
            search_history_checks(runner, s)
            logout_clears_search(runner, s)
    finally:
        s.close()


def run_new_user(runner: Runner, v: Variant):
    if v.functional and runner.selected("S06"):
        new_user_check(runner, v)


def main(argv=None) -> int:
    args = parse_args(argv)
    if args.browser == "webkit":
        print("note: WebKit is a best-effort Safari proxy (no real iOS)", flush=True)
    return Runner(args).main()


if __name__ == "__main__":
    sys.exit(main())
