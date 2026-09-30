"""Related-paper ranges and pinned top-ups for the citation graph.

Semantic Scholar lists a paper's citers (``direction="cited_by"``) or
references (``"cites"``) by offset, unordered and without a total. Each list
is snapshotted in Redis once per (S2 paperId, direction), under
``openbib:graph:related:{CACHE_NAMESPACE}:{sha16}``:

* ``:meta``: HASH ``sid``, ``next`` (offset), ``exhausted``, ``capped``,
  ``scanned``, ``n_chunks``, ``ranked``, ``n_sorted``, ``n_entries``;
* ``:raw``: LIST of JSON chunks of compact entries ``[s2_id, canonical_key,
  group_key, date_ordinal, cited_by]`` in provider order, while filling;
* ``:order:cited_by_count`` and ``:order:recent``: LISTs of JSON chunks of the
  ranked entries.

A fill fetches ``graph_related_chunk_size`` records per call and at most
``graph_related_pages_per_request`` calls per request, until the list ends,
Semantic Scholar stops paging (``capped``: it serves at most 9,999 records)
or ``graph_related_max_results`` records are in. The complete list is then
ranked once: one entry per paperId and per canonical key, keys and groups
re-read from the durable cache, sorted both ways (ties by canonical key).
Until then a range reports ``reason="ranking"`` with its progress and no
nodes: an unranked prefix has no stable order to serve.

Every key gets its TTL when the snapshot is created (the ranked lists inherit
what is left of it); appends are guarded by the chunk count, so each chunk
belongs to one traversal and a hot snapshot still expires. Provider errors are
never cached.

Ranges are positions in the *eligible* ranked list: the first occurrence of
each paper group, minus the source itself and the caller's pinned groups, so
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
from collections.abc import AsyncIterator, Awaitable, Callable
from dataclasses import dataclass, field
from datetime import date
from functools import partial
from typing import Literal

import redis.asyncio as aioredis
from redis.exceptions import RedisError
from sqlalchemy import String, and_, any_, bindparam, or_, select
from sqlalchemy.dialects.postgresql import ARRAY
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

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
from app.papers.models import CachedPaperMetadata
from app.papers.schemas import PaperMetadataRead
from app.providers import registry
from app.providers.base import PaperMetadata
from app.providers.semantic_scholar import MAX_GRAPH_RECORDS, ProviderError

logger = logging.getLogger(__name__)

_SNAPSHOT_PREFIX = "openbib:graph:related:"
_NOID_PREFIX = "openbib:graph:noid:"
_NOID_TTL_SECONDS = 86400
# Time kept after the scan budget for hydration, so a request ends within
# about 25 s (nginx keeps its 60 s default proxy_read_timeout).
_HYDRATE_RESERVE_SECONDS = 5.0
# Ranked lists are stored, and read back, this many entries per chunk.
_RANKED_CHUNK = 1000
ORDERS = ("cited_by_count", "recent")
_STRONG_PREFIXES = ("doi:", "s2:", "arxiv:", "pmid:", "pmcid:")
_LANDING_PAGE = "https://www.semanticscholar.org/paper/"

RelatedErrorKind = Literal["provider_unavailable", "timeout", "rate_limited", "not_configured"]
# Provider error codes that are not plain outages.
_ERROR_KINDS: dict[str, RelatedErrorKind] = {
    "provider_rate_limited": "rate_limited",
    "provider_not_configured": "not_configured",
    "provider_key_rejected": "not_configured",
}

# Creates meta + first raw chunk and sets their expiry in one step. An intact
# snapshot (raw chunk count matching the list, or complete ranked lists) wins;
# a partial one is replaced.
_CREATE = """
local meta = redis.call('HMGET', KEYS[1], 'n_chunks', 'ranked', 'n_sorted')
if meta[2] == '1' then
  local n_sorted = tonumber(meta[3] or '-1')
  if redis.call('LLEN', KEYS[3]) == n_sorted and redis.call('LLEN', KEYS[4]) == n_sorted then
    return 0
  end
else
  local n = tonumber(meta[1] or '0')
  if n and n > 0 and redis.call('LLEN', KEYS[2]) == n then
    return 0
  end
end
redis.call('DEL', KEYS[1], KEYS[2], KEYS[3], KEYS[4])
redis.call('HSET', KEYS[1], 'sid', ARGV[1], 'next', ARGV[2], 'exhausted', ARGV[3],
  'capped', ARGV[4], 'scanned', ARGV[5], 'n_chunks', '1', 'ranked', '0')
redis.call('RPUSH', KEYS[2], ARGV[6])
redis.call('PEXPIRE', KEYS[1], ARGV[7])
redis.call('PEXPIRE', KEYS[2], ARGV[7])
return 1
"""

# Appends raw chunk number ARGV[2] (0-based) of snapshot ARGV[1]. Returns 0
# when another request appended it (or ranked the list) first, -1 when the
# snapshot expired or was replaced. RPUSH/HSET keep the TTL.
_APPEND = """
local meta = redis.call('HMGET', KEYS[1], 'sid', 'n_chunks', 'ranked')
if meta[1] ~= ARGV[1] then
  return -1
end
local n = tonumber(ARGV[2])
if meta[3] == '1' or tonumber(meta[2]) ~= n then
  return 0
