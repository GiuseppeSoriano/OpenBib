"""Related-paper ranges and pinned top-ups for the citation graph.

A work's citers (``direction="cited_by"``) or references (``"cites"``) in one
ordering are snapshotted in Redis per (OpenAlex work, direction, order):

* ``openbib:graph:related:{sha16}:meta``: HASH ``sid``, ``provider_total``,
  ``next_cursor``, ``exhausted``, ``n_chunks``;
* ``openbib:graph:related:{sha16}:chunks``: LIST of JSON chunks of compact
  entries ``[short_id, canonical_key, group_key, title, cited_by_count, date]``.

The list grows lazily through OpenAlex cursor paging, one chunk per provider
call, and is never scanned past ``graph_related_max_results`` raw records.
Both keys get their TTL once, in the Lua script that writes the first chunk;
appends are guarded by the chunk count and keep that TTL, so every chunk
belongs to one traversal and a hot snapshot still expires. Provider errors are
never cached.

Ranges are positions in the *eligible* list: the first occurrence of each
paper group, minus the source itself and the caller's pinned groups, so
unpinning a paper puts it back at its original rank. Only served papers are
hydrated with full metadata. No provider call runs inside a DB transaction.
"""

from __future__ import annotations

import asyncio
import contextlib
import hashlib
import json
import logging
import time
import uuid
from collections.abc import AsyncIterator, Awaitable
from dataclasses import dataclass, field
from datetime import date
from typing import Literal

import redis.asyncio as aioredis
from redis.exceptions import RedisError
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.common.identifiers import DOI_RE
from app.config import settings
from app.graph.schemas import (
    GraphEdge,
    GraphNode,
    RelatedRangeRequest,
    RelatedRangeResponse,
    TopUpRequest,
    TopUpResponse,
    TopUpSourceResult,
)
from app.graph.service import CITED_BY, _read_from_metadata, store_edges
from app.papers import service as paper_service
from app.papers.schemas import PaperMetadataRead
from app.providers import registry
from app.providers.base import PaperMetadata

logger = logging.getLogger(__name__)

_SNAPSHOT_PREFIX = "openbib:graph:related:"
_NOID_PREFIX = "openbib:graph:noid:"
_NOID_TTL_SECONDS = 86400
# Time kept after the scan budget for hydration, so a request ends within
# about 25 s (nginx keeps its 60 s default proxy_read_timeout).
_HYDRATE_RESERVE_SECONDS = 5.0
# OpenAlex list endpoints (ids.openalex filters included) cut authorships at
# 100, so such a record's authors and group key differ from the single-work
# record: it is served but never saved.
_LIST_AUTHOR_LIMIT = 100

# Creates meta + first chunk and sets both expiries in one step. An intact
# snapshot (chunk count matching the list) wins; a partial one is replaced.
_CREATE = """
local n = tonumber(redis.call('HGET', KEYS[1], 'n_chunks') or '0')
if n and n > 0 and redis.call('LLEN', KEYS[2]) == n then
  return 0
end
redis.call('DEL', KEYS[1], KEYS[2])
redis.call('HSET', KEYS[1], 'sid', ARGV[1], 'provider_total', ARGV[2],
  'next_cursor', ARGV[3], 'exhausted', ARGV[4], 'n_chunks', '1')
redis.call('RPUSH', KEYS[2], ARGV[5])
redis.call('PEXPIRE', KEYS[1], ARGV[6])
redis.call('PEXPIRE', KEYS[2], ARGV[6])
return 1
"""

# Appends chunk number ARGV[2] (0-based) of snapshot ARGV[1]. Returns 0 when
# another request appended it first, -1 when the snapshot expired or was
# replaced. RPUSH/HSET keep the TTL; nothing here re-expires.
_APPEND = """
if redis.call('HGET', KEYS[1], 'sid') ~= ARGV[1] then
  return -1
end
local n = tonumber(redis.call('HGET', KEYS[1], 'n_chunks'))
if n ~= tonumber(ARGV[2]) then
  return 0
end
if redis.call('LLEN', KEYS[2]) ~= n then
  return -1
end
redis.call('RPUSH', KEYS[2], ARGV[3])
redis.call('HSET', KEYS[1], 'n_chunks', tostring(n + 1), 'next_cursor', ARGV[4],
  'exhausted', ARGV[5])
return 1
"""

