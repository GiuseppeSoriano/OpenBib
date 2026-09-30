"""Related-paper ranges, snapshots and pinned top-ups (``app.graph.related``).

OpenAlex is faked at the registry with call counters; Redis is the autouse
test Redis (FakeRedis with Lua, or real Redis in CI).
"""

import asyncio
import json
import time

import httpx
import pytest
import respx
from httpx import Response
from redis.exceptions import RedisError
from sqlalchemy import insert, select

from app.config import settings
from app.graph import related
from app.graph.models import PaperGraphEdge
from app.graph.schemas import RelatedRangeRequest, TopUpRequest, TopUpSource
from app.papers.models import CachedPaperMetadata
from app.providers import registry
from app.providers.base import Author, PaperMetadata
from app.providers.openalex import RelatedPage

pytestmark = pytest.mark.skip(reason="integration: ported in WP3")

# Captured before the autouse hermetic fixture stubs it out.
real_openalex_work_by_doi = getattr(registry, "openalex_work_by_doi", None)

SEED = "doi:10.1/seed"
SEED_GROUP = "group:seed"
SEED_ID = "https://openalex.org/W0"
SEED2 = "doi:10.1/seed2"
SEED2_GROUP = "group:seed2"


def _entry(n: int, prefix: str = "p", *, group: str | None = None) -> list:
    return [
        f"W{prefix}{n}",
        f"doi:10.1/{prefix}{n}",
        group or f"group:{prefix}{n}",
        f"Paper {prefix}{n}",
        100_000 - n,
        "2020-01-01",
    ]


def _groups(numbers, prefix: str = "p") -> list[str]:
    return [f"group:{prefix}{n}" for n in numbers]


class FakeOpenAlex:
    """Stands in for ``registry.related_page`` / ``works_by_ids``."""

    def __init__(self):
        self.lists: dict[tuple[str, str, str], tuple] = {}
        self.served: dict[str, list] = {}
        self.page_calls: list[tuple[str, str, str, str]] = []
        self.id_calls: list[list[str]] = []
        self.fail: set[str] = set()
        self.missing: set[str] = set()
        self.fail_ids = False
        self.delay = 0.0
        self.slow: dict[str, float] = {}

    def add(self, work, total, make, *, direction="cited_by", order="cited_by_count", count=None):
        self.lists[(work, direction, order)] = (make, total, total if count is None else count)

    def set_list(self, work, entries, **kwargs):
        self.add(work, len(entries), entries.__getitem__, **kwargs)

    async def related_page(
        self, openalex_id, *, direction="cited_by", order="cited_by_count", cursor="*", per_page=200
    ):
        work = openalex_id.rsplit("/", 1)[-1]
        self.page_calls.append((work, direction, order, cursor))
        await asyncio.sleep(0)
        if work in self.fail:
            request = httpx.Request("GET", "https://api.openalex.org/works")
            raise httpx.HTTPStatusError(
                "unavailable", request=request, response=httpx.Response(503, request=request)
            )
        if cursor != "*" and self.delay:
            await asyncio.sleep(self.delay)
        if work in self.slow:
            await asyncio.sleep(self.slow[work])
        make, total, count = self.lists.get((work, direction, order), (None, 0, 0))
        start = 0 if cursor == "*" else int(cursor)
        stop = min(start + per_page, total)
        entries = [make(i) for i in range(start, stop)]
        for entry in entries:
            self.served[entry[0]] = entry
        return RelatedPage(entries, count, str(stop) if stop < total else None)

    async def works_by_ids(self, ids):
        self.id_calls.append(list(ids))
        if self.fail_ids:
            raise httpx.ConnectError("down")
        papers = []
        for short_id in ids:
            if short_id in self.missing:
                continue
            _, key, group, title, _count, _date = self.served[short_id]
            papers.append(
                PaperMetadata(
                    canonical_key=key,
                    paper_group_key=group,
                    title=title,
                    abstract="Full abstract",
                    openalex_id=f"https://openalex.org/{short_id}",
                    cited_by_count=5,
                    provider_source="openalex",
                )
            )
        return papers


@pytest.fixture
def fake(monkeypatch):
    fake = FakeOpenAlex()
    monkeypatch.setattr(registry, "related_page", fake.related_page)
    monkeypatch.setattr(registry, "works_by_ids", fake.works_by_ids)
    return fake