end
if redis.call('LLEN', KEYS[2]) ~= n then
  return -1
end
redis.call('RPUSH', KEYS[2], ARGV[3])
redis.call('HSET', KEYS[1], 'n_chunks', tostring(n + 1), 'next', ARGV[4],
  'exhausted', ARGV[5], 'capped', ARGV[6])
redis.call('HINCRBY', KEYS[1], 'scanned', ARGV[7])
return 1
"""

# Stores both ranked lists of snapshot ARGV[1], filled to ARGV[2] raw chunks,
# with the snapshot's remaining TTL, and drops the raw chunks. ARGV[3] is the
# chunk count per list, ARGV[4] the entry count; the chunks of both lists
# follow. Returns 0 when another request ranked it first, -1 when the snapshot
# expired, was replaced or grew meanwhile.
_RANK = """
local meta = redis.call('HMGET', KEYS[1], 'sid', 'n_chunks', 'ranked')
if meta[1] ~= ARGV[1] then
  return -1
end
if meta[3] == '1' then
  return 0
end
if tonumber(meta[2]) ~= tonumber(ARGV[2]) then
  return -1
end
local ttl = redis.call('PTTL', KEYS[1])
if ttl <= 0 then
  return -1
end
local n = tonumber(ARGV[3])
redis.call('DEL', KEYS[2], KEYS[3], KEYS[4])
for i = 1, n do
  redis.call('RPUSH', KEYS[3], ARGV[4 + i])
  redis.call('RPUSH', KEYS[4], ARGV[4 + n + i])
end
if n > 0 then
  redis.call('PEXPIRE', KEYS[3], ttl)
  redis.call('PEXPIRE', KEYS[4], ttl)
end
redis.call('HSET', KEYS[1], 'ranked', '1', 'n_sorted', ARGV[3], 'n_entries', ARGV[4])
return 1
"""

# Reads one chunk of a list, only while the snapshot is still the one read.
_READ = """
if redis.call('HGET', KEYS[1], 'sid') ~= ARGV[1] then
  return false
end
return redis.call('LRANGE', KEYS[2], ARGV[2], ARGV[2])
"""


class RelatedProviderError(Exception):
    """The citation provider failed or ran out of time; nothing was cached.
    ``retry_after`` (seconds) comes with ``rate_limited`` (and with an outage
    when the provider suggested a wait, which clients are not sent)."""

    def __init__(
        self, kind: RelatedErrorKind = "provider_unavailable", retry_after: int | None = None
    ):
        super().__init__(kind)
        self.kind: RelatedErrorKind = kind
        self.retry_after = retry_after


class _SnapshotGoneError(Exception):
    """The Redis snapshot expired or was replaced in the middle of a scan."""


class _BudgetSpentError(TimeoutError):
    """The request's scan budget ran out before this provider call started:
    nothing failed, the work is left for the next request."""


# Raw entries -> (stored canonical key, stored group key) per S2 paperId.
Canonicalize = Callable[[list[list]], Awaitable[dict[str, tuple[str, str]]]]


def _digest(value: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest()[:16]


def snapshot_keys(graph_id: str, direction: str) -> dict[str, str]:
    """Redis keys of one related list: ``meta``, ``raw`` and one per order."""
    base = f"{_SNAPSHOT_PREFIX}{registry.CACHE_NAMESPACE}:{_digest(f'{graph_id}|{direction}')}"
    keys = {"meta": f"{base}:meta", "raw": f"{base}:raw"}
    keys.update({order: f"{base}:order:{order}" for order in ORDERS})
    return keys


def _ttl_seconds(direction: str) -> int:
    return settings.cache_ttl_references if direction == "cites" else settings.cache_ttl_citations


def _json(entries: list[list]) -> str:
    return json.dumps(entries, separators=(",", ":"))


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
    ``TimeoutError`` (``_BudgetSpentError`` when the call could not even
    start); any provider failure becomes ``RelatedProviderError``."""
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        if asyncio.iscoroutine(call):
            call.close()
        raise _BudgetSpentError
    try:
        return await asyncio.wait_for(call, timeout=remaining)
    except TimeoutError:
        raise
    except ProviderError as exc:
        logger.warning("Related-paper provider call failed: %s", exc.code)
        kind = _ERROR_KINDS.get(exc.code, "provider_unavailable")
        raise RelatedProviderError(kind, exc.retry_after) from exc
    except Exception as exc:
        logger.warning("Related-paper provider call failed", exc_info=True)
        raise RelatedProviderError() from exc


def _any_of(db: AsyncSession, column, name: str, values: list[str]):
    if db.get_bind().dialect.name == "postgresql":
        # One array parameter, however many values a ranked list holds.
        return column == any_(bindparam(name, values, type_=ARRAY(String)))
    return column.in_(values)


def _graph_id_clause(db: AsyncSession, graph_ids: list[str]):
    return _any_of(db, CachedPaperMetadata.semantic_scholar_id, "graph_ids", graph_ids)


