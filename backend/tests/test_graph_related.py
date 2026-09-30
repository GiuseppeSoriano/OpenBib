"""Related-paper ranges, ranking snapshots and pinned top-ups (``app.graph.related``).

Semantic Scholar is faked at the registry (``related_page``, ``papers_by_ids``,
``lookup_by_id``) with call counters; Redis is the autouse test Redis
(FakeRedis with Lua, or real Redis in CI).
"""

import asyncio
import json
import time
from datetime import date

import pytest
from redis.exceptions import RedisError
from sqlalchemy import insert, select

from app.config import settings
from app.graph import related
from app.graph.models import PaperGraphEdge
from app.graph.schemas import RelatedRangeRequest, TopUpRequest, TopUpSource
from app.papers.models import CachedPaperMetadata
from app.providers import registry
from app.providers.base import PaperMetadata, RelatedPage
from app.providers.semantic_scholar import ProviderError

SEED = "doi:10.1/seed"
SEED_GROUP = "group:seed"
SEED_ID = "s2seed"
SEED2 = "doi:10.1/seed2"
SEED2_GROUP = "group:seed2"
SEED2_ID = "s2seed2"
DAY0 = date(2000, 1, 1).toordinal()
# Semantic Scholar pages a related list only while offset + limit < 10,000.
S2_LIMIT = 9999


def _entry(n: int, prefix: str = "p", *, group: str | None = None) -> list:
    """Record ``n`` of a fake list: most cited first, oldest first."""
    return [
        f"{prefix}{n}",
        f"doi:10.1/{prefix}{n}",
        group or f"group:{prefix}{n}",
        DAY0 + n,
        100_000 - n,
    ]


def _groups(numbers, prefix: str = "p") -> list[str]:
    return [f"group:{prefix}{n}" for n in numbers]


def _ranked(total: int, order: str) -> list[int]:
    """Record numbers of ``_entry`` lists in rank order."""
    return list(range(total)) if order == "cited_by_count" else list(reversed(range(total)))


def _paper(entry: list, **extra) -> PaperMetadata:
    graph_id, key, group, day, _cited = entry
    return PaperMetadata(
        **{
            "canonical_key": key,
            "paper_group_key": group,
            "title": f"Paper {graph_id}",
            "abstract": "Full abstract",
            "doi": key.removeprefix("doi:") if key.startswith("doi:") else None,
            "semantic_scholar_id": graph_id,
            "publication_date": date.fromordinal(day) if day else None,
            "cited_by_count": 5,
            "provider_source": "semantic_scholar",
            **extra,
        }
    )


class FakeS2:
    """Stands in for the registry's Semantic Scholar calls."""

    def __init__(self):
        self.lists: dict[tuple[str, str], tuple] = {}
        self.served: dict[str, list] = {}
        self.page_calls: list[tuple[str, str, int, int]] = []
        self.id_calls: list[list[str]] = []
        self.lookups: list[str] = []
        self.records: dict[str, PaperMetadata | Exception] = {}
        self.fail: dict[str, Exception] = {}
        self.missing: set[str] = set()
        self.fail_ids: Exception | None = None
        self.delay = 0.0  # added to every page after the first
        self.slow: dict[str, float] = {}
        self.observe = None

    def add(self, graph_id, total, make=_entry, *, direction="cited_by"):
        self.lists[(graph_id, direction)] = (make, total)

    def set_list(self, graph_id, entries, **kwargs):
        self.add(graph_id, len(entries), entries.__getitem__, **kwargs)

    async def related_page(self, paper_id, direction, offset=0, limit=None, fields=None):
        self.page_calls.append((paper_id, direction, offset, limit))
        if self.observe:
            await self.observe()
        await asyncio.sleep(0)
        if paper_id in self.fail:
            raise self.fail[paper_id]
        if offset and self.delay:
            await asyncio.sleep(self.delay)
        if paper_id in self.slow:
            await asyncio.sleep(self.slow[paper_id])
        make, total = self.lists.get((paper_id, direction), (_entry, 0))
        stop = min(offset + min(limit, 1000, S2_LIMIT - offset), total)
        entries = [make(i) for i in range(offset, stop)]
        for entry in entries:
            self.served[entry[0]] = entry
        if stop >= total:
            return RelatedPage(entries)
        if stop >= S2_LIMIT:
            return RelatedPage(entries, capped=True)
        return RelatedPage(entries, next=stop, exhausted=False)

    async def papers_by_ids(self, ids):
        self.id_calls.append(list(ids))
        if self.observe:
            await self.observe()
        if self.fail_ids:
            raise self.fail_ids
        return [None if i in self.missing else _paper(self.served[i]) for i in ids]

    async def lookup_by_id(self, identifier):
        self.lookups.append(identifier)
        record = self.records.get(identifier)
        if isinstance(record, Exception):
            raise record
        return record


@pytest.fixture
def fake(monkeypatch):
    fake = FakeS2()
    monkeypatch.setattr(registry, "related_page", fake.related_page)
    monkeypatch.setattr(registry, "papers_by_ids", fake.papers_by_ids)
    monkeypatch.setattr(registry, "lookup_by_id", fake.lookup_by_id)
    return fake


@pytest.fixture
def small_pages(monkeypatch):
    """100-record pages: a 1,000-record list takes ten pages, four per request."""
    monkeypatch.setattr(settings, "graph_related_chunk_size", 100)


def _cached(key, group, title="Seed", **extra) -> CachedPaperMetadata:
    return CachedPaperMetadata(
        canonical_key=key,
        paper_group_key=group,
        title=title,
        authors_json=[],
        topics_json=[],
        keywords_json=[],
        provider_source="semantic_scholar",
        **extra,
    )