def _cached(key, group, title="Seed", **extra) -> CachedPaperMetadata:
    return CachedPaperMetadata(
        canonical_key=key,
        paper_group_key=group,
        title=title,
        authors_json=[],
        topics_json=[],
        keywords_json=[],
        provider_source="openalex",
        **extra,
    )


@pytest.fixture
async def seeds(db):
    db.add(_cached(SEED, SEED_GROUP, openalex_id=SEED_ID, doi="10.1/seed"))
    db.add(_cached(SEED2, SEED2_GROUP, openalex_id="https://openalex.org/W1", doi="10.1/seed2"))
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


def _recent(total):
    return lambda i: _entry(total - 1 - i)


# ── Ranges ──────────────────────────────────────────────────


@pytest.mark.parametrize("direction", ["cited_by", "cites"])
@pytest.mark.parametrize("order", ["cited_by_count", "recent"])
async def test_first_range_is_the_first_30_groups(db, redis_backend, fake, seeds, direction, order):
    make = _entry if order == "cited_by_count" else _recent(100)
    fake.add("W0", 100, make, direction=direction, order=order)

    res = await _range(db, redis_backend, direction=direction, order=order)

    expected = [make(i)[2] for i in range(30)]
    assert res.group_keys == expected
    assert [node.id for node in res.nodes] == expected
    assert (res.range_start, res.range_end, res.range_size) == (0, 30, 30)
    assert (res.total_available, res.total_exact, res.has_more) == (100, True, True)
    assert res.exhausted is False and res.snapshot_id
    ends = {(edge.source, edge.target) for edge in res.edges}
    if direction == "cited_by":
        assert ends == {(g, SEED_GROUP) for g in expected}
    else:
        assert ends == {(SEED_GROUP, g) for g in expected}
    assert {edge.relation_type for edge in res.edges} == {"cited_by"}


@pytest.mark.parametrize("order", ["cited_by_count", "recent"])
async def test_ranges_271_300_and_991_1000_of_1000_records(db, redis_backend, fake, seeds, order):
    make = _entry if order == "cited_by_count" else _recent(1000)
    fake.add("W0", 1000, make, order=order)

    middle = await _range(db, redis_backend, order=order, range_start=270)
    last = await _range(db, redis_backend, order=order, last=True)

    assert middle.group_keys == [make(i)[2] for i in range(270, 300)]
    assert (middle.range_start, middle.range_end) == (270, 300)
    assert last.group_keys == [make(i)[2] for i in range(990, 1000)]
    assert (last.range_start, last.range_end) == (990, 1000)
    assert (last.total_available, last.total_exact, last.has_more) == (1000, True, False)
    assert last.exhausted is False and last.clamped is False


