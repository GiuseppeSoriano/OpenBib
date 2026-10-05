"""Import service — identifier list import.

Export lives in the Zotero one-way sync (app/zotero) — the BibTeX export
was removed in favour of the Zotero-first integration strategy."""

from __future__ import annotations

import asyncio
import logging
import uuid
from collections import Counter

from sqlalchemy.ext.asyncio import AsyncSession

from app.collections.service import (
    _add_paper_core,
    keys_in_collection,
    reopen_for_write,
    require_edit,
)
from app.common.exceptions import InvalidIdentifierError
from app.common.identifiers import ParsedIdentifier, parse_paper_identifier
from app.config import settings
from app.papers.models import CachedPaperMetadata
from app.papers.service import get_cached_papers_by_aliases, store_paper
from app.providers import registry
from app.providers.registry import DoiLookup
from app.providers.semantic_scholar import ProviderError

logger = logging.getLogger(__name__)


async def _resolve_each(identifiers: list[str], deadline: float) -> dict[str, DoiLookup]:
    """``registry.resolve_id`` one key at a time until ``deadline`` (the
    provider's limiter serializes the calls anyway, and queueing them all at
    once would stall every other request); the rest stay ``unavailable``."""
    loop = asyncio.get_running_loop()
    lookups = {key: DoiLookup("unavailable") for key in identifiers}
    for key in identifiers:
        remaining = deadline - loop.time()
        if remaining <= 0:
            break
        try:
            lookups[key] = await asyncio.wait_for(registry.resolve_id(key), timeout=remaining)
        except TimeoutError:
            break
    return lookups


async def _resolve_ids(identifiers: list[str], budget: float) -> dict[str, DoiLookup]:
    """Strong keys (``s2:``, ``arxiv:``, ``pmid:``, ``pmcid:``) through one
    batch lookup (500 per provider call) within ``budget``: a miss is
    definitive and a failed call leaves every key ``unavailable``. Only a
    batch the provider cannot read falls back to one lookup per key."""
    if not identifiers:
        return {}
    deadline = asyncio.get_running_loop().time() + budget
    try:
        papers = await asyncio.wait_for(registry.papers_by_ids(identifiers), timeout=budget)
    except ProviderError as exc:
        if exc.code == "invalid_query":
            return await _resolve_each(identifiers, deadline)
        logger.warning("Batch identifier lookup failed: %s", exc.code)
        return {key: DoiLookup("unavailable", retry_after=exc.retry_after) for key in identifiers}
    except Exception:
        # A timeout, a transport failure or an invalid response.
        logger.warning("Batch identifier lookup failed", exc_info=True)
        return {key: DoiLookup("unavailable") for key in identifiers}
    return {
        key: DoiLookup("found", paper) if paper is not None else DoiLookup("not_found")
        for key, paper in zip(identifiers, papers, strict=True)
    }


async def _resolve(parsed: list[ParsedIdentifier]) -> dict[str, DoiLookup]:
    """Provider lookups per canonical key, with no transaction open. DOIs go
    through one ``registry.resolve_dois`` call (batch lookups, then doi.org
    checks for the misses only), the other identifiers through one
    ``registry.papers_by_ids`` batch; both share the import request budget."""
    budget = settings.import_request_budget_seconds
    dois = [p.doi for p in parsed if p.doi is not None]
    others = [p.canonical_key for p in parsed if p.doi is None]
    lookups: dict[str, DoiLookup] = {}

    async def resolve_dois() -> None:
        if dois:
            found = await registry.resolve_dois(dois, timeout=budget)
            lookups.update({f"doi:{doi}": lookup for doi, lookup in found.items()})

    async def resolve_ids() -> None:
        lookups.update(await _resolve_ids(others, budget))

    await asyncio.gather(resolve_dois(), resolve_ids())
    return lookups


def _line(
    line: int, raw: str, status: str, canonical_key: str | None = None, title: str | None = None
) -> dict:
    return {
        "line": line,
        "input": raw[:200],
        "status": status,
        "canonical_key": canonical_key,
        "title": title,
    }