async def _stored_keys(db: AsyncSession, entries: list[list]) -> dict[str, tuple[str, str]]:
    """The key and group the durable cache stores each entry's paper under,
    in one query: the row with its paperId (the lowest key when legacy rows
    share one), else a row cached before its paperId was known, under the
    entry's own key (hydration then records the paperId on it)."""
    if not entries:
        return {}
    graph_ids = list(dict.fromkeys(entry[0] for entry in entries))
    keys = list(dict.fromkeys(entry[1] for entry in entries))
    result = await db.execute(
        select(
            CachedPaperMetadata.semantic_scholar_id,
            CachedPaperMetadata.canonical_key,
            CachedPaperMetadata.paper_group_key,
        )
        .where(
            or_(
                _graph_id_clause(db, graph_ids),
                and_(
                    CachedPaperMetadata.semantic_scholar_id.is_(None),
                    _any_of(db, CachedPaperMetadata.canonical_key, "keys", keys),
                ),
            )
        )
        .order_by(CachedPaperMetadata.canonical_key)
    )
    by_id: dict[str, tuple[str, str]] = {}
    by_key: dict[str, tuple[str, str]] = {}
    for graph_id, key, group in result.all():
        if graph_id:
            by_id.setdefault(graph_id, (key, group))
        else:
            by_key[key] = (key, group)
    # The fill goes on with provider calls: hold no connection meanwhile.
    await _release(db)
    stored: dict[str, tuple[str, str]] = {}
    for graph_id, key, *_rest in entries:
        if (match := by_id.get(graph_id) or by_key.get(key)) is not None:
            stored.setdefault(graph_id, match)
    return stored


def _rank(entries: list[list], stored: dict[str, tuple[str, str]]) -> dict[str, list[list]]:
    """Both orderings of a complete related list, one entry per paperId and
    per canonical key, under the durable cache's keys and groups: most cited
    first, and newest first (year-only dates as January 1, undated last),
    ties by canonical key."""
    rows: list[list] = []
    seen_ids: set[str] = set()
    seen_keys: set[str] = set()
    for graph_id, key, group, published, cited_by in entries:
        key, group = stored.get(graph_id, (key, group))
        if graph_id in seen_ids or key in seen_keys:
            continue
        seen_ids.add(graph_id)
        seen_keys.add(key)
        rows.append([graph_id, key, group, published, cited_by])
    return {
        "cited_by_count": sorted(rows, key=lambda e: (e[4] is None, -(e[4] or 0), e[1])),
        "recent": sorted(rows, key=lambda e: (e[3] is None, -(e[3] or 0), e[1])),
    }


# ── Snapshots ───────────────────────────────────────────────