@pytest.fixture
async def seeds(db):
    db.add(
        _cached(
            SEED,
            SEED_GROUP,
            semantic_scholar_id=SEED_ID,
            doi="10.1/seed",
            cited_by_count=1000,
            reference_count=40,
        )
    )
    db.add(_cached(SEED2, SEED2_GROUP, semantic_scholar_id=SEED2_ID, doi="10.1/seed2"))
    await db.flush()


async def _range(db, redis, *, key=SEED, group=SEED_GROUP, saved=(), **body):
    req = RelatedRangeRequest(source_key=key, source_group_key=group, **body)
    source = await related.load_source(db, req.source_key, req.source_group_key)
    return await related.related_range(db, redis, req, source, set(saved))


async def _top_up(db, redis, sources, *, saved=(), **body):
    req = TopUpRequest(sources=[TopUpSource(**spec) for spec in sources], **body)
    loaded = [await related.load_source(db, s.source_key, s.source_group_key) for s in req.sources]
    return await related.related_top_up(db, redis, req, loaded, set(saved))


def _seed_source(connected=(), key=SEED, group=SEED_GROUP) -> dict:
    return {"source_key": key, "source_group_key": group, "connected_group_keys": list(connected)}


def _offsets(fake) -> list[int]:
    return [call[2] for call in fake.page_calls]


# ── Ranges ──────────────────────────────────────────────────


@pytest.mark.parametrize("direction", ["cited_by", "cites"])
@pytest.mark.parametrize("order", ["cited_by_count", "recent"])
async def test_first_range_is_the_first_30_groups(db, redis_backend, fake, seeds, direction, order):
    fake.add(SEED_ID, 100, direction=direction)

    res = await _range(db, redis_backend, direction=direction, order=order)

    expected = _groups(_ranked(100, order)[:30])
    assert res.group_keys == expected
    assert [node.id for node in res.nodes] == expected
    assert (res.range_start, res.range_end, res.range_size) == (0, 30, 30)
    assert (res.total_available, res.total_exact, res.has_more) == (100, True, True)
    assert res.exhausted is False and res.snapshot_id and res.reason is None
    # The source's own count estimates the list: citations or references.
    assert res.provider_total == (1000 if direction == "cited_by" else 40)
    assert res.scanned == 100
    ends = {(edge.source, edge.target) for edge in res.edges}
    if direction == "cited_by":
        assert ends == {(g, SEED_GROUP) for g in expected}
    else:
        assert ends == {(SEED_GROUP, g) for g in expected}
    assert {edge.relation_type for edge in res.edges} == {"cited_by"}
    assert fake.page_calls == [(SEED_ID, direction, 0, 1000)]


def _shuffled(n: int) -> list:
    """Record ``n`` of a list whose citation and date orders both differ from
    the provider's order (and from each other)."""
    return [f"p{n}", f"doi:10.1/p{n}", f"group:p{n}", DAY0 + (n * 91) % 1000, (n * 37) % 1000]


@pytest.mark.parametrize("order", ["cited_by_count", "recent"])
async def test_ranges_271_300_and_991_1000_of_1000_records(db, redis_backend, fake, seeds, order):
    fake.add(SEED_ID, 1000, _shuffled)
    field = 4 if order == "cited_by_count" else 3
    expected = [f"group:p{n}" for n in sorted(range(1000), key=lambda n: -_shuffled(n)[field])]

    middle = await _range(db, redis_backend, order=order, range_start=270)
    last = await _range(db, redis_backend, order=order, last=True)

    assert middle.group_keys == expected[270:300]
    assert (middle.range_start, middle.range_end) == (270, 300)
    assert last.group_keys == expected[990:1000]
    assert (last.range_start, last.range_end) == (990, 1000)
    assert (last.total_available, last.total_exact, last.has_more) == (1000, True, False)
    assert last.exhausted is False and last.clamped is False
    assert len(fake.page_calls) == 1


async def test_one_raw_snapshot_serves_both_orders(db, redis_backend, fake, seeds):
    fake.add(SEED_ID, 1000, _shuffled)

    cited = await _range(db, redis_backend)
    recent = await _range(db, redis_backend, order="recent", range_start=30)
    again = await _range(db, redis_backend, range_start=150)

    assert len(fake.page_calls) == 1
    assert cited.snapshot_id == recent.snapshot_id == again.snapshot_id
    assert cited.group_keys != recent.group_keys


async def test_ties_break_by_canonical_key_and_undated_papers_come_last(
    db, redis_backend, fake, seeds
):
    fake.set_list(
        SEED_ID,
        [
            ["b", "doi:10.1/b", "group:b", None, 5],
            ["c", "doi:10.1/c", "group:c", DAY0, None],
            ["a", "doi:10.1/a", "group:a", DAY0, 5],
            ["d", "s2:d", "group:d", DAY0 + 1, 1],
        ],
    )

    cited = await _range(db, redis_backend)
    recent = await _range(db, redis_backend, order="recent")

    assert cited.group_keys == ["group:a", "group:b", "group:d", "group:c"]
    assert recent.group_keys == ["group:d", "group:a", "group:c", "group:b"]