async def test_duplicates_and_the_source_itself_are_skipped(db, redis_backend, fake, seeds):
    fake.set_list(
        "W0",
        [
            _entry(0),
            _entry(90, group="group:p0"),  # another version of p0
            ["Wv", "doi:10.1/seed-v2", SEED_GROUP, "Seed v2", 3, None],
            _entry(1),
            ["Ws", SEED, "group:elsewhere", "Seed", 3, None],
            _entry(2),
            _entry(1),
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
    fake.add("W0", 1000, _entry)

    first = await _range(db, redis_backend)
    shifted = await _range(db, redis_backend, exclude_group_keys=first.group_keys)
    one_out = await _range(db, redis_backend, exclude_group_keys=_groups([4]))
    back = await _range(db, redis_backend)

    assert first.group_keys == _groups(range(30))
    assert shifted.group_keys == _groups(range(30, 60))
    assert shifted.total_available == first.total_available - 30
    assert one_out.group_keys == _groups(i for i in range(31) if i != 4)
    assert back.group_keys == first.group_keys
    assert back.group_keys[4] == "group:p4"
    # One snapshot serves every exclusion set.
    assert len(fake.page_calls) == 1


async def test_fetch_ahead_across_chunk_boundaries(db, redis_backend, fake, seeds):
    fake.add("W0", 1000, _entry)

    res = await _range(db, redis_backend, exclude_group_keys=_groups(range(185)))

    assert res.group_keys == _groups(range(185, 215))
    assert [call[3] for call in fake.page_calls] == ["*", "200"]
    assert res.scanned == 400


async def test_a_start_past_the_end_is_clamped_to_the_last_range(db, redis_backend, fake, seeds):
    fake.add("W0", 45, _entry)

    res = await _range(db, redis_backend, range_start=60)

    assert res.clamped is True
    assert (res.range_start, res.range_end) == (30, 45)
    assert res.group_keys == _groups(range(30, 45))
    assert (res.total_available, res.has_more) == (45, False)


async def test_depth_cap_with_50000_provider_results(db, redis_backend, fake, seeds):
    fake.add("W0", 50_000, _entry)

    first = await _range(db, redis_backend)
    assert first.total_capped is True
    assert (first.provider_total, first.total_exact) == (50_000, False)
    assert first.total_available == settings.graph_related_max_results
    assert len(fake.page_calls) == 1

    last = await _range(db, redis_backend, last=True)

    assert last.scanned == settings.graph_related_max_results == 10_000
    assert (last.total_available, last.total_exact, last.total_capped) == (10_000, True, True)
    assert (last.range_start, last.range_end) == (9990, 10_000)
    assert last.group_keys == _groups(range(9990, 10_000))
    assert len(fake.page_calls) == 50


async def test_snapshot_is_reused_per_work_direction_and_order(db, redis_backend, fake, seeds):
    fake.add("W0", 1000, _entry)
    fake.add("W0", 1000, _recent(1000), order="recent")

    await _range(db, redis_backend)
    await _range(db, redis_backend, range_start=30)
    await _range(db, redis_backend, range_start=150)
    assert len(fake.page_calls) == 1

    await _range(db, redis_backend, order="recent")
    assert len(fake.page_calls) == 2


async def test_snapshot_ttl_follows_the_direction(db, redis_backend, fake, seeds):
    fake.add("W0", 50, _entry)
    fake.add("W0", 50, _entry, direction="cites")

    await _range(db, redis_backend)
    await _range(db, redis_backend, direction="cites")

    for direction, ttl in (
        ("cited_by", settings.cache_ttl_citations),
        ("cites", settings.cache_ttl_references),
    ):
        for key in related.snapshot_keys(SEED_ID, direction, "cited_by_count"):
            pttl = await redis_backend.pttl(key)
            assert ttl * 1000 - 60_000 < pttl <= ttl * 1000


async def test_extending_a_snapshot_keeps_its_ttl(db, redis_backend, fake, seeds):
    fake.add("W0", 1000, _entry)
    meta, chunks = related.snapshot_keys(SEED_ID, "cited_by", "cited_by_count")

    await _range(db, redis_backend)
    await redis_backend.pexpire(meta, 5000)
    await redis_backend.pexpire(chunks, 5000)
    await _range(db, redis_backend, range_start=270)

    assert await redis_backend.llen(chunks) == 2
    assert await redis_backend.hget(meta, "n_chunks") == "2"
    for key in (meta, chunks):
        assert 0 < await redis_backend.pttl(key) <= 5000


async def test_provider_errors_cache_nothing(db, redis_backend, fake, seeds):
    fake.add("W0", 1000, _entry)
    fake.fail.add("W0")

    with pytest.raises(related.RelatedProviderError):
        await _range(db, redis_backend)
    assert await redis_backend.keys("openbib:graph:related:*") == []

    fake.fail.clear()
    res = await _range(db, redis_backend)
    assert res.group_keys == _groups(range(30))
    assert len(fake.page_calls) == 2

    # A failing extension leaves the stored prefix as it was.
    fake.fail.add("W0")
    with pytest.raises(related.RelatedProviderError):
        await _range(db, redis_backend, range_start=270)
    meta, chunks = related.snapshot_keys(SEED_ID, "cited_by", "cited_by_count")
    assert await redis_backend.llen(chunks) == 1
    assert await redis_backend.hget(meta, "n_chunks") == "1"


async def test_append_guard_never_duplicates_chunks(db, redis_backend, fake, seeds):
    fake.add("W0", 1000, _entry)
    first = await _range(db, redis_backend)
    meta, chunks = related.snapshot_keys(SEED_ID, "cited_by", "cited_by_count")

    stale = await redis_backend.eval(
        related._APPEND, 2, meta, chunks, first.snapshot_id, 0, "[]", "", "0"
    )
    replaced = await redis_backend.eval(related._APPEND, 2, meta, chunks, "other", 1, "[]", "", "0")
    assert (stale, replaced) == (0, -1)
    assert await redis_backend.llen(chunks) == 1

    # Two requests extending at once both fetch the same chunks; each chunk
    # is stored once and both see the same list.
    fake.delay = 0.01

    async def last_window():
        return await related.resolve_window(
            redis_backend,
            openalex_id=SEED_ID,
            direction="cited_by",
            order="cited_by_count",
            exclude=frozenset(),
            self_groups=frozenset({SEED_GROUP}),
            last=True,
            deadline=time.monotonic() + 20,
        )

    a, b = await asyncio.gather(last_window(), last_window())

    assert await redis_backend.llen(chunks) == 5
    assert await redis_backend.hget(meta, "n_chunks") == "5"
    stored = [
        e[2] for chunk in await redis_backend.lrange(chunks, 0, -1) for e in json.loads(chunk)
    ]
    assert stored == _groups(range(1000))
    assert [e[2] for e in a.entries] == [e[2] for e in b.entries] == _groups(range(990, 1000))


async def test_a_snapshot_created_concurrently_is_shared(db, redis_backend, fake, seeds):
    fake.add("W0", 100, _entry)

    async def window():
        return await related.resolve_window(
            redis_backend,
            openalex_id=SEED_ID,
            direction="cited_by",
            order="cited_by_count",
            exclude=frozenset(),
            self_groups=frozenset(),
            deadline=time.monotonic() + 20,
        )

    a, b = await asyncio.gather(window(), window())

    assert a.snapshot_id == b.snapshot_id is not None
    _meta, chunks = related.snapshot_keys(SEED_ID, "cited_by", "cited_by_count")
    assert await redis_backend.llen(chunks) == 1


async def test_scan_deadline_returns_scan_incomplete_and_resumes(
    db, redis_backend, fake, seeds, monkeypatch
):
    monkeypatch.setattr(settings, "graph_related_scan_budget_seconds", 0.3)
    fake.add("W0", 1000, _entry)
    fake.delay = 2.0

    partial = await _range(db, redis_backend, range_start=270)

    assert partial.scan_incomplete is True
    assert partial.group_keys == []
    assert (partial.scanned, partial.total_exact, partial.has_more) == (200, False, True)

    fake.delay = 0.0
    resumed = await _range(db, redis_backend, range_start=270)

    assert resumed.scan_incomplete is False
    assert resumed.group_keys == _groups(range(270, 300))
    assert [call[3] for call in fake.page_calls] == ["*", "200", "200"]


class BrokenRedis:
    """Every Redis command fails, as with a timed-out connection."""

    def __getattr__(self, name):
        if name.startswith("__"):
            raise AttributeError(name)

        async def fail(*_args, **_kwargs):
            raise RedisError("down")

        return fail


@pytest.mark.parametrize("redis", [None, BrokenRedis()], ids=["no-redis", "broken-redis"])
async def test_scans_without_redis_are_served_uncached(db, fake, seeds, redis):
    fake.add("W0", 1000, _entry)

    res = await _range(db, redis, range_start=270)

    assert res.group_keys == _groups(range(270, 300))
    assert res.snapshot_id is None
    assert [call[3] for call in fake.page_calls] == ["*", "200"]


# ── Hydration and sources ───────────────────────────────────


async def test_hydration_uses_the_db_first_then_works_by_ids(db, redis_backend, fake, seeds):
    db.add(
        _cached(
            "doi:10.1/p0",
            "group:p0",
            "Cached P0",
            cited_by_count=5,
            openalex_id="https://openalex.org/Wp0",
        )
    )
    db.add(_cached("doi:10.1/p0-preprint", "group:p0", "Cached P0 preprint"))
    await db.flush()
    fake.add("W0", 3, _entry)
    fake.missing.add("Wp2")

    res = await _range(db, redis_backend)

    assert fake.id_calls == [["Wp1", "Wp2"]]
    p0, p1, p2 = res.nodes
    assert (p0.label, p0.type, p0.version_count) == ("Cached P0", "paper_group", 2)
    assert p0.selected_version.canonical_key == "doi:10.1/p0"
    # The snapshot's count sizes the node; the stored row keeps its own.
    assert p0.selected_version.cited_by_count == 100_000
    assert (await db.get(CachedPaperMetadata, "doi:10.1/p0")).cited_by_count == 5
    assert p1.selected_version.abstract == "Full abstract"
    assert p1.selected_version.cited_by_count == 99_999
    stored = (
        await db.execute(
            select(CachedPaperMetadata).where(CachedPaperMetadata.canonical_key == "doi:10.1/p1")
        )
    ).scalar_one()
    assert (stored.paper_group_key, stored.abstract) == ("group:p1", "Full abstract")
    # A work OpenAlex no longer returns keeps its list data and is not saved.
    assert (p2.label, p2.selected_version.abstract) == ("Paper p2", None)
    assert await db.get(CachedPaperMetadata, "doi:10.1/p2") is None

    await _range(db, redis_backend)
    assert fake.id_calls == [["Wp1", "Wp2"], ["Wp2"]]


async def test_hydration_failure_serves_list_data(db, redis_backend, fake, seeds):
    fake.add("W0", 2, _entry)
    fake.fail_ids = True

    res = await _range(db, redis_backend)

    assert [node.label for node in res.nodes] == ["Paper p0", "Paper p1"]
    assert await db.get(CachedPaperMetadata, "doi:10.1/p0") is None


async def test_records_whose_authors_may_be_cut_are_served_unsaved(
    db, redis_backend, fake, seeds, monkeypatch
):
    fake.add("W0", 2, _entry)
    list_works = fake.works_by_ids

    async def cut_authors(ids):
        papers = await list_works(ids)
        papers[0].authors = [Author(name=f"Author {n}") for n in range(100)]
        return papers

    monkeypatch.setattr(registry, "works_by_ids", cut_authors)

    res = await _range(db, redis_backend)

    p0, p1 = (node.selected_version for node in res.nodes)
    assert (len(p0.authors), p0.abstract, p1.abstract) == (100, "Full abstract", "Full abstract")
    assert await db.get(CachedPaperMetadata, "doi:10.1/p0") is None
    assert await db.get(CachedPaperMetadata, "doi:10.1/p1") is not None


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
                provider_source="openalex",
            )
        )

    monkeypatch.setattr(related.paper_service, "cache_papers", duplicate_key)
    monkeypatch.setattr(related, "store_edges", duplicate_key)
    fake.add("W0", 2, _entry)

    res = await _range(db, redis_backend, saved={SEED, "doi:10.1/p0"})

    assert [node.selected_version.abstract for node in res.nodes] == ["Full abstract"] * 2
    # The savepoint rolled back only the failed write; the session still works.
    assert (await db.get(CachedPaperMetadata, SEED)).title == "Seed"
    assert (await db.execute(select(PaperGraphEdge))).scalars().all() == []


