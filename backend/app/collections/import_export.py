"""Import service — DOI / canonical-key list import.

Export lives in the Zotero one-way sync (app/zotero) — the BibTeX export
was removed in favour of the Zotero-first integration strategy."""

from __future__ import annotations

import asyncio
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
from app.papers.service import cache_papers, get_cached_papers_by_keys
from app.providers import registry
from app.providers.registry import DoiLookup


async def _resolve_dois(dois: list[str]) -> dict[str, DoiLookup]:
    """Resolve DOIs over the network only, with bounded concurrency and one
    overall budget; anything unfinished when it runs out is ``unavailable``."""
    semaphore = asyncio.Semaphore(max(1, settings.import_resolve_concurrency))

    async def resolve(doi: str) -> DoiLookup:
        async with semaphore:
            return await registry.resolve_doi(doi)

    tasks = {doi: asyncio.create_task(resolve(doi)) for doi in dict.fromkeys(dois)}
    if not tasks:
        return {}
    _done, pending = await asyncio.wait(
        tasks.values(), timeout=settings.import_request_budget_seconds
    )
    for task in pending:
        task.cancel()
    await asyncio.gather(*pending, return_exceptions=True)
    return {
        doi: task.result()
        if task.done() and not task.cancelled() and task.exception() is None
        else DoiLookup("unavailable")
        for doi, task in tasks.items()
    }


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
    """Import identifiers (one per list item) into a collection with a result
    per non-blank line: ``added``, ``duplicate`` (within the batch or already
    in the collection), ``invalid``, ``not_found`` (never inserted) or
    ``unresolved`` (inserted as pending while providers are unavailable).

    Same transaction shape as ``service.add_paper``: validate and pre-dedupe,
    commit, resolve DOIs concurrently with no transaction open, then write
    the rows one by one in a short transaction.
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

    cached = await get_cached_papers_by_keys(db, seen)
    present = await keys_in_collection(db, collection_id, seen)
    to_resolve = [
        parsed.doi
        for _, _, parsed in candidates
        if parsed.doi and parsed.canonical_key not in cached and parsed.canonical_key not in present
    ]
    lookups: dict[str, DoiLookup] = {}
    if to_resolve:
        await db.commit()
        lookups = await _resolve_dois(to_resolve)
        await reopen_for_write(db, collection_id, user_id)
        # Alias DOIs can resolve to the same provider record.
        found = list(
            {
                lookup.paper.canonical_key: lookup.paper
                for lookup in lookups.values()
                if lookup.paper is not None
            }.values()
        )
        await cache_papers(db, found)
        found_keys = {paper.canonical_key for paper in found}
        cached.update(await get_cached_papers_by_keys(db, found_keys))
        present = await keys_in_collection(db, collection_id, seen | found_keys)

    for line_no, raw, parsed in candidates:
        key = parsed.canonical_key
        row = cached.get(key)
        if key not in present and row is None:
            lookup = lookups.get(parsed.doi) if parsed.doi else None
            if lookup is None or lookup.status == "not_found":
                results[line_no] = _line(line_no, raw, "not_found", key)
                continue
            if lookup.paper is not None:
                key = lookup.paper.canonical_key
                row = cached.get(key)
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