# Reads one chunk, only while the snapshot is still the one being scanned.
_READ = """
if redis.call('HGET', KEYS[1], 'sid') ~= ARGV[1] then
  return false
end
return redis.call('LRANGE', KEYS[2], ARGV[2], ARGV[2])
"""


class RelatedProviderError(Exception):
    """The citation provider failed or ran out of time; nothing was cached."""

    def __init__(self, kind: Literal["provider_unavailable", "timeout"] = "provider_unavailable"):
        super().__init__(kind)
        self.kind: Literal["provider_unavailable", "timeout"] = kind


class _SnapshotGoneError(Exception):
    """The Redis snapshot expired or was replaced in the middle of a scan."""


def _digest(value: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest()[:16]


def _short_id(work_id: str | None) -> str:
    return (work_id or "").rsplit("/", 1)[-1]


def snapshot_keys(openalex_id: str, direction: str, order: str) -> tuple[str, str]:
    base = _SNAPSHOT_PREFIX + _digest(f"{_short_id(openalex_id)}|{direction}|{order}")
    return f"{base}:meta", f"{base}:chunks"


def _ttl_seconds(direction: str) -> int:
    return settings.cache_ttl_references if direction == "cites" else settings.cache_ttl_citations


async def _release(db: AsyncSession) -> None:
    """End the open transaction (if any) before provider I/O, so no request
    holds a connection or a row lock while it waits on the network."""
    if db.in_transaction():
        await db.commit()


@contextlib.asynccontextmanager
async def _shared_write(db: AsyncSession) -> AsyncIterator[None]:
    """Write rows concurrent requests may be writing too (the endpoints are
    public and snapshots shared, so two requests can store the same papers or
    edges). A duplicate key means another request stored them first: the
    savepoint drops this write instead of failing the request."""
    try:
        async with db.begin_nested():
            yield
    except IntegrityError:
        logger.info("Related-paper rows were stored by a concurrent request")


async def _provider_call[T](call: Awaitable[T], deadline: float) -> T:
    """Await a provider call within ``deadline``. Running out of time raises
    ``TimeoutError``; any provider failure becomes ``RelatedProviderError``."""
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        if asyncio.iscoroutine(call):
            call.close()
        raise TimeoutError
    try:
        return await asyncio.wait_for(call, timeout=remaining)
    except TimeoutError:
        raise
    except Exception as exc:
        logger.warning("Related-paper provider call failed", exc_info=True)
        raise RelatedProviderError() from exc


# ── Snapshots ───────────────────────────────────────────────


@dataclass
class _Snapshot:
    """One related list as a request reads (and possibly grows) it.

    ``redis`` is ``None`` when the list lives in this request only (Redis
    failed, or the snapshot vanished mid-scan): the scan goes on from the
    chunks already read and nothing more is stored.
    """

    redis: aioredis.Redis | None
    meta_key: str
    chunks_key: str
    openalex_id: str
    direction: str
    order: str
    sid: str | None = None
    provider_total: int = 0
    next_cursor: str | None = None
    exhausted: bool = False
    n_chunks: int = 0
    loaded: int = 0
    buffered: dict[int, list[list]] = field(default_factory=dict)

    def at_end(self) -> bool:
        return self.exhausted and self.loaded >= self.n_chunks

    def _detach(self) -> None:
        self.redis = None
        self.sid = None

    def _apply_meta(self, meta: dict) -> bool:
        try:
            n_chunks = int(meta["n_chunks"])
            provider_total = int(meta["provider_total"])
            sid = meta["sid"]
        except (KeyError, TypeError, ValueError):
            return False
        if not sid or n_chunks < 1:
            return False
        self.sid = sid
        self.n_chunks = n_chunks
        self.provider_total = provider_total
        self.next_cursor = meta.get("next_cursor") or None
        self.exhausted = meta.get("exhausted") == "1"
        return True

    async def _fetch(self, cursor: str, deadline: float) -> tuple[list[list], int, str | None]:
        page = await _provider_call(
            registry.related_page(
                self.openalex_id,
                direction=self.direction,
                order=self.order,
                cursor=cursor,
                per_page=settings.graph_related_chunk_size,
            ),
            deadline,
        )
        # An empty page ends the list even if a cursor came back.
        next_cursor = page.next_cursor if page.entries else None
        return page.entries, page.count, next_cursor

    async def open(self, deadline: float, *, reuse: bool = True) -> None:
        """Load the stored snapshot, or fetch the first chunk and store it."""
        if self.redis is not None and reuse:
            try:
                if self._apply_meta(await self.redis.hgetall(self.meta_key)):
                    return
            except RedisError:
                logger.warning("Related snapshot unavailable; scanning without it")
                self._detach()
        entries, count, next_cursor = await self._fetch("*", deadline)
        self.provider_total = count
        self.next_cursor = next_cursor
        self.exhausted = next_cursor is None
        self.n_chunks = 1
        self.buffered = {0: entries}
        if self.redis is None:
            return
        sid = uuid.uuid4().hex
        try:
            created = await self.redis.eval(
                _CREATE,
                2,
                self.meta_key,
                self.chunks_key,
                sid,
                count,
                next_cursor or "",
                "1" if self.exhausted else "0",
                json.dumps(entries, separators=(",", ":")),
                _ttl_seconds(self.direction) * 1000,
            )
            if int(created) == 1:
                self.sid = sid
                return
            # Another request stored this list meanwhile: read theirs.
            if self._apply_meta(await self.redis.hgetall(self.meta_key)):
                self.buffered = {}
                return
        except RedisError:
            logger.warning("Related snapshot not stored; scanning without it")
        self._detach()

    async def _refresh(self) -> None:
        """Pick up chunks other requests appended since the meta was read."""
        try:
            sid, n_chunks, next_cursor, exhausted = await self.redis.hmget(
                self.meta_key, "sid", "n_chunks", "next_cursor", "exhausted"
            )
        except RedisError:
            # Every chunk read so far is in memory; carry on without Redis.
            self._detach()
            return
        if sid != self.sid:
            raise _SnapshotGoneError
        self.n_chunks = int(n_chunks)
        self.next_cursor = next_cursor or None
        self.exhausted = exhausted == "1"

    async def _read(self, index: int) -> list[list]:
        if index in self.buffered:
            return self.buffered.pop(index)
        if self.redis is None:
            raise _SnapshotGoneError
        try:
            chunk = await self.redis.eval(_READ, 2, self.meta_key, self.chunks_key, self.sid, index)
        except RedisError as exc:
            raise _SnapshotGoneError from exc
        if not chunk:
            raise _SnapshotGoneError
        return json.loads(chunk[0])

    async def next_chunk(self, deadline: float) -> list[list]:
        """The next chunk in list order: from Redis while stored chunks remain,
        then from the provider (appended to the snapshot)."""
        if self.redis is not None and self.loaded >= self.n_chunks and not self.exhausted:
            await self._refresh()
        if self.loaded < self.n_chunks:
            chunk = await self._read(self.loaded)
            self.loaded += 1
            return chunk
        if self.exhausted or self.next_cursor is None:
            self.exhausted = True
            return []
        entries, _count, next_cursor = await self._fetch(self.next_cursor, deadline)
        exhausted = next_cursor is None
        if self.redis is not None:
            try:
                appended = int(
                    await self.redis.eval(
                        _APPEND,
                        2,
                        self.meta_key,
                        self.chunks_key,
                        self.sid,
                        self.n_chunks,
                        json.dumps(entries, separators=(",", ":")),
                        next_cursor or "",
                        "1" if exhausted else "0",
                    )
                )
            except RedisError:
                appended = -1
            if appended == 0:
                # A concurrent request appended the same chunk: read theirs.
                await self._refresh()
                return await self.next_chunk(deadline)
            if appended < 0:
                self._detach()
        self.n_chunks += 1
        self.loaded += 1
        self.next_cursor = next_cursor
        self.exhausted = exhausted
        return entries


# ── Windows ─────────────────────────────────────────────────


@dataclass
class Window:
    """Result of scanning one related list for a range or a top-up."""

    entries: list[list] = field(default_factory=list)
    range_start: int = 0
    range_end: int = 0
    total_available: int = 0
    total_exact: bool = False
    total_capped: bool = False
    provider_total: int | None = None
    scanned: int = 0
    has_more: bool = False
    exhausted: bool = False
    clamped: bool = False
    scan_incomplete: bool = False
    snapshot_id: str | None = None


async def _scan(
    snap: _Snapshot,
    *,
    exclude: frozenset[str],
    self_groups: frozenset[str],
    self_keys: frozenset[str],
    start: int,
    last: bool,
    skip: frozenset[str],
    need: int | None,
    deadline: float,
) -> Window:
    size = settings.graph_related_range_size
    cap = settings.graph_related_max_results
    seen: set[str] = set()
    found: list[list] = []
    fresh = 0  # eligible entries outside ``skip`` (top-up)
    scanned = 0
    incomplete = False

    def satisfied() -> bool:
        if need is not None:
            return fresh >= need
        return not last and len(found) >= start + size

    while not satisfied() and scanned < cap and not snap.at_end():
        try:
            chunk = await snap.next_chunk(deadline)
        except TimeoutError:
            incomplete = True
            break
        for entry in chunk[: cap - scanned]:
            scanned += 1
            group = entry[2]
            if group in seen:
                continue
            seen.add(group)
            if group in exclude or group in self_groups or entry[1] in self_keys:
                continue
            found.append(entry)
            if group not in skip:
                fresh += 1

    exact = scanned >= cap or snap.at_end()
    count = len(found)
    # Until the list is scanned to its end (or the cap), assume the unscanned
    # rest is all eligible.
    total = count if exact else max(count, min(snap.provider_total, cap) - (scanned - count))
    window = Window(
        total_available=total,
        total_exact=exact,
        total_capped=snap.provider_total > cap,
        provider_total=snap.provider_total,
        scanned=scanned,
        scan_incomplete=incomplete,
        snapshot_id=snap.sid,
    )

    if need is not None:
        window.entries = [entry for entry in found if entry[2] not in skip][:need]
        window.exhausted = exact and fresh <= need
        window.has_more = not window.exhausted
        return window

    if last:
        known = total if exact else count
        start = ((known - 1) // size) * size if known else 0
    elif exact and start >= max(total, 1):
        start = ((total - 1) // size) * size if total else 0
        window.clamped = True
    window.entries = found[start : start + size]
    window.range_start = start
    window.range_end = start + len(window.entries)
    window.has_more = window.range_end < total or not exact
    window.exhausted = exact and total <= len(window.entries)
    return window


async def resolve_window(
    redis: aioredis.Redis | None,
    *,
    openalex_id: str,
    direction: str,
    order: str,
    exclude: frozenset[str],
    self_groups: frozenset[str],
    self_keys: frozenset[str] = frozenset(),
    start: int = 0,
    last: bool = False,
    skip: frozenset[str] = frozenset(),
    need: int | None = None,
    deadline: float,
) -> Window:
    """Scan the (snapshotted) related list far enough for one range, or for
    ``need`` eligible groups outside ``skip`` (top-up). Stops when the
    requirement is met, the list ends, the depth cap is reached or the
    deadline passes (``scan_incomplete``); the next call resumes from the
    stored chunks. Touches Redis and the provider only, never the DB."""
    meta_key, chunks_key = snapshot_keys(openalex_id, direction, order)
    # A snapshot that vanishes mid-scan is re-opened once, then the scan
    # runs without Redis.
    for attempt in range(3):
        snap = _Snapshot(
            redis if attempt < 2 else None,
            meta_key,
            chunks_key,
            openalex_id,
            direction,
            order,
        )
        try:
            await snap.open(deadline, reuse=attempt == 0)
        except TimeoutError as exc:
            raise RelatedProviderError("timeout") from exc
        try:
            return await _scan(
                snap,
                exclude=exclude,
                self_groups=self_groups,
                self_keys=self_keys,
                start=start,
                last=last,
                skip=skip,
                need=need,
                deadline=deadline,
            )
        except _SnapshotGoneError:
            logger.info("Related snapshot changed during a scan; re-reading it")
    raise AssertionError("unreachable: a scan without Redis cannot lose its snapshot")


# ── Sources, hydration and edges ────────────────────────────


@dataclass
class RelatedSource:
    """A range or top-up source: the client's keys plus what the DB knows.
    Loaded before the router commits, so provider lookups run lock-free."""

    key: str
    group_key: str
    paper: PaperMetadataRead | None = None
    openalex_id: str | None = None
    doi: str | None = None

    @property
    def canonical_key(self) -> str:
        return self.paper.canonical_key if self.paper is not None else self.key

    @property
    def self_groups(self) -> frozenset[str]:
        groups = {self.group_key}
        if self.paper is not None:
            groups.add(self.paper.paper_group_key)
        return frozenset(groups)

    @property
    def self_keys(self) -> frozenset[str]:
        return frozenset({self.key, self.canonical_key})


async def load_source(db: AsyncSession, source_key: str, source_group_key: str) -> RelatedSource:
    source = RelatedSource(key=source_key, group_key=source_group_key)
    row = await paper_service.get_cached_paper(db, source_key)
    if row is not None:
        source.paper = paper_service.cached_paper_to_read(row)
        source.openalex_id = row.openalex_id
        source.doi = row.doi
    if not source.doi and source_key.startswith("doi:") and DOI_RE.fullmatch(source_key[4:]):
        source.doi = source_key[4:]
    return source


async def _lookup_openalex_id(
    redis: aioredis.Redis | None, source: RelatedSource, deadline: float
) -> PaperMetadata | None:
    """Find the OpenAlex work of a source the DB cannot map, by its DOI.

    Asks OpenAlex only (no Crossref fallback): returns the paper found (for
    the caller to cache). A DOI OpenAlex definitively does not know (404,
    e.g. DataCite-only DOIs) is remembered for a day; a failing or slow
    OpenAlex raises and is not remembered.
    """
    if source.openalex_id or not source.doi:
        return None
    noid_key = _NOID_PREFIX + _digest(source.doi.lower())
    if redis is not None:
        with contextlib.suppress(RedisError):
            if await redis.exists(noid_key):
                return None
    try:
        paper = await _provider_call(registry.openalex_work_by_doi(source.doi), deadline)
    except TimeoutError as exc:
        raise RelatedProviderError("timeout") from exc
    if paper is not None and paper.openalex_id:
        source.openalex_id = paper.openalex_id
    elif redis is not None:
        with contextlib.suppress(RedisError):
            await redis.set(noid_key, "1", ex=_NOID_TTL_SECONDS)
    return paper


async def _cache_found(db: AsyncSession, sources: list[RelatedSource], found: list) -> None:
    """Upsert papers found by DOI lookups (sequentially: one session)."""
    papers = [paper for paper in found if paper is not None and paper.title is not None]
    if not papers:
        return
    async with _shared_write(db):
        await paper_service.cache_papers(db, papers)
    for source, paper in zip(sources, found, strict=True):
        if paper is not None and paper.title is not None:
            source.paper = _read_from_metadata(paper)


def _parse_date(value: str | None) -> date | None:
    try:
        return date.fromisoformat(value) if value else None
    except ValueError:
        return None


def _minimal_read(entry: list) -> PaperMetadataRead:
    """List data only, for a paper the provider did not return in full.
    Never saved: ``cache_papers`` would overwrite richer fields."""
    short_id, canonical_key, group_key, title, cited_by_count, published = entry
    return PaperMetadataRead(
        canonical_key=canonical_key,
        paper_group_key=group_key,
        title=title or "",
        publication_date=_parse_date(published),
        openalex_id=f"https://openalex.org/{short_id}" if short_id else None,
        cited_by_count=cited_by_count,
        provider_source="openalex",
        provider_sources=["openalex"],
    )


async def hydrate(
    db: AsyncSession, entries: list[list], *, deadline: float
) -> dict[str, PaperMetadataRead]:
    """Full read models for list entries, keyed by the entry's canonical key.

    Cached rows first; the rest in one OpenAlex batch, upserted (full records
    only, never ones whose authors may be cut). The snapshot's ``cited_by_count`` is overlaid (not saved) so node
    sizes match the ordering. A paper the provider cannot return, or any
    hydration failure, degrades to the entry's own list data.
    """
    if not entries:
        return {}
    rows = await paper_service.get_cached_papers_by_keys(db, {entry[1] for entry in entries})
    reads = {key: paper_service.cached_paper_to_read(row) for key, row in rows.items()}
    missing = [entry for entry in entries if entry[1] not in reads and entry[0]]
    if missing:
        await _release(db)
        try:
            fetched = await _provider_call(
                registry.works_by_ids([entry[0] for entry in missing]),
                max(deadline, time.monotonic() + 1.0),
            )
        except (TimeoutError, RelatedProviderError):
            logger.warning("Related-paper hydration failed; serving list data only")
            fetched = []
        by_id = {
            _short_id(paper.openalex_id): paper for paper in fetched if paper.title is not None
        }
        full = [
            paper
            for entry in missing
            if (paper := by_id.get(entry[0])) is not None
            and len(paper.authors) < _LIST_AUTHOR_LIMIT
        ]
        if full:
            async with _shared_write(db):
                await paper_service.cache_papers(db, full)
        for entry in missing:
            paper = by_id.get(entry[0])
            if paper is not None:
                reads[entry[1]] = _read_from_metadata(paper)

    result: dict[str, PaperMetadataRead] = {}
    for entry in entries:
        read = reads.get(entry[1]) or _minimal_read(entry)
        if entry[4] is not None and read.cited_by_count != entry[4]:
            read = read.model_copy(update={"cited_by_count": entry[4]})
        result[entry[1]] = read
    return result


async def _nodes(
    db: AsyncSession, entries: list[list], reads: dict[str, PaperMetadataRead]
) -> dict[str, GraphNode]:
    """One node per group (rank order), with every cached version of it so
    related nodes match base-graph nodes."""
    by_group = await paper_service.get_cached_papers_by_groups(db, {entry[2] for entry in entries})
    nodes: dict[str, GraphNode] = {}
    for entry in entries:
        group = entry[2]
        if group in nodes:
            continue
        selected = reads[entry[1]]
        versions = [
            selected
            if row.canonical_key == selected.canonical_key
            else paper_service.cached_paper_to_read(row)
            for row in by_group.get(group, [])
        ]
        if not any(version is selected for version in versions):
            versions.insert(0, selected)
        nodes[group] = GraphNode(
            id=group,
            label=selected.title,
            type="paper_group" if len(versions) > 1 else "paper",
            paper_group_key=group,
            version_count=len(versions),
            selected_version=selected,
            versions=versions,
        )
    return nodes


def _edges(
    source: RelatedSource, entries: list[list], direction: str, saved: set[str]
) -> tuple[list[tuple[str, str, str]], list[dict]]:
    """Canvas edges between the client's source node and each item (always
    citing → cited), plus the durable edges between saved papers."""
    edges: list[tuple[str, str, str]] = []
    rows: list[dict] = []
    for entry in entries:
        if direction == "cites":
            edges.append((source.group_key, entry[2], CITED_BY))
            citing, cited = source.canonical_key, entry[1]
        else:
            edges.append((entry[2], source.group_key, CITED_BY))
            citing, cited = entry[1], source.canonical_key
        if citing in saved and cited in saved:
            rows.append(
                {
                    "source_key": citing,
                    "target_key": cited,
                    "relation_type": CITED_BY,
                    "provider_source": "openalex",
                }
            )
    return edges, rows


def _deadlines() -> tuple[float, float]:
    """(scan deadline, request deadline) for a request starting now."""
    scan = time.monotonic() + settings.graph_related_scan_budget_seconds
    return scan, scan + _HYDRATE_RESERVE_SECONDS


# ── Endpoints ───────────────────────────────────────────────


async def related_range(
    db: AsyncSession,
    redis: aioredis.Redis | None,
    req: RelatedRangeRequest,
    source: RelatedSource,
    saved: set[str],
) -> RelatedRangeResponse:
    """One range of the source's citers or references (``POST /graph/related``).
    Raises ``RelatedProviderError`` when the provider fails."""
    scan_deadline, request_deadline = _deadlines()
    size = settings.graph_related_range_size
    cap = settings.graph_related_max_results
    response = {
        "source_key": req.source_key,
        "source_group_key": req.source_group_key,
        "direction": req.direction,
        "order": req.order,
        "range_size": size,
        "max_results": cap,
    }

    await _release(db)
    found = await _lookup_openalex_id(redis, source, scan_deadline)
    await _cache_found(db, [source], [found])
    if not source.openalex_id:
        return RelatedRangeResponse(
            **response,
            nodes=[],
            edges=[],
            group_keys=[],
            range_start=0,
            range_end=0,
            total_available=0,
            total_exact=True,
            total_capped=False,
            provider_total=None,
            scanned=0,
            has_more=False,
            exhausted=True,
            clamped=False,
            scan_incomplete=False,
            snapshot_id=None,
            reason="no_provider_id",
        )

    await _release(db)
    window = await resolve_window(
        redis,
        openalex_id=source.openalex_id,
        direction=req.direction,
        order=req.order,
        exclude=frozenset(req.exclude_group_keys),
        self_groups=source.self_groups,
        self_keys=source.self_keys,
        start=req.range_start,
        last=req.last,
        deadline=scan_deadline,
    )
    reads = await hydrate(db, window.entries, deadline=request_deadline)
    nodes = await _nodes(db, window.entries, reads)
    edges, rows = _edges(source, window.entries, req.direction, saved)
    if rows:
        async with _shared_write(db):
            await store_edges(db, rows)

    return RelatedRangeResponse(
        **response,
        nodes=list(nodes.values()),
        edges=[GraphEdge(source=s, target=t, relation_type=r) for s, t, r in edges],
        group_keys=[entry[2] for entry in window.entries],
        range_start=window.range_start,
        range_end=window.range_end,
        total_available=window.total_available,
        total_exact=window.total_exact,
        total_capped=window.total_capped,
        provider_total=window.provider_total,
        scanned=window.scanned,
        has_more=window.has_more,
        exhausted=window.exhausted,
        clamped=window.clamped,
        scan_incomplete=window.scan_incomplete,
        snapshot_id=window.snapshot_id,
    )


@dataclass
class _TopUp:
    source: RelatedSource
    connected: frozenset[str]
    need: int
    found: PaperMetadata | None = None
    window: Window | None = None
    error: Literal["provider_unavailable", "timeout"] | None = None


async def related_top_up(
    db: AsyncSession,
    redis: aioredis.Redis | None,
    req: TopUpRequest,
    sources: list[RelatedSource],
    saved: set[str],
) -> TopUpResponse:
    """Expand pinned nodes (``POST /graph/related/top-up``): bring each
    source's (direction, order) branch up to ``target_per_source`` connected
    papers with the next eligible groups in rank order, never retiring any.

    One deadline covers the whole request. DB work runs sequentially (one
    session); provider and Redis work runs concurrently per source. A failing
    source gets its own ``error``; only when every source fails does this
    raise ``RelatedProviderError``.
    """
    scan_deadline, request_deadline = _deadlines()
    exclude = frozenset(req.exclude_group_keys)
    semaphore = asyncio.Semaphore(settings.graph_related_topup_concurrency)
    plans: list[_TopUp] = []
    for spec, source in zip(req.sources, sources, strict=True):
        connected = frozenset(spec.connected_group_keys) - exclude - source.self_groups
        plans.append(_TopUp(source, connected, req.target_per_source - len(connected)))

    async def lookup(plan: _TopUp) -> None:
        async with semaphore:
            try:
                plan.found = await _lookup_openalex_id(redis, plan.source, scan_deadline)
            except RelatedProviderError as exc:
                plan.error = exc.kind

    async def scan(plan: _TopUp) -> None:
        async with semaphore:
            try:
                plan.window = await resolve_window(
                    redis,
                    openalex_id=plan.source.openalex_id,
                    direction=req.direction,
                    order=req.order,
                    exclude=exclude,
                    self_groups=plan.source.self_groups,
                    self_keys=plan.source.self_keys,
                    skip=plan.connected,
                    need=plan.need,
                    deadline=scan_deadline,
                )
            except RelatedProviderError as exc:
                plan.error = exc.kind

    await _release(db)
    lookups = [p for p in plans if p.need > 0 and not p.source.openalex_id and p.source.doi]
    await asyncio.gather(*(lookup(plan) for plan in lookups))
    await _cache_found(db, [p.source for p in lookups], [p.found for p in lookups])
    await _release(db)
    await asyncio.gather(
        *(scan(plan) for plan in plans if plan.need > 0 and plan.source.openalex_id)
    )
    if all(plan.error for plan in plans):
        raise RelatedProviderError(plans[0].error or "provider_unavailable")

    entries: dict[str, list] = {}
    for plan in plans:
        for entry in plan.window.entries if plan.window else []:
            entries.setdefault(entry[1], entry)
    reads = await hydrate(db, list(entries.values()), deadline=request_deadline)
    nodes = await _nodes(db, list(entries.values()), reads)

    edge_set: dict[tuple[str, str, str], None] = {}
    rows: list[dict] = []
    results: list[TopUpSourceResult] = []
    for spec, plan in zip(req.sources, plans, strict=True):
        result = {
            "source_key": spec.source_key,
            "source_group_key": spec.source_group_key,
            "added_group_keys": [],
            "connected_count": len(plan.connected),
            "total_available": len(plan.connected),
            "total_exact": False,
            "total_capped": False,
            "provider_total": None,
            "exhausted": False,
        }
        if plan.error:
            result["error"] = plan.error
        elif plan.need > 0 and not plan.source.openalex_id:
            result.update(total_available=0, total_exact=True, exhausted=True)
            result["reason"] = "no_provider_id"
        elif plan.window is not None:
            window = plan.window
            added = [entry[2] for entry in window.entries]
            result.update(
                added_group_keys=added,
                connected_count=len(plan.connected) + len(added),
                total_available=window.total_available,
                total_exact=window.total_exact,
                total_capped=window.total_capped,
                provider_total=window.provider_total,
                exhausted=window.exhausted,
            )
            edges, edge_rows = _edges(plan.source, window.entries, req.direction, saved)
            edge_set.update(dict.fromkeys(edges))
            for row in edge_rows:
                if row not in rows:
                    rows.append(row)
        results.append(TopUpSourceResult(**result))
    if rows:
        async with _shared_write(db):
            await store_edges(db, rows)

    return TopUpResponse(
        nodes=list(nodes.values()),
        edges=[GraphEdge(source=s, target=t, relation_type=r) for s, t, r in edge_set],
        sources=results,
        range_size=settings.graph_related_range_size,
        max_results=settings.graph_related_max_results,
    )