async def test_source_without_openalex_id_or_doi(db, redis_backend, fake):
    db.add(_cached("hash:abc", "group:abc", "No identifiers"))
    await db.flush()

    res = await _range(db, redis_backend, key="hash:abc", group="group:abc", range_start=60)

    assert res.reason == "no_provider_id"
    assert (res.nodes, res.group_keys, res.snapshot_id) == ([], [], None)
    assert (res.range_start, res.exhausted, res.has_more) == (0, True, False)
    assert fake.page_calls == []


async def test_uncached_doi_source_is_resolved_first(db, redis_backend, fake, monkeypatch):
    calls: list[str] = []

    async def by_doi(doi):
        calls.append(doi)
        return PaperMetadata(
            canonical_key="doi:10.1/unc",
            paper_group_key="group:unc",
            title="Uncached",
            doi="10.1/unc",
            openalex_id=SEED_ID,
            provider_source="openalex",
        )

    monkeypatch.setattr(registry, "openalex_work_by_doi", by_doi)
    fake.add("W0", 40, _entry)

    res = await _range(db, redis_backend, key="10.1/UNC", group="doi:10.1/unc")

    assert calls == ["10.1/unc"]
    assert res.reason is None and len(res.group_keys) == 30
    assert res.source_key == "doi:10.1/unc"
    assert (await db.get(CachedPaperMetadata, "doi:10.1/unc")).openalex_id == SEED_ID