@dataclass
class _Snapshot:
    """One related list as a request reads, fills and ranks it.

    ``redis`` is ``None`` when the list lives in this request only (no Redis,
    or Redis failed): the fill then starts from the first page, is bounded by
    the deadline only, and nothing is stored.
    """

    redis: aioredis.Redis | None
    keys: dict[str, str]
    graph_id: str
    direction: str
    sid: str | None = None
    next_offset: int | None = 0
    exhausted: bool = False
    capped: bool = False
    scanned: int = 0
    n_chunks: int = 0
    ranked: bool = False
    n_sorted: int = 0
    n_entries: int = 0
    fetched: int = 0  # provider pages fetched by this request
    raw: dict[int, list[list]] = field(default_factory=dict)
    ranking: dict[str, list[list]] = field(default_factory=dict)

    @property
    def complete(self) -> bool:
        return self.exhausted or self.capped or self.scanned >= settings.graph_related_max_results

    def _detach(self) -> None:
        self.redis = None
        self.sid = None

    def _apply_meta(self, meta: dict) -> bool:
        try:
            sid = meta["sid"]
            n_chunks = int(meta["n_chunks"])
            scanned = int(meta["scanned"])
            next_offset = int(meta["next"]) if meta.get("next") else None
            n_sorted = int(meta.get("n_sorted") or 0)
            n_entries = int(meta.get("n_entries") or 0)
        except (KeyError, TypeError, ValueError):
            return False
        if not sid or n_chunks < 1:
            return False
        self.sid = sid
        self.n_chunks = n_chunks
        self.scanned = scanned
        self.next_offset = next_offset
        self.exhausted = meta.get("exhausted") == "1"
        self.capped = meta.get("capped") == "1"
        self.ranked = meta.get("ranked") == "1"
        self.n_sorted = n_sorted
        self.n_entries = n_entries
        return True

    async def _fetch(self, deadline: float) -> tuple[list[list], int | None, bool]:
        """The page at ``next_offset``: its entries (up to the depth cap), the
        next offset (``None`` at the end) and whether a limit ended the list
        with records left (the provider's paging limit or the depth cap)."""
        cap = settings.graph_related_max_results
        offset = self.next_offset or 0
        # Semantic Scholar pages only while offset + limit < 10,000.
        limit = min(
            settings.graph_related_chunk_size, cap - self.scanned, MAX_GRAPH_RECORDS - 1 - offset
        )
        if limit < 1:
            return [], None, True
        page = await _provider_call(
            registry.related_page(self.graph_id, self.direction, offset, limit), deadline
        )
        self.fetched += 1
        entries = page.entries[: cap - self.scanned]
        next_offset = None if page.exhausted else page.next
        if self.scanned + len(entries) >= cap and (
            next_offset is not None or len(entries) < len(page.entries)
        ):
            return entries, None, True
        return entries, next_offset, page.capped

    def _advance(self, entries: list[list], next_offset: int | None, capped: bool) -> None:
        self.raw[self.n_chunks] = entries
        self.n_chunks += 1
        self.scanned += len(entries)
        self.next_offset = next_offset
        self.exhausted = next_offset is None
        self.capped = capped

    async def open(self, deadline: float, *, reuse: bool = True) -> None:
        """Load the stored snapshot, or fetch the first page and store it."""
        if self.redis is not None and reuse:
            try:
                if self._apply_meta(await self.redis.hgetall(self.keys["meta"])):
                    return
            except RedisError:
                logger.warning("Related snapshot unavailable; scanning without it")
                self._detach()
        self.next_offset = 0
        entries, next_offset, capped = await self._fetch(deadline)
        self._advance(entries, next_offset, capped)
        if self.redis is None:
            return
        sid = uuid.uuid4().hex
        try:
            created = await self.redis.eval(
                _CREATE,
                4,
                self.keys["meta"],
                self.keys["raw"],
                *(self.keys[order] for order in ORDERS),
                sid,
                "" if next_offset is None else next_offset,
                "1" if self.exhausted else "0",
                "1" if capped else "0",
                len(entries),
                _json(entries),
                _ttl_seconds(self.direction) * 1000,
            )
            if int(created) == 1:
                self.sid = sid
                return
            # Another request stored this list meanwhile: read theirs.
            if self._apply_meta(await self.redis.hgetall(self.keys["meta"])):
                self.raw = {}
                return
        except RedisError:
            logger.warning("Related snapshot not stored; scanning without it")
        self._detach()

    async def _refresh(self) -> None:
        """Pick up what other requests appended or ranked since the meta was read."""
        try:
            meta = await self.redis.hgetall(self.keys["meta"])
        except RedisError as exc:
            raise _SnapshotGoneError from exc
        if meta.get("sid") != self.sid or not self._apply_meta(meta):
            raise _SnapshotGoneError

    async def fill(self, deadline: float) -> None:
        """Fetch pages until the list is complete, this request's page budget
        is spent (stored snapshots only) or the deadline passes."""
        while not self.ranked and not self.complete:
            if self.redis is not None and self.fetched >= settings.graph_related_pages_per_request:
                return
            try:
                entries, next_offset, capped = await self._fetch(deadline)
            except TimeoutError:
                return
            if self.redis is None:
                self._advance(entries, next_offset, capped)
                continue
            try:
                appended = int(
                    await self.redis.eval(
                        _APPEND,
                        2,
                        self.keys["meta"],
                        self.keys["raw"],
                        self.sid,
                        self.n_chunks,
                        _json(entries),
                        "" if next_offset is None else next_offset,
                        "1" if next_offset is None else "0",
                        "1" if capped else "0",
                        len(entries),
                    )
                )
            except RedisError:
                appended = -1
            if appended == 1:
                self._advance(entries, next_offset, capped)
            elif appended == 0:
                # A concurrent request stored this page (or ranked the list) first.
                await self._refresh()
            else:
                raise _SnapshotGoneError

    async def _chunk(self, key: str, index: int) -> list[list]:
        if self.redis is None:
            raise _SnapshotGoneError
        try:
            chunk = await self.redis.eval(_READ, 2, self.keys["meta"], key, self.sid, index)
        except RedisError as exc:
            raise _SnapshotGoneError from exc
        if not chunk:
            raise _SnapshotGoneError
        return json.loads(chunk[0])

    async def rank(self, canonicalize: Canonicalize) -> None:
        """Rank the complete list and store both orderings (or keep them in
        this request when the snapshot cannot be stored)."""
        entries: list[list] = []
        try:
            for index in range(self.n_chunks):
                entries.extend(
                    self.raw[index]
                    if index in self.raw
                    else await self._chunk(self.keys["raw"], index)
                )
        except _SnapshotGoneError:
            # Another request may have ranked it and dropped the raw chunks.
            if self.redis is None:
                raise
            await self._refresh()
            if self.ranked:
                return
            raise
        self.ranking = _rank(entries, await canonicalize(entries))
        self.ranked = True
        self.n_entries = len(self.ranking[ORDERS[0]])
        chunks = {
            order: [
                _json(ranked[start : start + _RANKED_CHUNK])
                for start in range(0, len(ranked), _RANKED_CHUNK)
            ]
            for order, ranked in self.ranking.items()
        }
        self.n_sorted = len(chunks[ORDERS[0]])
        if self.redis is None:
            return
        try:
            stored = await self.redis.eval(
                _RANK,
                4,
                self.keys["meta"],
                self.keys["raw"],
                *(self.keys[order] for order in ORDERS),
                self.sid,
                self.n_chunks,
                self.n_sorted,
                self.n_entries,
                *(chunk for order in ORDERS for chunk in chunks[order]),
            )
        except RedisError:
            stored = -1
        # 0: another request ranked the same list first; this ranking matches it.
        if int(stored) < 0:
            logger.info("Ranked related list not stored; serving it uncached")
            self._detach()

    async def ranked_chunk(self, order: str, index: int) -> list[list]:
        if order in self.ranking:
            return self.ranking[order][index * _RANKED_CHUNK : (index + 1) * _RANKED_CHUNK]
        return await self._chunk(self.keys[order], index)


# ── Windows ─────────────────────────────────────────────────