async def test_a_list_still_being_ranked_serves_no_nodes_until_complete(
    db, redis_backend, fake, seeds, small_pages
):
    fake.add(SEED_ID, 1000)

    first = await _range(db, redis_backend, range_start=270)
    second = await _range(db, redis_backend, range_start=270)

    for res, scanned in ((first, 400), (second, 800)):
        assert (res.reason, res.scan_incomplete, res.scanned) == ("ranking", True, scanned)
        assert (res.nodes, res.edges, res.group_keys) == ([], [], [])
        assert (res.range_start, res.range_end) == (270, 270)
        assert (res.provider_total, res.total_available, res.total_exact) == (1000, 1000, False)
        assert res.has_more is True and res.exhausted is False and res.snapshot_id
    assert fake.id_calls == []

    done = await _range(db, redis_backend, range_start=270)

    assert (done.reason, done.scan_incomplete, done.scanned) == (None, False, 1000)
    assert done.group_keys == _groups(range(270, 300))
    # Four pages per request, each one fetched once.
    assert _offsets(fake) == list(range(0, 1000, 100))
    assert {call[3] for call in fake.page_calls} == {100}


async def test_lists_beyond_10000_records_are_capped_not_refused(db, redis_backend, fake):
    db.add(_cached("doi:10.1/big", "group:big", semantic_scholar_id="big", cited_by_count=50_000))
    await db.flush()
    fake.add("big", 50_000)
    big = {"key": "doi:10.1/big", "group": "group:big"}

    progress = [await _range(db, redis_backend, **big) for _ in range(2)]
    first = await _range(db, redis_backend, **big)
    last = await _range(db, redis_backend, **big, last=True)

    assert [(r.reason, r.scanned) for r in progress] == [("ranking", 4000), ("ranking", 8000)]
    assert all(r.total_capped and r.total_available == 10_000 for r in progress)
    assert first.group_keys == _groups(range(30))
    # Semantic Scholar pages only while offset + limit < 10,000.
    assert _offsets(fake) == list(range(0, 10_000, 1000))
    assert fake.page_calls[-1][3] == 999
    assert (first.provider_total, first.scanned, first.max_results) == (50_000, 9999, 10_000)
    assert (first.total_capped, first.total_exact, first.total_available) == (True, False, 9999)
    assert (last.range_start, last.range_end) == (9990, 9999)
    assert (last.total_available, last.total_exact, last.total_capped) == (9999, True, True)
    assert last.group_keys == _groups(range(9990, 9999))
    assert len(fake.page_calls) == 10


async def test_the_depth_cap_ends_a_fill_with_records_left(
    db, redis_backend, fake, seeds, monkeypatch
):
    monkeypatch.setattr(settings, "graph_related_max_results", 1000)
    fake.add(SEED_ID, 50_000)

    res = await _range(db, redis_backend, last=True)

    assert fake.page_calls == [(SEED_ID, "cited_by", 0, 1000)]
    assert (res.scanned, res.total_available, res.total_capped) == (1000, 1000, True)
    assert (res.range_start, res.range_end, res.max_results) == (990, 1000, 1000)


async def test_duplicates_and_the_source_itself_are_skipped(db, redis_backend, fake, seeds):
    fake.set_list(
        SEED_ID,
        [
            _entry(0),
            _entry(90, group="group:p0"),  # another version of p0
            ["v", "doi:10.1/seed-v2", SEED_GROUP, DAY0, 3],
            _entry(1),
            ["s", SEED, "group:elsewhere", DAY0, 3],
            _entry(2),
            _entry(1),  # listed twice
        ],
    )

    res = await _range(db, redis_backend)

    assert res.group_keys == _groups([0, 1, 2])
    assert res.nodes[0].selected_version.canonical_key == "doi:10.1/p0"
    assert (res.total_available, res.total_exact, res.exhausted) == (3, True, True)
    assert res.has_more is False


async def test_excluding_then_unexcluding_restores_the_original_rank(
    db, redis_backend, fake, seeds
):
    fake.add(SEED_ID, 1000)

    first = await _range(db, redis_backend)
    shifted = await _range(db, redis_backend, exclude_group_keys=first.group_keys)
    one_out = await _range(db, redis_backend, exclude_group_keys=_groups([4]))
    back = await _range(db, redis_backend)

    assert first.group_keys == _groups(range(30))
    assert shifted.group_keys == _groups(range(30, 60))
    assert shifted.total_available == first.total_available - 30
    assert one_out.group_keys == _groups(i for i in range(31) if i != 4)
    assert back.group_keys == first.group_keys
    # One snapshot serves every exclusion set.
    assert len(fake.page_calls) == 1


async def test_a_start_past_the_end_is_clamped_to_the_last_range(db, redis_backend, fake, seeds):
    fake.add(SEED_ID, 45)

    res = await _range(db, redis_backend, range_start=60)

    assert res.clamped is True
    assert (res.range_start, res.range_end) == (30, 45)
    assert res.group_keys == _groups(range(30, 45))
    assert (res.total_available, res.has_more) == (45, False)


async def test_ranked_keys_and_groups_are_the_durable_caches(db, redis_backend, fake, seeds):
    # Cached before Semantic Scholar knew its DOI: the stored key and group win.
    db.add(_cached("s2:p5", "group:stored5", "Stored five", semantic_scholar_id="p5"))
    await db.flush()
    fake.add(SEED_ID, 40)

    res = await _range(db, redis_backend)
    pinned = await _range(db, redis_backend, exclude_group_keys=["group:stored5"])

    assert res.group_keys[5] == "group:stored5"
    assert res.nodes[5].selected_version.canonical_key == "s2:p5"
    assert res.nodes[5].label == "Stored five"
    assert "p5" not in fake.id_calls[0]
    assert "group:stored5" not in pinned.group_keys
    assert pinned.group_keys[-1] == "group:p30"