@respx.mock
async def test_dois_openalex_does_not_know_are_remembered(db, redis_backend, fake, monkeypatch):
    monkeypatch.setattr(registry, "openalex_work_by_doi", real_openalex_work_by_doi)
    route = respx.get(url__regex=r"https://api\.openalex\.org/works/doi:10\.5281/zenodo\.1")
    route.mock(return_value=Response(404))

    first = await _range(db, redis_backend, key="doi:10.5281/zenodo.1", group="g")
    second = await _range(db, redis_backend, key="doi:10.5281/zenodo.1", group="g")

    assert first.reason == second.reason == "no_provider_id"
    assert route.call_count == 1
    assert len(await redis_backend.keys("openbib:graph:noid:*")) == 1
    assert fake.page_calls == []


@pytest.mark.parametrize(
    "failure",
    [Response(503), Response(429), httpx.ConnectTimeout("slow")],
    ids=["503", "429", "timeout"],
)
@respx.mock
async def test_openalex_lookup_failures_are_never_remembered(
    db, redis_backend, fake, seeds, monkeypatch, failure
):
    # The real DOI chain: Crossref knows the DOI, but only OpenAlex can say
    # whether it has an OpenAlex id, so its outage must not read as "none".
    monkeypatch.setattr(registry, "openalex_work_by_doi", real_openalex_work_by_doi)
    monkeypatch.setattr(
        registry, "LOOKUP_DOI_CHAIN", [registry._openalex, registry._crossref, registry._europepmc]
    )
    openalex = respx.get(url__regex=r"https://api\.openalex\.org/works/doi:10\.1/flaky")
    if isinstance(failure, Response):
        openalex.mock(return_value=failure)
    else:
        openalex.mock(side_effect=failure)
    crossref = respx.get(url__regex=r"https://api\.crossref\.org/works/10\.1/flaky").mock(
        return_value=Response(200, json={"message": {"DOI": "10.1/flaky", "title": ["Flaky"]}})
    )
    fake.add("W0", 40, _entry)

    for _ in range(2):
        with pytest.raises(related.RelatedProviderError):
            await _range(db, redis_backend, key="doi:10.1/flaky", group="g")
    top_up = await _top_up(
        db, redis_backend, [_seed_source(), _seed_source(key="doi:10.1/flaky", group="g")]
    )

    assert openalex.call_count == 3
    assert not crossref.called
    assert await redis_backend.keys("openbib:graph:noid:*") == []
    assert len(top_up.sources[0].added_group_keys) == 30
    flaky = top_up.sources[1]
    assert (flaky.error, flaky.reason, flaky.added_group_keys) == ("provider_unavailable", None, [])