async def import_identifiers(
    db: AsyncSession,
    collection_id: uuid.UUID,
    user_id: uuid.UUID,
    lines: list[str],
) -> dict:
    """Import identifiers (one per list item, the forms ``add_paper``
    accepts) into a collection with a result per non-blank line: ``added``,
    ``duplicate`` (within the batch or already in the collection),
    ``invalid``, ``not_found`` (never inserted), ``unresolved`` (a DOI
    inserted as pending while the provider cannot describe it) or
    ``unavailable`` (any other identifier the provider could not resolve
    right now: not saved, retry the line later).

    Same transaction shape as ``service.add_paper``: validate and pre-dedupe
    (cached papers, through any alias, need no provider call), commit,
    resolve with no transaction open, then write the rows one by one in a
    short transaction, always under the stored row's key.
    """
    await require_edit(db, collection_id, user_id)

    results: dict[int, dict] = {}
    candidates: list[tuple[int, str, ParsedIdentifier]] = []
    seen: set[str] = set()
    for line_no, raw in enumerate(lines, start=1):
        if not raw.strip():
            continue
        try:
            parsed = parse_paper_identifier(raw)
        except InvalidIdentifierError:
            results[line_no] = _line(line_no, raw, "invalid")
            continue
        if parsed.canonical_key in seen:
            results[line_no] = _line(line_no, raw, "duplicate", parsed.canonical_key)
            continue
        seen.add(parsed.canonical_key)
        candidates.append((line_no, raw, parsed))

    # Parsed key -> stored row; an alias (a DOI of an ``s2:`` row) counts.
    cached: dict[str, CachedPaperMetadata] = await get_cached_papers_by_aliases(db, seen)
    present = await keys_in_collection(
        db, collection_id, seen | {row.canonical_key for row in cached.values()}
    )
    to_resolve = [
        parsed
        for _, _, parsed in candidates
        if parsed.lookup_id is not None
        and parsed.canonical_key not in cached
        and parsed.canonical_key not in present
    ]
    lookups: dict[str, DoiLookup] = {}
    if to_resolve:
        await db.commit()
        lookups = await _resolve(to_resolve)
        await reopen_for_write(db, collection_id, user_id)
        # One upsert per provider record (alias lines can share one); the
        # stored row may keep an older key and group for the same work.
        stored: dict[str, CachedPaperMetadata | None] = {}
        for key, lookup in lookups.items():
            if lookup.paper is None:
                continue
            record = lookup.paper.canonical_key
            if record not in stored:
                stored[record] = await store_paper(db, lookup.paper)
            if stored[record] is not None:
                cached[key] = stored[record]
        present = await keys_in_collection(
            db, collection_id, seen | {row.canonical_key for row in cached.values()}
        )

    for line_no, raw, parsed in candidates:
        key = parsed.canonical_key
        row = cached.get(key)
        if key not in present and row is not None:
            key = row.canonical_key
        elif row is None and key not in present:
            lookup = lookups.get(key) or DoiLookup(
                "not_found" if parsed.lookup_id is None else "unavailable"
            )
            if lookup.status == "not_found":
                results[line_no] = _line(line_no, raw, "not_found", key)
                continue
            if parsed.doi is None:
                # Only a DOI can be saved as pending.
                results[line_no] = _line(line_no, raw, "unavailable", key)
                continue
        if key in present:
            results[line_no] = _line(line_no, raw, "duplicate", key)
            continue
        await _add_paper_core(db, collection_id, user_id, key, row)
        present.add(key)
        status = "added" if row is not None else "unresolved"
        results[line_no] = _line(line_no, raw, status, key, row.title if row else None)

    ordered = [results[line_no] for line_no in sorted(results)]
    counts = Counter(result["status"] for result in ordered)
    return {
        "added": counts["added"],
        "duplicate": counts["duplicate"],
        "invalid": counts["invalid"],
        "not_found": counts["not_found"],
        "unresolved": counts["unresolved"],
        "total": len(ordered),
        "skipped": counts["duplicate"],
        "results": ordered,
    }