async def test_legacy_rows_rank_under_their_stored_group(db, redis_backend, fake, seeds):
    # Cached before Semantic Scholar (no paperId), under another group than
    # the provider's: ranked by its key, so pinning it frees its position.
    db.add(_cached("doi:10.1/p3", "group:legacy3", "Legacy three"))
    await db.flush()
    fake.add(SEED_ID, 40)

    res = await _range(db, redis_backend)
    pinned = await _range(db, redis_backend, exclude_group_keys=["group:legacy3"])

    assert res.group_keys[3] == "group:legacy3"
    assert res.nodes[3].label == "Legacy three"
    assert "p3" not in fake.id_calls[0]
    assert len(pinned.group_keys) == len(pinned.nodes) == 30
    assert "group:legacy3" not in pinned.group_keys
    assert pinned.group_keys[-1] == "group:p30"
    # Hydration recorded the paperId: the next ranking finds the row by it.
    row = await db.get(CachedPaperMetadata, "doi:10.1/p3")
    assert (row.semantic_scholar_id, row.paper_group_key) == ("p3", "group:legacy3")
    await redis_backend.delete(*related.snapshot_keys(SEED_ID, "cited_by").values())
    again = await _range(db, redis_backend, exclude_group_keys=["group:legacy3"])
    assert again.group_keys == pinned.group_keys


async def test_a_paper_cached_under_a_pinned_group_is_not_served(db, redis_backend, fake, seeds):
    fake.add(SEED_ID, 40)
    await _range(db, redis_backend)
    # Regrouped after the list was ranked: the snapshot still has group:p3.
    row = await db.get(CachedPaperMetadata, "doi:10.1/p3")
    row.paper_group_key = "group:moved3"
    await db.flush()

    pinned = await _range(db, redis_backend, exclude_group_keys=["group:moved3"])

    assert len(pinned.group_keys) == len(pinned.nodes) == 29
    assert "group:moved3" not in pinned.group_keys + [node.id for node in pinned.nodes]


async def test_snapshot_ttl_follows_the_direction(db, redis_backend, fake, seeds):
    fake.add(SEED_ID, 50)
    fake.add(SEED_ID, 50, direction="cites")

    await _range(db, redis_backend)
    await _range(db, redis_backend, direction="cites")

    for direction, ttl in (
        ("cited_by", settings.cache_ttl_citations),
        ("cites", settings.cache_ttl_references),
    ):
        keys = related.snapshot_keys(SEED_ID, direction)
        # Ranked: the raw pages are gone, both orderings share the TTL.
        assert not await redis_backend.exists(keys["raw"])
        for name in ("meta", *related.ORDERS):
            pttl = await redis_backend.pttl(keys[name])
            assert ttl * 1000 - 60_000 < pttl <= ttl * 1000


async def test_filling_and_ranking_keep_the_snapshot_ttl(
    db, redis_backend, fake, seeds, small_pages
):
    fake.add(SEED_ID, 1000)
    keys = related.snapshot_keys(SEED_ID, "cited_by")

    await _range(db, redis_backend)
    for name in ("meta", "raw"):
        await redis_backend.pexpire(keys[name], 5000)
    await _range(db, redis_backend)

    assert await redis_backend.llen(keys["raw"]) == 8
    assert await redis_backend.hget(keys["meta"], "n_chunks") == "8"
    for name in ("meta", "raw"):
        assert 0 < await redis_backend.pttl(keys[name]) <= 5000

    await _range(db, redis_backend)
    for name in ("meta", *related.ORDERS):
        assert 0 < await redis_backend.pttl(keys[name]) <= 5000


async def test_provider_errors_cache_nothing(db, redis_backend, fake, seeds, small_pages):
    fake.add(SEED_ID, 1000)
    fake.fail[SEED_ID] = ProviderError("provider_unavailable", "down")

    with pytest.raises(related.RelatedProviderError):
        await _range(db, redis_backend)
    assert await redis_backend.keys("openbib:graph:related:*") == []

    del fake.fail[SEED_ID]
    res = await _range(db, redis_backend)
    assert (res.reason, res.scanned) == ("ranking", 400)

    # A failing page leaves the stored prefix as it was.
    fake.fail[SEED_ID] = ProviderError("provider_unavailable", "down")
    with pytest.raises(related.RelatedProviderError):
        await _range(db, redis_backend)
    keys = related.snapshot_keys(SEED_ID, "cited_by")
    assert await redis_backend.llen(keys["raw"]) == 4
    assert await redis_backend.hget(keys["meta"], "n_chunks") == "4"


@pytest.mark.parametrize(
    ("error", "kind", "retry_after"),
    [
        (ProviderError("provider_rate_limited", "busy", retry_after=12), "rate_limited", 12),
        (ProviderError("provider_not_configured", "no key"), "not_configured", None),
        (ProviderError("provider_key_rejected", "bad key"), "not_configured", None),
        (ProviderError("provider_unavailable", "down", retry_after=30), "provider_unavailable", 30),
        (ProviderError("provider_bad_response", "odd", 502), "provider_unavailable", None),
        (RuntimeError("boom"), "provider_unavailable", None),
    ],
)
async def test_provider_failures_have_a_kind(
    db, redis_backend, fake, seeds, error, kind, retry_after
):
    fake.fail[SEED_ID] = error

    with pytest.raises(related.RelatedProviderError) as failure:
        await _range(db, redis_backend)

    assert (failure.value.kind, failure.value.retry_after) == (kind, retry_after)


async def _window(redis, *, last=False, deadline=20.0):
    async def no_rows(_ids):
        return {}

    return await related.resolve_window(
        redis,
        graph_id=SEED_ID,
        direction="cited_by",
        order="cited_by_count",
        exclude=frozenset(),
        self_groups=frozenset({SEED_GROUP}),
        last=last,
        canonicalize=no_rows,
        deadline=time.monotonic() + deadline,
    )