@pytest.mark.parametrize("direction", ["cited_by", "cites"])
async def test_edges_are_persisted_only_between_saved_papers(
    db, redis_backend, fake, seeds, direction
):
    fake.add("W0", 2, _entry, direction=direction)

    await _range(db, redis_backend, direction=direction, saved={SEED, "doi:10.1/p0"})

    rows = (await db.execute(select(PaperGraphEdge))).scalars().all()
    pair = ("doi:10.1/p0", SEED) if direction == "cited_by" else (SEED, "doi:10.1/p0")
    assert {(r.source_key, r.target_key, r.relation_type) for r in rows} == {(*pair, "cited_by")}


# ── Top-up ──────────────────────────────────────────────────


async def test_top_up_of_a_partial_branch_adds_the_next_groups(db, redis_backend, fake, seeds):
    fake.add("W0", 100, _entry)

    res = await _top_up(db, redis_backend, [_seed_source(_groups(range(20)))])

    source = res.sources[0]
    assert source.added_group_keys == _groups(range(20, 30))
    assert (source.connected_count, source.exhausted, source.error) == (30, False, None)
    assert [node.id for node in res.nodes] == source.added_group_keys
    assert {(e.source, e.target) for e in res.edges} == {
        (g, SEED_GROUP) for g in source.added_group_keys
    }
    assert (res.range_size, res.max_results) == (30, 10_000)


async def test_top_up_of_an_exhausted_branch_adds_nothing(db, redis_backend, fake, seeds):
    fake.add("W0", 20, _entry)

    res = await _top_up(db, redis_backend, [_seed_source(_groups(range(20)))])

    source = res.sources[0]
    assert source.added_group_keys == []
    assert (source.exhausted, source.total_exact, source.total_available) == (True, True, 20)
    assert res.nodes == []