@dataclass
class Window:
    """Result of scanning one ranked list for a range or a top-up. A list
    that is not ranked yet gives a ``ranking`` window with no entries."""

    entries: list[list] = field(default_factory=list)
    range_start: int = 0
    range_end: int = 0
    total_available: int = 0
    total_exact: bool = False
    total_capped: bool = False
    scanned: int = 0
    has_more: bool = False
    exhausted: bool = False
    clamped: bool = False
    scan_incomplete: bool = False
    ranking: bool = False
    snapshot_id: str | None = None


async def _scan(
    snap: _Snapshot,
    order: str,
    *,
    exclude: frozenset[str],
    self_groups: frozenset[str],
    self_keys: frozenset[str],
    start: int,
    last: bool,
    skip: frozenset[str],
    need: int | None,
) -> Window:
    size = settings.graph_related_range_size
    seen: set[str] = set()
    found: list[list] = []
    fresh = 0  # eligible entries outside ``skip`` (top-up)
    consumed = 0
    index = 0

    def satisfied() -> bool:
        if need is not None:
            return fresh >= need
        return not last and len(found) >= start + size

    while not satisfied() and index < snap.n_sorted:
        chunk = await snap.ranked_chunk(order, index)
        index += 1
        for entry in chunk:
            consumed += 1
            group = entry[2]
            if group in seen:
                continue
            seen.add(group)
            if group in exclude or group in self_groups or entry[1] in self_keys:
                continue
            found.append(entry)
            if group not in skip:
                fresh += 1

    exact = index >= snap.n_sorted
    count = len(found)
    # Until the ranked list is read to its end, assume its unread rest is
    # all eligible.
    total = count if exact else max(count, snap.n_entries - (consumed - count))
    window = Window(
        total_available=total,
        total_exact=exact,
        total_capped=snap.capped,
        scanned=snap.scanned,
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
    graph_id: str,
    direction: str,
    order: str,
    exclude: frozenset[str],
    self_groups: frozenset[str],
    self_keys: frozenset[str] = frozenset(),
    start: int = 0,
    last: bool = False,
    skip: frozenset[str] = frozenset(),
    need: int | None = None,
    provider_total: int | None = None,
    canonicalize: Canonicalize,
    deadline: float,
) -> Window:
    """One range of the ranked related list, or ``need`` eligible groups
    outside ``skip`` (top-up). Fills the snapshot first, within this
    request's page budget and ``deadline``; a list that is still filling
    gives a ``ranking`` window (the next call resumes the fill). Touches the
    DB only through ``canonicalize``, once, when the fill completes.
    ``provider_total`` (the source's own count) estimates the list size."""
    keys = snapshot_keys(graph_id, direction)

    def still_ranking(snap: _Snapshot) -> Window:
        cap = settings.graph_related_max_results
        return Window(
            total_available=min(max(provider_total or 0, snap.scanned), cap),
            total_capped=(provider_total or 0) > cap,
            scanned=snap.scanned,
            has_more=True,
            scan_incomplete=True,
            ranking=True,
            snapshot_id=snap.sid,
        )

    # A snapshot that vanishes mid-scan is re-opened once, then the scan
    # runs without Redis.
    for attempt in range(3):
        snap = _Snapshot(redis if attempt < 2 else None, keys, graph_id, direction)
        try:
            await snap.open(deadline, reuse=attempt == 0)
        except _BudgetSpentError:
            # Earlier sources of this request used the budget up: this list
            # starts with the next request.
            return still_ranking(snap)
        except TimeoutError as exc:
            raise RelatedProviderError("timeout") from exc
        try:
            if not snap.ranked:
                await snap.fill(deadline)
            if not snap.ranked:
                if not snap.complete:
                    return still_ranking(snap)
                await snap.rank(canonicalize)
            return await _scan(
                snap,
                order,
                exclude=exclude,
                self_groups=self_groups,
                self_keys=self_keys,
                start=start,
                last=last,
                skip=skip,
                need=need,
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
    graph_id: str | None = None

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

    @property
    def identifier(self) -> str | None:
        """What the provider can find the source by when its paperId is unknown."""
        if self.paper is not None:
            return registry.paper_identifier(self.paper)
        return self.key if self.key.startswith(_STRONG_PREFIXES) else None

    def provider_total(self, direction: str) -> int | None:
        """The source's own citation or reference count: an estimate of the
        list's length (some listed papers cannot be resolved)."""
        if self.paper is None:
            return None
        return self.paper.cited_by_count if direction == "cited_by" else self.paper.reference_count


async def load_source(db: AsyncSession, source_key: str, source_group_key: str) -> RelatedSource:
    source = RelatedSource(key=source_key, group_key=source_group_key)
    row = await paper_service.get_cached_paper(db, source_key)
    if row is not None:
        source.paper = paper_service.cached_paper_to_read(row)
        source.graph_id = row.semantic_scholar_id
    if not source.graph_id and source_key.startswith("s2:"):
        source.graph_id = source_key[3:]
    if source.graph_id:
        source.graph_id = source.graph_id.strip().lower()
    return source


async def _lookup(identifier: str) -> tuple[PaperMetadata | None, bool]:
    """The provider's record for ``identifier``, and whether a miss is
    definitive (a 404; an identifier it cannot read is not remembered)."""
    try:
        paper = await registry.lookup_by_id(identifier)
    except ProviderError as exc:
        if exc.code == "invalid_query":
            return None, False
        raise
    return paper, paper is None


async def _lookup_graph_id(
    redis: aioredis.Redis | None, source: RelatedSource, deadline: float
) -> PaperMetadata | None:
    """Find the Semantic Scholar paperId of a source the DB cannot map, by
    its DOI or another strong identifier; returns the paper found (for the
    caller to cache). An identifier the provider definitively does not know
    (a 404, e.g. some DataCite DOIs) is remembered for a day; a failing or
    slow provider raises and is not remembered. ``_BudgetSpentError`` means
    the lookup never started.
    """
    identifier = None if source.graph_id else source.identifier
    if identifier is None:
        return None
    noid_key = f"{_NOID_PREFIX}{registry.CACHE_NAMESPACE}:{_digest(identifier.lower())}"
    if redis is not None:
        with contextlib.suppress(RedisError):
            if await redis.exists(noid_key):
                return None
    try:
        paper, definitive = await _provider_call(_lookup(identifier), deadline)
    except _BudgetSpentError:
        raise
    except TimeoutError as exc:
        raise RelatedProviderError("timeout") from exc
    if paper is not None and paper.semantic_scholar_id:
        source.graph_id = paper.semantic_scholar_id.strip().lower()
    elif definitive and redis is not None:
        with contextlib.suppress(RedisError):
            await redis.set(noid_key, "1", ex=_NOID_TTL_SECONDS)
    return paper


async def _cache_found(
    db: AsyncSession, sources: list[RelatedSource], found: list[PaperMetadata | None]
) -> None:
    """Upsert papers found by source lookups (sequentially: one session) and
    point each source at the stored record, which may keep an older key."""
    pairs = [(s, paper) for s, paper in zip(sources, found, strict=True) if paper is not None]
    if not pairs:
        return
    stored: dict[str | None, PaperMetadata] = {}
    async with _shared_write(db):
        papers = await paper_service.cache_papers(db, [paper for _, paper in pairs])
        stored = {paper.semantic_scholar_id: paper for paper in papers}
    for source, paper in pairs:
        source.paper = _read_from_metadata(stored.get(paper.semantic_scholar_id, paper))


def _minimal_read(entry: list) -> PaperMetadataRead:
    """List data only, for a paper the provider did not return in full.
    Never saved: ``cache_papers`` would overwrite richer fields."""
    graph_id, canonical_key, group_key, published, cited_by_count = entry
    try:
        publication_date = date.fromordinal(published) if published else None
    except (TypeError, ValueError, OverflowError):
        publication_date = None
    return PaperMetadataRead(
        canonical_key=canonical_key,
        paper_group_key=group_key,
        # Lists carry no titles: the key stands in, as for base-graph papers
        # without a cached record.
        title=canonical_key,
        publication_date=publication_date,
        semantic_scholar_id=graph_id,
        abstract_url=_LANDING_PAGE + graph_id,
        cited_by_count=cited_by_count,
        provider_source=registry.PRIMARY_PROVIDER,
        provider_sources=[registry.PRIMARY_PROVIDER],
    )


async def hydrate(
    db: AsyncSession, entries: list[list], *, deadline: float
) -> dict[str, PaperMetadataRead]:
    """Full read models for ranked entries, keyed by paperId.

    Cached rows first (by paperId, else by the entry's key); the rest in one
    batch lookup, upserted. Both give the stored record, whose key and group
    may differ from the entry's. The snapshot's ``cited_by_count`` is
    overlaid (not saved) so node sizes match the ordering. A paper the
    provider cannot return, or any hydration failure, degrades to the
    entry's own list data.
    """
    if not entries:
        return {}
    ids = [entry[0] for entry in entries]
    result = await db.execute(
        select(CachedPaperMetadata)
        .where(
            or_(
                _graph_id_clause(db, ids),
                CachedPaperMetadata.canonical_key.in_({entry[1] for entry in entries}),
            )
        )
        .order_by(CachedPaperMetadata.canonical_key)
    )
    by_id: dict[str, CachedPaperMetadata] = {}
    by_key: dict[str, CachedPaperMetadata] = {}
    for row in result.scalars().all():
        if row.semantic_scholar_id:
            by_id.setdefault(row.semantic_scholar_id, row)
        by_key[row.canonical_key] = row
    reads: dict[str, PaperMetadataRead] = {}
    legacy: list[tuple[CachedPaperMetadata, str]] = []
    for graph_id, key, *_rest in entries:
        row = by_id.get(graph_id)
        if row is None and (match := by_key.get(key)) is not None:
            # A row under the same key with another paperId is another paper.
            row = match if match.semantic_scholar_id is None else None
            if row is not None:
                legacy.append((row, graph_id))
        if row is not None:
            reads[graph_id] = paper_service.cached_paper_to_read(row)
    if legacy:
        # Cached before Semantic Scholar: record the paperId, so later
        # rankings and lookups find the row (and its group) by it.
        async with _shared_write(db):
            for row, graph_id in legacy:
                row.semantic_scholar_id = graph_id
            await db.flush()

    missing = [graph_id for graph_id in dict.fromkeys(ids) if graph_id not in reads]
    if missing:
        await _release(db)
        try:
            fetched = await _provider_call(
                registry.papers_by_ids(missing), max(deadline, time.monotonic() + 1.0)
            )
        except (TimeoutError, RelatedProviderError):
            logger.warning("Related-paper hydration failed; serving list data only")
            fetched = [None] * len(missing)
        pairs = [
            (gid, paper) for gid, paper in zip(missing, fetched, strict=True) if paper is not None
        ]
        stored: dict[str | None, PaperMetadata] = {}
        if pairs:
            async with _shared_write(db):
                papers = await paper_service.cache_papers(db, [paper for _, paper in pairs])
                stored = {paper.semantic_scholar_id: paper for paper in papers}
        for graph_id, paper in pairs:
            reads[graph_id] = _read_from_metadata(stored.get(paper.semantic_scholar_id, paper))

    hydrated: dict[str, PaperMetadataRead] = {}
    for entry in entries:
        read = reads.get(entry[0]) or _minimal_read(entry)
        if entry[4] is not None and read.cited_by_count != entry[4]:
            read = read.model_copy(update={"cited_by_count": entry[4]})
        hydrated[entry[0]] = read
    return hydrated


def _served(
    entries: list[list],
    reads: dict[str, PaperMetadataRead],
    source: RelatedSource,
    drop: frozenset[str],
) -> list[PaperMetadataRead]:
    """Hydrated papers in rank order, one per *stored* group, without the
    source itself or a stored group in ``drop`` (pins, and for a top-up the
    branch's connected papers): a record cached under another group than the
    ranked entry's must not bring a pinned paper back."""
    served: list[PaperMetadataRead] = []
    groups: set[str] = set()
    for entry in entries:
        read = reads[entry[0]]
        group = read.paper_group_key
        if (
            group in groups
            or group in drop
            or group in source.self_groups
            or read.canonical_key in source.self_keys
        ):
            continue
        groups.add(group)
        served.append(read)
    return served


async def _nodes(db: AsyncSession, papers: list[PaperMetadataRead]) -> dict[str, GraphNode]:
    """One node per group (rank order), with every cached version of it so
    related nodes match base-graph nodes."""
    by_group = await paper_service.get_cached_papers_by_groups(
        db, {paper.paper_group_key for paper in papers}
    )
    nodes: dict[str, GraphNode] = {}
    for selected in papers:
        group = selected.paper_group_key
        if group in nodes:
            continue
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
    source: RelatedSource, papers: list[PaperMetadataRead], direction: str, saved: set[str]
) -> tuple[list[tuple[str, str, str]], list[dict]]:
    """Canvas edges between the client's source node and each paper (always
    citing → cited), plus the durable edges between saved papers."""
    edges: list[tuple[str, str, str]] = []
    rows: list[dict] = []
    for paper in papers:
        if direction == "cites":
            edges.append((source.group_key, paper.paper_group_key, CITED_BY))
            citing, cited = source.canonical_key, paper.canonical_key
        else:
            edges.append((paper.paper_group_key, source.group_key, CITED_BY))
            citing, cited = paper.canonical_key, source.canonical_key
        if citing in saved and cited in saved:
            rows.append(
                {
                    "source_key": citing,
                    "target_key": cited,
                    "relation_type": CITED_BY,
                    "provider_source": registry.PRIMARY_PROVIDER,
                }
            )
    return edges, rows