async def test_append_guard_never_duplicates_chunks(
    db, redis_backend, fake, seeds, small_pages, monkeypatch
):
    fake.add(SEED_ID, 1000)
    first = await _range(db, redis_backend)
    keys = related.snapshot_keys(SEED_ID, "cited_by")
    append = (keys["meta"], keys["raw"])

    stale = await redis_backend.eval(
        related._APPEND, 2, *append, first.snapshot_id, 3, "[]", "", "1", "0", 0
    )
    replaced = await redis_backend.eval(
        related._APPEND, 2, *append, "other", 4, "[]", "", "1", "0", 0
    )
    assert (stale, replaced) == (0, -1)
    assert await redis_backend.llen(keys["raw"]) == 4

    # Two requests filling at once fetch the same pages; each page is stored
    # once, the list is ranked once, and both serve the same range.
    monkeypatch.setattr(settings, "graph_related_pages_per_request", 10)
    fake.delay = 0.01
    a, b = await asyncio.gather(
        _window(redis_backend, last=True), _window(redis_backend, last=True)
    )

    meta = await redis_backend.hgetall(keys["meta"])
    assert (meta["n_chunks"], meta["scanned"], meta["ranked"]) == ("10", "1000", "1")
    stored = [
        e[2]
        for chunk in await redis_backend.lrange(keys["cited_by_count"], 0, -1)
        for e in json.loads(chunk)
    ]
    assert stored == _groups(range(1000))
    assert [e[2] for e in a.entries] == [e[2] for e in b.entries] == _groups(range(990, 1000))


async def test_a_snapshot_created_concurrently_is_shared(db, redis_backend, fake, seeds):
    fake.add(SEED_ID, 100)

    a, b = await asyncio.gather(_window(redis_backend), _window(redis_backend))

    assert a.snapshot_id == b.snapshot_id is not None
    assert [e[2] for e in a.entries] == [e[2] for e in b.entries] == _groups(range(30))
    keys = related.snapshot_keys(SEED_ID, "cited_by")
    assert await redis_backend.hget(keys["meta"], "n_chunks") == "1"
    assert await redis_backend.llen(keys["cited_by_count"]) == 1


async def test_a_scan_deadline_mid_fill_reports_ranking_and_resumes(
    db, redis_backend, fake, seeds, small_pages, monkeypatch
):
    monkeypatch.setattr(settings, "graph_related_scan_budget_seconds", 0.3)
    fake.add(SEED_ID, 300)
    fake.delay = 2.0

    partial = await _range(db, redis_backend, range_start=30)

    assert (partial.reason, partial.scan_incomplete, partial.scanned) == ("ranking", True, 100)
    assert partial.group_keys == []

    fake.delay = 0.0
    resumed = await _range(db, redis_backend, range_start=30)

    assert (resumed.reason, resumed.scan_incomplete) == (None, False)
    assert resumed.group_keys == _groups(range(30, 60))
    assert _offsets(fake) == [0, 100, 100, 200]


class BrokenRedis:
    """Every Redis command fails, as with a timed-out connection."""

    def __getattr__(self, name):
        if name.startswith("__"):
            raise AttributeError(name)

        async def fail(*_args, **_kwargs):
            raise RedisError("down")

        return fail


@pytest.mark.parametrize("redis", [None, BrokenRedis()], ids=["no-redis", "broken-redis"])
async def test_lists_are_ranked_uncached_without_redis(db, fake, seeds, small_pages, redis):
    fake.add(SEED_ID, 1000)

    res = await _range(db, redis, range_start=270)

    assert res.group_keys == _groups(range(270, 300))
    assert (res.snapshot_id, res.reason) == (None, None)
    # Nothing can be stored for a later request: the page budget does not apply.
    assert _offsets(fake) == list(range(0, 1000, 100))


# ── Hydration and sources ───────────────────────────────────


async def test_hydration_uses_the_db_first_then_one_batch(db, redis_backend, fake, seeds):
    db.add(
        _cached("doi:10.1/p0", "group:p0", "Cached P0", cited_by_count=5, semantic_scholar_id="p0")
    )
    db.add(_cached("doi:10.1/p0-preprint", "group:p0", "Cached P0 preprint"))
    await db.flush()
    fake.add(SEED_ID, 3)
    fake.missing.add("p2")

    res = await _range(db, redis_backend)

    assert fake.id_calls == [["p1", "p2"]]
    p0, p1, p2 = res.nodes
    assert (p0.label, p0.type, p0.version_count) == ("Cached P0", "paper_group", 2)
    assert p0.selected_version.canonical_key == "doi:10.1/p0"
    # The snapshot's count sizes the node; the stored row keeps its own.
    assert p0.selected_version.cited_by_count == 100_000
    assert (await db.get(CachedPaperMetadata, "doi:10.1/p0")).cited_by_count == 5
    assert p1.selected_version.abstract == "Full abstract"
    assert p1.selected_version.cited_by_count == 99_999
    stored = await db.get(CachedPaperMetadata, "doi:10.1/p1")
    assert (stored.paper_group_key, stored.semantic_scholar_id) == ("group:p1", "p1")
    # A paper Semantic Scholar no longer returns keeps its list data, unsaved.
    minimal = p2.selected_version
    assert (p2.label, minimal.abstract, minimal.semantic_scholar_id) == ("doi:10.1/p2", None, "p2")
    assert (minimal.provider_source, minimal.provider_sources) == (
        "semantic_scholar",
        ["semantic_scholar"],
    )
    assert minimal.abstract_url == "https://www.semanticscholar.org/paper/p2"
    assert minimal.publication_date == date.fromordinal(DAY0 + 2)
    assert await db.get(CachedPaperMetadata, "doi:10.1/p2") is None

    await _range(db, redis_backend)
    assert fake.id_calls == [["p1", "p2"], ["p2"]]