async def test_top_up_of_a_full_branch_makes_no_calls(db, redis_backend, fake, seeds):
    fake.add("W0", 100, _entry)

    res = await _top_up(db, redis_backend, [_seed_source(_groups(range(30)))])

    assert fake.page_calls == []
    assert await redis_backend.keys("openbib:graph:*") == []
    assert (res.sources[0].added_group_keys, res.sources[0].connected_count) == ([], 30)


async def test_top_up_shared_group_is_one_node_with_two_edges(db, redis_backend, fake, seeds):
    shared = _entry(0, "s")
    fake.set_list("W0", [shared, *(_entry(i) for i in range(5))])
    fake.set_list("W1", [_entry(0, "q"), shared])

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


async def test_top_up_of_a_source_loaded_only_in_another_mode(db, redis_backend, fake, seeds):
    fake.add("W0", 100, _entry)
    fake.add("W0", 100, lambda i: _entry(i, "r"), direction="cites")

    # Only the cited_by branch was expanded: the cites branch has no members.
    res = await _top_up(db, redis_backend, [_seed_source()], direction="cites")

    assert res.sources[0].added_group_keys == _groups(range(30), "r")
    assert {(e.source, e.target) for e in res.edges} == {
        (SEED_GROUP, g) for g in _groups(range(30), "r")
    }


async def test_top_up_never_adds_pinned_groups(db, redis_backend, fake, seeds):
    fake.add("W0", 100, _entry)

    res = await _top_up(
        db,
        redis_backend,
        [_seed_source(_groups(range(5, 15)))],
        exclude_group_keys=[SEED_GROUP, *_groups(range(5))],
    )

    assert res.sources[0].added_group_keys == _groups(range(15, 35))
    assert res.sources[0].connected_count == 30


async def test_top_up_isolates_a_failing_source(db, redis_backend, fake, seeds):
    fake.add("W0", 100, _entry)
    fake.fail.add("W1")

    res = await _top_up(
        db, redis_backend, [_seed_source(), _seed_source(key=SEED2, group=SEED2_GROUP)]
    )

    ok, failed = res.sources
    assert ok.added_group_keys == _groups(range(30)) and ok.error is None
    assert (failed.error, failed.added_group_keys) == ("provider_unavailable", [])


async def test_top_up_shares_one_deadline_across_sources(
    db, redis_backend, fake, seeds, monkeypatch
):
    monkeypatch.setattr(settings, "graph_related_scan_budget_seconds", 0.3)
    fake.add("W0", 100, _entry)
    fake.add("W1", 100, lambda i: _entry(i, "q"))
    fake.slow["W1"] = 2.0

    started = time.monotonic()
    res = await _top_up(
        db, redis_backend, [_seed_source(), _seed_source(key=SEED2, group=SEED2_GROUP)]
    )

    assert time.monotonic() - started < 2.0
    ok, slow = res.sources
    assert (len(ok.added_group_keys), ok.error) == (30, None)
    assert (slow.error, slow.added_group_keys) == ("timeout", [])
    # Nothing is stored for the source that timed out.
    assert set(await redis_backend.keys("openbib:graph:related:*")) == set(
        related.snapshot_keys(SEED_ID, "cited_by", "cited_by_count")
    )


async def test_top_up_fails_only_when_every_source_fails(db, redis_backend, fake, seeds):
    fake.fail.update({"W0", "W1"})

    with pytest.raises(related.RelatedProviderError):
        await _top_up(
            db, redis_backend, [_seed_source(), _seed_source(key=SEED2, group=SEED2_GROUP)]
        )


async def test_top_up_reports_sources_without_provider_ids(db, redis_backend, fake, seeds):
    db.add(_cached("hash:abc", "group:abc", "No identifiers"))
    await db.flush()
    fake.add("W0", 100, _entry)

    res = await _top_up(
        db, redis_backend, [_seed_source(), _seed_source(key="hash:abc", group="group:abc")]
    )

    assert res.sources[1].reason == "no_provider_id"
    assert res.sources[1].error is None and res.sources[1].exhausted is True
    assert len(res.sources[0].added_group_keys) == 30