def _deadlines() -> tuple[float, float]:
    """(scan deadline, request deadline) for a request starting now."""
    scan = time.monotonic() + settings.graph_related_scan_budget_seconds
    return scan, scan + _HYDRATE_RESERVE_SECONDS


def _totals(window: Window, provider_total: int | None) -> dict:
    return {
        "total_available": window.total_available,
        "total_exact": window.total_exact,
        "total_capped": window.total_capped,
        "provider_total": provider_total,
        "scanned": window.scanned,
        "has_more": window.has_more,
        "exhausted": window.exhausted,
        "clamped": window.clamped,
        "scan_incomplete": window.scan_incomplete,
        "snapshot_id": window.snapshot_id,
    }


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
    response = {
        "source_key": req.source_key,
        "source_group_key": req.source_group_key,
        "direction": req.direction,
        "order": req.order,
        "range_size": settings.graph_related_range_size,
        "max_results": settings.graph_related_max_results,
    }

    await _release(db)
    try:
        found = await _lookup_graph_id(redis, source, scan_deadline)
    except _BudgetSpentError as exc:
        # The request's first provider call: a budget spent before it is a timeout.
        raise RelatedProviderError("timeout") from exc
    await _cache_found(db, [source], [found])
    if not source.graph_id:
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
    exclude = frozenset(req.exclude_group_keys)
    provider_total = source.provider_total(req.direction)
    window = await resolve_window(
        redis,
        graph_id=source.graph_id,
        direction=req.direction,
        order=req.order,
        exclude=exclude,
        self_groups=source.self_groups,
        self_keys=source.self_keys,
        start=req.range_start,
        last=req.last,
        provider_total=provider_total,
        canonicalize=partial(_stored_keys, db),
        deadline=scan_deadline,
    )
    if window.ranking:
        return RelatedRangeResponse(
            **response,
            nodes=[],
            edges=[],
            group_keys=[],
            range_start=req.range_start,
            range_end=req.range_start,
            **_totals(window, provider_total),
            reason="ranking",
        )

    reads = await hydrate(db, window.entries, deadline=request_deadline)
    papers = _served(window.entries, reads, source, exclude)
    nodes = await _nodes(db, papers)
    edges, rows = _edges(source, papers, req.direction, saved)
    if rows:
        async with _shared_write(db):
            await store_edges(db, rows)

    return RelatedRangeResponse(
        **response,
        nodes=list(nodes.values()),
        edges=[GraphEdge(source=s, target=t, relation_type=r) for s, t, r in edges],
        group_keys=[paper.paper_group_key for paper in papers],
        range_start=window.range_start,
        range_end=window.range_end,
        **_totals(window, provider_total),
    )