async def test_hydration_failure_serves_list_data(db, redis_backend, fake, seeds):
    fake.add(SEED_ID, 2)
    fake.fail_ids = ProviderError("provider_rate_limited", "busy", retry_after=5)

    res = await _range(db, redis_backend)

    assert [node.label for node in res.nodes] == ["doi:10.1/p0", "doi:10.1/p1"]
    assert await db.get(CachedPaperMetadata, "doi:10.1/p0") is None


async def test_rows_stored_by_a_concurrent_request_do_not_fail_the_range(
    db, redis_backend, fake, seeds, monkeypatch
):
    async def duplicate_key(session, *_args):
        # Another request committed the same key between our read and write.
        await session.execute(
            insert(CachedPaperMetadata).values(
                canonical_key=SEED,
                paper_group_key=SEED_GROUP,
                title="Seed",
                authors_json=[],
                topics_json=[],
                keywords_json=[],
                provider_source="semantic_scholar",
            )
        )

    monkeypatch.setattr(related.paper_service, "cache_papers", duplicate_key)
    monkeypatch.setattr(related, "store_edges", duplicate_key)
    fake.add(SEED_ID, 2)

    res = await _range(db, redis_backend, saved={SEED, "doi:10.1/p0"})

    assert [node.selected_version.abstract for node in res.nodes] == ["Full abstract"] * 2
    # The savepoint rolled back only the failed write; the session still works.
    assert (await db.get(CachedPaperMetadata, SEED)).title == "Seed"
    assert (await db.execute(select(PaperGraphEdge))).scalars().all() == []


async def test_source_without_a_paper_id_or_identifier(db, redis_backend, fake):
    db.add(_cached("hash:abc", "group:abc", "No identifiers"))
    await db.flush()

    res = await _range(db, redis_backend, key="hash:abc", group="group:abc", range_start=60)

    assert res.reason == "no_provider_id"
    assert (res.nodes, res.group_keys, res.snapshot_id) == ([], [], None)
    assert (res.range_start, res.exhausted, res.has_more) == (0, True, False)
    assert fake.page_calls == [] and fake.lookups == []


async def test_an_s2_key_needs_no_lookup(db, redis_backend, fake):
    fake.add("abc123", 10)

    res = await _range(db, redis_backend, key="s2:abc123", group="group:x")

    assert res.group_keys == _groups(range(10))
    assert (res.provider_total, fake.lookups) == (None, [])
    assert fake.page_calls[0][0] == "abc123"


def _found(key: str, graph_id: str, group: str, **extra) -> PaperMetadata:
    return PaperMetadata(
        canonical_key=key,
        paper_group_key=group,
        title="Found",
        doi=key.removeprefix("doi:"),
        semantic_scholar_id=graph_id,
        cited_by_count=40,
        provider_source="semantic_scholar",
        **extra,
    )


async def test_an_uncached_doi_source_is_looked_up_first(db, redis_backend, fake):
    fake.records["doi:10.1/unc"] = _found("doi:10.1/unc", "unc", "group:unc")
    fake.add("unc", 40)

    res = await _range(db, redis_backend, key="10.1/UNC", group="doi:10.1/unc")

    assert fake.lookups == ["doi:10.1/unc"]
    assert res.reason is None and len(res.group_keys) == 30
    assert (res.source_key, res.provider_total) == ("doi:10.1/unc", 40)
    assert (await db.get(CachedPaperMetadata, "doi:10.1/unc")).semantic_scholar_id == "unc"


async def test_the_source_lookup_writes_the_paper_id_back(db, redis_backend, fake):
    # Cached before Semantic Scholar: the row keeps its key and group.
    db.add(_cached("doi:10.1/legacy", "group:legacy", "Legacy", doi="10.1/legacy"))
    await db.flush()
    fake.records["DOI:10.1/legacy"] = _found("doi:10.1/legacy", "leg", "group:s2")
    fake.add("leg", 5)

    res = await _range(db, redis_backend, key="doi:10.1/legacy", group="group:legacy")

    assert fake.lookups == ["DOI:10.1/legacy"]
    assert res.group_keys == _groups(range(5))
    row = await db.get(CachedPaperMetadata, "doi:10.1/legacy")
    assert (row.semantic_scholar_id, row.paper_group_key) == ("leg", "group:legacy")
    await _range(db, redis_backend, key="doi:10.1/legacy", group="group:legacy")
    assert len(fake.lookups) == 1


async def test_identifiers_unknown_upstream_are_remembered(db, redis_backend, fake):
    first = await _range(db, redis_backend, key="doi:10.5281/zenodo.1", group="g")
    second = await _range(db, redis_backend, key="doi:10.5281/zenodo.1", group="g")

    assert first.reason == second.reason == "no_provider_id"
    assert fake.lookups == ["doi:10.5281/zenodo.1"]
    assert len(await redis_backend.keys("openbib:graph:noid:*")) == 1
    assert fake.page_calls == []


async def test_unreadable_identifiers_are_not_remembered(db, redis_backend, fake):
    fake.records["doi:10.1/odd"] = ProviderError("invalid_query", "unreadable", 422)

    for _ in range(2):
        res = await _range(db, redis_backend, key="doi:10.1/odd", group="g")
        assert res.reason == "no_provider_id"

    assert len(fake.lookups) == 2
    assert await redis_backend.keys("openbib:graph:noid:*") == []


@pytest.mark.parametrize(
    ("error", "kind"),
    [
        (ProviderError("provider_rate_limited", "busy", retry_after=9), "rate_limited"),
        (ProviderError("provider_unavailable", "down"), "provider_unavailable"),
        (TimeoutError(), "timeout"),
    ],
    ids=["rate-limited", "unavailable", "timeout"],
)
async def test_lookup_failures_are_never_remembered(db, redis_backend, fake, seeds, error, kind):
    fake.records["doi:10.1/flaky"] = error
    fake.add(SEED_ID, 40)

    for _ in range(2):
        with pytest.raises(related.RelatedProviderError) as failure:
            await _range(db, redis_backend, key="doi:10.1/flaky", group="g")
        assert failure.value.kind == kind
    top_up = await _top_up(
        db, redis_backend, [_seed_source(), _seed_source(key="doi:10.1/flaky", group="g")]
    )

    assert len(fake.lookups) == 3
    assert await redis_backend.keys("openbib:graph:noid:*") == []
    assert len(top_up.sources[0].added_group_keys) == 30
    flaky = top_up.sources[1]
    assert (flaky.error, flaky.reason, flaky.added_group_keys) == (kind, None, [])


@pytest.mark.parametrize("direction", ["cited_by", "cites"])
async def test_edges_are_persisted_only_between_saved_papers(
    db, redis_backend, fake, seeds, direction
):
    fake.add(SEED_ID, 2, direction=direction)

    await _range(db, redis_backend, direction=direction, saved={SEED, "doi:10.1/p0"})

    rows = (await db.execute(select(PaperGraphEdge))).scalars().all()
    pair = ("doi:10.1/p0", SEED) if direction == "cited_by" else (SEED, "doi:10.1/p0")
    assert {(r.source_key, r.target_key, r.relation_type) for r in rows} == {(*pair, "cited_by")}
    assert {r.provider_source for r in rows} == {"semantic_scholar"}


# ── Top-up ──────────────────────────────────────────────────


async def test_top_up_of_a_partial_branch_adds_the_next_groups(db, redis_backend, fake, seeds):
    fake.add(SEED_ID, 100)

    res = await _top_up(db, redis_backend, [_seed_source(_groups(range(20)))])

    source = res.sources[0]
    assert source.added_group_keys == _groups(range(20, 30))
    assert (source.connected_count, source.exhausted, source.error) == (30, False, None)
    assert source.provider_total == 1000
    assert [node.id for node in res.nodes] == source.added_group_keys
    assert {(e.source, e.target) for e in res.edges} == {
        (g, SEED_GROUP) for g in source.added_group_keys
    }
    assert (res.range_size, res.max_results) == (30, 10_000)


async def test_top_up_of_an_exhausted_branch_adds_nothing(db, redis_backend, fake, seeds):
    fake.add(SEED_ID, 20)

    res = await _top_up(db, redis_backend, [_seed_source(_groups(range(20)))])

    source = res.sources[0]
    assert source.added_group_keys == []
    assert (source.exhausted, source.total_exact, source.total_available) == (True, True, 20)
    assert res.nodes == []


async def test_top_up_of_a_full_branch_makes_no_calls(db, redis_backend, fake, seeds):
    fake.add(SEED_ID, 100)

    res = await _top_up(db, redis_backend, [_seed_source(_groups(range(30)))])

    assert fake.page_calls == []
    assert await redis_backend.keys("openbib:graph:*") == []
    assert (res.sources[0].added_group_keys, res.sources[0].connected_count) == ([], 30)


async def test_top_up_shared_group_is_one_node_with_two_edges(db, redis_backend, fake, seeds):
    shared = _entry(0, "s")
    fake.set_list(SEED_ID, [shared, *(_entry(i) for i in range(5))])
    fake.set_list(SEED2_ID, [_entry(0, "q"), shared])

    res = await _top_up(
        db,
        redis_backend,
        [_seed_source(), _seed_source(key=SEED2, group=SEED2_GROUP)],
    )

    assert [node.id for node in res.nodes].count("group:s0") == 1
    assert {(e.source, e.target) for e in res.edges} >= {
        ("group:s0", SEED_GROUP),
        ("group:s0", SEED2_GROUP),
    }
    assert all("group:s0" in source.added_group_keys for source in res.sources)
    # One hydration batch for every source, the shared paper once.
    assert fake.id_calls == [["p0", "s0", "p1", "p2", "p3", "p4", "q0"]]


async def test_top_up_of_a_source_loaded_only_in_another_mode(db, redis_backend, fake, seeds):
    fake.add(SEED_ID, 100)
    fake.add(SEED_ID, 100, lambda i: _entry(i, "r"), direction="cites")

    # Only the cited_by branch was expanded: the cites branch has no members.
    res = await _top_up(db, redis_backend, [_seed_source()], direction="cites", order="recent")

    expected = _groups(_ranked(100, "recent")[:30], "r")
    assert res.sources[0].added_group_keys == expected
    assert {(e.source, e.target) for e in res.edges} == {(SEED_GROUP, g) for g in expected}


async def test_top_up_never_adds_pinned_groups(db, redis_backend, fake, seeds):
    fake.add(SEED_ID, 100)

    res = await _top_up(
        db,
        redis_backend,
        [_seed_source(_groups(range(5, 15)))],
        exclude_group_keys=[SEED_GROUP, *_groups(range(5))],
    )

    assert res.sources[0].added_group_keys == _groups(range(15, 35))
    assert res.sources[0].connected_count == 30


@pytest.mark.parametrize(
    ("error", "kind"),
    [
        (ProviderError("provider_unavailable", "down"), "provider_unavailable"),
        (ProviderError("provider_rate_limited", "busy", retry_after=7), "rate_limited"),
        (ProviderError("provider_not_configured", "no key"), "provider_unavailable"),
    ],
)
async def test_top_up_isolates_a_failing_source(db, redis_backend, fake, seeds, error, kind):
    fake.add(SEED_ID, 100)
    fake.fail[SEED2_ID] = error

    res = await _top_up(
        db, redis_backend, [_seed_source(), _seed_source(key=SEED2, group=SEED2_GROUP)]
    )

    ok, failed = res.sources
    assert ok.added_group_keys == _groups(range(30)) and ok.error is None
    assert (failed.error, failed.added_group_keys) == (kind, [])