@dataclass
class _TopUp:
    source: RelatedSource
    connected: frozenset[str]
    need: int
    found: PaperMetadata | None = None
    window: Window | None = None
    failure: RelatedProviderError | None = None
    # The budget ran out before this source's lookup started.
    deferred: bool = False
    papers: list[PaperMetadataRead] = field(default_factory=list)

    @property
    def error(self) -> Literal["provider_unavailable", "timeout", "ranking", "rate_limited"] | None:
        if self.failure is not None:
            kind = self.failure.kind
            return "provider_unavailable" if kind == "not_configured" else kind
        ranking = self.deferred or (self.window is not None and self.window.ranking)
        return "ranking" if ranking else None


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
    source gets its own ``error`` (``ranking`` while its list is still being
    collected, or when the deadline came before its turn); only when every
    source fails does this raise
    ``RelatedProviderError`` (a rate-limited one first, for its wait).
    """
    scan_deadline, request_deadline = _deadlines()
    exclude = frozenset(req.exclude_group_keys)
    semaphore = asyncio.Semaphore(settings.graph_related_topup_concurrency)
    db_lock = asyncio.Lock()
    plans: list[_TopUp] = []
    for spec, source in zip(req.sources, sources, strict=True):
        connected = frozenset(spec.connected_group_keys) - exclude - source.self_groups
        plans.append(_TopUp(source, connected, req.target_per_source - len(connected)))
    active = [plan for plan in plans if plan.need > 0]

    async def canonicalize(graph_ids: list[str]) -> dict[str, tuple[str, str]]:
        async with db_lock:
            return await _stored_keys(db, graph_ids)

    async def lookup(plan: _TopUp) -> None:
        async with semaphore:
            try:
                plan.found = await _lookup_graph_id(redis, plan.source, scan_deadline)
            except _BudgetSpentError:
                plan.deferred = True
            except RelatedProviderError as exc:
                plan.failure = exc

    async def scan(plan: _TopUp) -> None:
        async with semaphore:
            try:
                plan.window = await resolve_window(
                    redis,
                    graph_id=plan.source.graph_id,
                    direction=req.direction,
                    order=req.order,
                    exclude=exclude,
                    self_groups=plan.source.self_groups,
                    self_keys=plan.source.self_keys,
                    skip=plan.connected,
                    need=plan.need,
                    provider_total=plan.source.provider_total(req.direction),
                    canonicalize=canonicalize,
                    deadline=scan_deadline,
                )
            except RelatedProviderError as exc:
                plan.failure = exc

    await _release(db)
    lookups = [p for p in active if not p.source.graph_id and p.source.identifier]
    await asyncio.gather(*(lookup(plan) for plan in lookups))
    await _cache_found(db, [p.source for p in lookups], [p.found for p in lookups])
    await _release(db)
    await asyncio.gather(
        *(scan(plan) for plan in active if plan.source.graph_id and plan.failure is None)
    )
    failures = [plan.failure for plan in plans if plan.failure is not None]
    if len(failures) == len(plans):
        failure = next((f for f in failures if f.kind == "rate_limited"), failures[0])
        raise RelatedProviderError(failure.kind, failure.retry_after) from failure

    entries: dict[str, list] = {}
    for plan in plans:
        if plan.window is not None:
            for entry in plan.window.entries:
                entries.setdefault(entry[0], entry)
    reads = await hydrate(db, list(entries.values()), deadline=request_deadline)
    for plan in plans:
        if plan.window is not None:
            plan.papers = _served(plan.window.entries, reads, plan.source, exclude | plan.connected)
    nodes = await _nodes(db, [paper for plan in plans for paper in plan.papers])

    edge_set: dict[tuple[str, str, str], None] = {}
    rows: list[dict] = []
    results: list[TopUpSourceResult] = []
    for spec, plan in zip(req.sources, plans, strict=True):
        provider_total = plan.source.provider_total(req.direction)
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
            if plan.window is not None:
                result.update(total_capped=plan.window.total_capped, provider_total=provider_total)
        elif plan.need > 0 and not plan.source.graph_id:
            result.update(total_available=0, total_exact=True, exhausted=True)
            result["reason"] = "no_provider_id"
        elif plan.window is not None:
            window = plan.window
            added = [paper.paper_group_key for paper in plan.papers]
            result.update(
                added_group_keys=added,
                connected_count=len(plan.connected) + len(added),
                total_available=window.total_available,
                total_exact=window.total_exact,
                total_capped=window.total_capped,
                provider_total=provider_total,
                exhausted=window.exhausted,
            )
            edges, edge_rows = _edges(plan.source, plan.papers, req.direction, saved)
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