async def test_top_up_reports_sources_still_being_ranked(
    db, redis_backend, fake, seeds, small_pages
):
    fake.add(SEED_ID, 100)
    fake.add(SEED2_ID, 1000, lambda i: _entry(i, "q"))
    two = [_seed_source(), _seed_source(key=SEED2, group=SEED2_GROUP)]

    res = await _top_up(db, redis_backend, two)

    ok, ranking = res.sources
    assert len(ok.added_group_keys) == 30 and ok.error is None
    assert (ranking.error, ranking.added_group_keys, ranking.exhausted) == ("ranking", [], False)

    # Only lists still being collected: no failure, the client asks again.
    only = await _top_up(db, redis_backend, two[1:])
    assert only.sources[0].error == "ranking" and only.nodes == []


async def test_top_up_shares_one_deadline_across_sources(
    db, redis_backend, fake, seeds, monkeypatch
):
    monkeypatch.setattr(settings, "graph_related_scan_budget_seconds", 0.3)
    fake.add(SEED_ID, 100)
    fake.add(SEED2_ID, 100, lambda i: _entry(i, "q"))
    fake.slow[SEED2_ID] = 2.0

    started = time.monotonic()
    res = await _top_up(
        db, redis_backend, [_seed_source(), _seed_source(key=SEED2, group=SEED2_GROUP)]
    )

    assert time.monotonic() - started < 2.0
    ok, slow = res.sources
    assert (len(ok.added_group_keys), ok.error) == (30, None)
    assert (slow.error, slow.added_group_keys) == ("timeout", [])
    # Nothing is stored for the source that timed out.
    keys = related.snapshot_keys(SEED_ID, "cited_by")
    assert set(await redis_backend.keys("openbib:graph:related:*")) == {
        keys["meta"],
        *(keys[order] for order in related.ORDERS),
    }


async def test_top_up_sources_left_without_budget_are_still_ranking(
    db, redis_backend, fake, seeds, small_pages, monkeypatch
):
    monkeypatch.setattr(settings, "graph_related_scan_budget_seconds", 0.3)
    monkeypatch.setattr(settings, "graph_related_topup_concurrency", 1)
    fake.add(SEED_ID, 1000)
    fake.add(SEED2_ID, 100, lambda i: _entry(i, "q"))
    fake.delay = 0.2  # the first source's fill spends the whole budget

    res = await _top_up(
        db, redis_backend, [_seed_source(), _seed_source(key=SEED2, group=SEED2_GROUP)]
    )

    # Neither failed: both are asked again, the second never reached upstream.
    assert [source.error for source in res.sources] == ["ranking", "ranking"]
    assert {call[0] for call in fake.page_calls} == {SEED_ID}
    assert not await redis_backend.exists(related.snapshot_keys(SEED2_ID, "cited_by")["meta"])


async def test_top_up_lookups_left_without_budget_are_still_ranking(
    db, redis_backend, fake, seeds, monkeypatch
):
    monkeypatch.setattr(settings, "graph_related_scan_budget_seconds", 0.3)
    monkeypatch.setattr(settings, "graph_related_topup_concurrency", 1)

    async def lookup_by_id(identifier):
        fake.lookups.append(identifier)
        await asyncio.sleep(1.0)

    monkeypatch.setattr(registry, "lookup_by_id", lookup_by_id)

    res = await _top_up(
        db,
        redis_backend,
        [
            _seed_source(key="doi:10.1/slow", group="g1"),
            _seed_source(key="doi:10.1/late", group="g2"),
        ],
    )

    # A lookup cut off in flight timed out; one that never started waits its turn.
    assert [source.error for source in res.sources] == ["timeout", "ranking"]
    assert fake.lookups == ["doi:10.1/slow"]
    assert await redis_backend.keys("openbib:graph:noid:*") == []


async def test_a_window_without_budget_left_is_still_ranking(db, redis_backend, fake, seeds):
    fake.add(SEED_ID, 100)

    window = await _window(redis_backend, deadline=-1.0)

    assert (window.ranking, window.scan_incomplete, window.scanned) == (True, True, 0)
    assert window.entries == [] and fake.page_calls == []


async def test_top_up_fails_only_when_every_source_fails(db, redis_backend, fake, seeds):
    fake.fail[SEED_ID] = ProviderError("provider_unavailable", "down")
    fake.fail[SEED2_ID] = ProviderError("provider_rate_limited", "busy", retry_after=11)

    with pytest.raises(related.RelatedProviderError) as failure:
        await _top_up(
            db, redis_backend, [_seed_source(), _seed_source(key=SEED2, group=SEED2_GROUP)]
        )

    # The rate limit wins, so the client learns how long to wait.
    assert (failure.value.kind, failure.value.retry_after) == ("rate_limited", 11)


async def test_top_up_reports_sources_without_provider_ids(db, redis_backend, fake, seeds):
    db.add(_cached("hash:abc", "group:abc", "No identifiers"))
    await db.flush()
    fake.add(SEED_ID, 100)

    res = await _top_up(
        db, redis_backend, [_seed_source(), _seed_source(key="hash:abc", group="group:abc")]
    )

    assert res.sources[1].reason == "no_provider_id"
    assert res.sources[1].error is None and res.sources[1].exhausted is True
    assert len(res.sources[0].added_group_keys) == 30
