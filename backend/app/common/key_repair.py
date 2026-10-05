"""Repair paper keys stored before identifiers were normalized.

Until the identifier boundary existed, whatever a user pasted became the paper
key: bare DOIs, ``DOI:``-labelled keys, doi.org links. The same paper could
then live under several keys, one of them unresolvable. This module maps each
such key onto its ``doi:<lowercase doi>`` form in every key-bearing table and
merges it with rows already stored under that form.

It runs inside Alembic revision ``1d2e3f4a5b6c`` and from
``scripts/repair_paper_keys.py``, and powers the per-user
``POST /library/resolve``. It therefore uses plain sync Core over frozen
``sa.table()`` clauses and a frozen copy of the key normalizer: later changes
to the ORM models or to ``app.common.identifiers`` must not change what the
migration does (``tests/test_key_repair.py`` checks normalizer parity).
``cached_paper_metadata`` is never modified.

Keys of the other strong identifiers (``s2:``, ``arxiv:``, ``pmid:``,
``pmcid:``, ``openalex:``) are left alone and not reported: they are valid
as stored, and reads resolve them through the cache aliases. The repair is
not alias-aware: a raw DOI whose paper is cached under an ``s2:`` key moves
to its ``doi:`` form, not onto the ``s2:`` key; reads still find the paper
through its DOI alias, and ``POST /library/resolve`` merges it later.
"""

from __future__ import annotations

import hashlib
import re
import uuid
from collections import Counter
from collections.abc import Iterable
from dataclasses import dataclass, field
from datetime import datetime
from urllib.parse import unquote

import sqlalchemy as sa
from sqlalchemy.engine import Connection

# ── Frozen key normalizer (app.common.identifiers as of 1d2e3f4a5b6c) ──────
# Do not edit: the migration must keep producing the same keys.

_DOI_RE = re.compile(r"^10\.\d+(?:\.\d+)*/\S+$")
# Whitespace (``\s`` includes NBSP) plus the zero-width characters that ride
# along with copy/paste.
_EDGE_RE = re.compile(r"^[\s\u200b\u200c\u200d\u2060\ufeff]+|[\s\u200b\u200c\u200d\u2060\ufeff]+$")
_PREFIX_RE = re.compile(
    r"^(?:https?://(?:dx\.|www\.)?doi\.org/|(?:dx\.|www\.)?doi\.org/|doi:\s*|doi\s+)",
    re.IGNORECASE,
)
_URL_FORM_RE = re.compile(r"://|doi\.org", re.IGNORECASE)


def _strip_edges(value: str) -> str:
    return _EDGE_RE.sub("", value)


def _frozen_normalize_doi(raw: str) -> str | None:
    cleaned = _strip_edges(raw)
    if "%" in cleaned and _URL_FORM_RE.search(cleaned):
        cleaned = _strip_edges(unquote(cleaned))
    for _ in range(3):
        stripped = _PREFIX_RE.sub("", cleaned, count=1)
        if stripped == cleaned:
            break
        cleaned = _strip_edges(stripped)
    doi = cleaned.lower()
    return doi if _DOI_RE.fullmatch(doi) else None


def frozen_normalize_paper_key(raw: str) -> str:
    """``hash:``/``group:`` keys pass through, DOI-like input becomes
    ``doi:<lowercase doi>``, anything else comes back stripped."""
    value = _strip_edges(raw)
    if value.startswith(("hash:", "group:")):
        return value
    doi = _frozen_normalize_doi(value)
    return f"doi:{doi}" if doi else value


def frozen_synthetic_group_key(canonical_key: str) -> str:
    digest = hashlib.sha256(canonical_key.encode("utf-8")).hexdigest()[:16]
    return f"group:{digest}"


def _is_doi_key(key: str) -> bool:
    return key.startswith("doi:") and _DOI_RE.fullmatch(key[4:]) is not None


# Most progressed first, as in revision f5c8d9e0a1b3: when two states for the
# same paper merge, the earlier one in this list wins.
_STATE_PRIORITY = (
    "important",
    "read",
    "reading",
    "to_read",
    "saved",
    "seen",
    "unseen",
    "ignored",
    "excluded",
)
_STATE_RANK = {state: rank for rank, state in enumerate(_STATE_PRIORITY)}

# ── Frozen tables ───────────────────────────────────────────────────────────
# Enum columns stay untyped, and so do the values compared with them (see
# _untyped), so PostgreSQL infers the enum type from the column.

_collection_papers = sa.table(
    "collection_papers",
    sa.column("collection_id", sa.Uuid()),
    sa.column("paper_canonical_key", sa.String()),
    sa.column("added_by", sa.Uuid()),
    sa.column("position", sa.Integer()),
    sa.column("added_at", sa.DateTime()),
)
_cached = sa.table(
    "cached_paper_metadata",
    sa.column("canonical_key", sa.String()),
    sa.column("paper_group_key", sa.String()),
)
_entries = sa.table(
    "user_library_entries",
    sa.column("user_id", sa.Uuid()),
    sa.column("paper_group_key", sa.String()),
    sa.column("primary_canonical_key", sa.String()),
    sa.column("created_at", sa.DateTime()),
)
_versions = sa.table(
    "user_library_versions",
    sa.column("user_id", sa.Uuid()),
    sa.column("paper_canonical_key", sa.String()),
    sa.column("paper_group_key", sa.String()),
    sa.column("source_provider", sa.String()),
    sa.column("added_at", sa.DateTime()),
)
_states = sa.table(
    "user_paper_states",
    sa.column("user_id", sa.Uuid()),
    sa.column("paper_canonical_key", sa.String()),
    sa.column("state"),
    sa.column("updated_at", sa.DateTime()),
)
_tags = sa.table(
    "user_paper_tags",
    sa.column("user_id", sa.Uuid()),
    sa.column("paper_canonical_key", sa.String()),
    sa.column("tag", sa.String()),
    sa.column("paper_group_key", sa.String()),
)
_notes = sa.table(
    "notes",
    sa.column("user_id", sa.Uuid()),
    sa.column("target_type"),
    sa.column("target_key", sa.String()),
    sa.column("paper_group_key", sa.String()),
)
_dismissed = sa.table(
    "user_dismissed_papers",
    sa.column("user_id", sa.Uuid()),
    sa.column("paper_canonical_key", sa.String()),
)
_zotero_links = sa.table(
    "zotero_links",
    sa.column("user_id", sa.Uuid()),
    sa.column("local_type", sa.String()),
    sa.column("local_key", sa.String()),
)
_edges = sa.table(
    "paper_graph_edges",
    sa.column("source_key", sa.String()),
    sa.column("target_key", sa.String()),
    sa.column("relation_type"),
)


def _untyped(value: str) -> sa.BindParameter[str]:
    """A bind parameter with no type: a typed one would be cast to VARCHAR,
    which PostgreSQL cannot compare with an enum column."""
    return sa.literal(value, type_=sa.types.NullType())


@dataclass
class RepairReport:
    mapped: int = 0
    counts: dict[str, int] = field(default_factory=dict)
    unrepairable: list[str] = field(default_factory=list)


# ── Planning ────────────────────────────────────────────────────────────────


def _key_sources() -> list[sa.Select]:
    paper_notes = _notes.c.target_type == _untyped("paper")
    paper_links = _zotero_links.c.local_type == "paper"
    return [
        sa.select(_collection_papers.c.paper_canonical_key.label("k")),
        sa.select(_versions.c.paper_canonical_key.label("k")),
        sa.select(_entries.c.primary_canonical_key.label("k")),
        sa.select(_states.c.paper_canonical_key.label("k")),
        sa.select(_tags.c.paper_canonical_key.label("k")),
        sa.select(_notes.c.target_key.label("k")).where(paper_notes),
        sa.select(_dismissed.c.paper_canonical_key.label("k")),
        sa.select(_zotero_links.c.local_key.label("k")).where(paper_links),
        sa.select(_edges.c.source_key.label("k")),
        sa.select(_edges.c.target_key.label("k")),
    ]


# Keys that are never re-keyed or reported: synthetic keys and the strong
# identifiers other than DOIs, which are valid as stored.
_PASS_THROUGH_PREFIXES = ("hash:", "group:", "s2:", "arxiv:", "pmid:", "pmcid:", "openalex:")


def _candidate_keys(conn: Connection) -> list[str]:
    """Every stored paper key that is neither a hash/group key, nor a strong
    non-DOI identifier key, nor the key of a cached snapshot (provider keys
    are authoritative as they are)."""
    keys = sa.union(*_key_sources()).subquery()
    stmt = (
        sa.select(keys.c.k)
        .where(
            keys.c.k.is_not(None),
            *(sa.not_(keys.c.k.like(f"{prefix}%")) for prefix in _PASS_THROUGH_PREFIXES),
            ~sa.exists().where(_cached.c.canonical_key == keys.c.k),
        )
        .order_by(keys.c.k)
    )
    return [row[0] for row in conn.execute(stmt)]


def _plan(conn: Connection) -> tuple[dict[str, str], list[str]]:
    mapping: dict[str, str] = {}
    unrepairable: list[str] = []
    for key in _candidate_keys(conn):
        target = frozen_normalize_paper_key(key)
        if not _is_doi_key(target):
            unrepairable.append(key)
        elif target != key:
            mapping[key] = target
    return mapping, unrepairable


def plan_key_map(conn: Connection) -> dict[str, str]:
    """``{stored key: doi:<normalized>}`` for every key that needs repair."""
    return _plan(conn)[0]


# ── Helpers ─────────────────────────────────────────────────────────────────


def _earliest(*values):
    present = [value for value in values if value is not None]
    return min(present) if present else None


def _pin(conn: Connection, user_id: uuid.UUID, key: str):
    v = _versions.c
    return conn.execute(
        sa.select(v.paper_group_key, v.source_provider, v.added_at).where(
            v.user_id == user_id, v.paper_canonical_key == key
        )
    ).first()


def _entry_created_at(conn: Connection, user_id: uuid.UUID, group: str) -> datetime | None:
    e = _entries.c
    return conn.execute(
        sa.select(e.created_at).where(e.user_id == user_id, e.paper_group_key == group)
    ).scalar()


def _entry_exists(conn: Connection, user_id: uuid.UUID, group: str) -> bool:
    e = _entries.c
    return (
        conn.execute(
            sa.select(sa.literal(1)).where(e.user_id == user_id, e.paper_group_key == group)
        ).first()
        is not None
    )


def _cached_group(conn: Connection, key: str) -> str | None:
    return conn.execute(
        sa.select(_cached.c.paper_group_key).where(_cached.c.canonical_key == key)
    ).scalar()


def _target_group(conn: Connection, user_id: uuid.UUID, old: str, new: str) -> str:
    """The cached group, else the group an existing pin already uses, else a
    synthetic one (the old key's own synthetic group is never kept)."""
    cached = _cached_group(conn, new)
    if cached:
        return cached
    pin_new = _pin(conn, user_id, new)
    if pin_new is not None:
        return pin_new.paper_group_key
    pin_old = _pin(conn, user_id, old)
    if pin_old is not None and pin_old.paper_group_key != frozen_synthetic_group_key(old):
        return pin_old.paper_group_key
    return frozen_synthetic_group_key(new)


def _users_with_key(conn: Connection, key: str) -> list[uuid.UUID]:
    selects = [
        sa.select(_versions.c.user_id).where(_versions.c.paper_canonical_key == key),
        sa.select(_entries.c.user_id).where(_entries.c.primary_canonical_key == key),
        sa.select(_states.c.user_id).where(_states.c.paper_canonical_key == key),
        sa.select(_tags.c.user_id).where(_tags.c.paper_canonical_key == key),
        sa.select(_notes.c.user_id).where(
            _notes.c.target_type == _untyped("paper"), _notes.c.target_key == key
        ),
        sa.select(_dismissed.c.user_id).where(_dismissed.c.paper_canonical_key == key),
        sa.select(_zotero_links.c.user_id).where(
            _zotero_links.c.local_type == "paper", _zotero_links.c.local_key == key
        ),
    ]
    users = {row[0] for stmt in selects for row in conn.execute(stmt)}
    return sorted(users, key=str)


# ── Re-keying steps ─────────────────────────────────────────────────────────


def _rekey_collection_rows(
    conn: Connection,
    old: str,
    new: str,
    collection_ids: Iterable[uuid.UUID] | None,
    counts: Counter[str],
) -> None:
    """Rename the collection rows; where the collection already holds ``new``,
    merge into it keeping the earliest position and ``added_at``."""
    cp = _collection_papers.c
    stmt = sa.select(cp.collection_id, cp.position, cp.added_at, cp.added_by).where(
        cp.paper_canonical_key == old
    )
    if collection_ids is not None:
        ids = list(collection_ids)
        if not ids:
            return
        stmt = stmt.where(cp.collection_id.in_(ids))
    for row in conn.execute(stmt).all():
        in_collection = cp.collection_id == row.collection_id
        existing = conn.execute(
            sa.select(cp.position, cp.added_at, cp.added_by).where(
                in_collection, cp.paper_canonical_key == new
            )
        ).first()
        if existing is None:
            conn.execute(
                sa.update(_collection_papers)
                .where(in_collection, cp.paper_canonical_key == old)
                .values(paper_canonical_key=new)
            )
        else:
            conn.execute(
                sa.delete(_collection_papers).where(in_collection, cp.paper_canonical_key == old)
            )
            conn.execute(
                sa.update(_collection_papers)
                .where(in_collection, cp.paper_canonical_key == new)
                .values(
                    position=_earliest(existing.position, row.position),
                    added_at=_earliest(existing.added_at, row.added_at),
                    added_by=existing.added_by if existing.added_by is not None else row.added_by,
                )
            )
            counts["collection_papers_merged"] += 1
        counts["collection_papers"] += 1


def _move_tags(
    conn: Connection,
    user_id: uuid.UUID,
    scope: sa.ColumnElement[bool],
    target_group: str,
    counts: Counter[str],
) -> None:
    """Anchor the tags in ``scope`` to ``target_group``; a tag the group
    already carries (on any version) is dropped instead of duplicated."""
    t = _tags.c
    rows = conn.execute(
        sa.select(t.paper_canonical_key, t.tag).where(
            t.user_id == user_id,
            scope,
            sa.or_(t.paper_group_key.is_(None), t.paper_group_key != target_group),
        )
    ).all()
    for row in rows:
        this_row = sa.and_(
            t.user_id == user_id, t.paper_canonical_key == row.paper_canonical_key, t.tag == row.tag
        )
        duplicate = conn.execute(
            sa.select(sa.literal(1)).where(
                t.user_id == user_id, t.paper_group_key == target_group, t.tag == row.tag
            )
        ).first()
        if duplicate is not None:
            conn.execute(sa.delete(_tags).where(this_row))
        else:
            conn.execute(sa.update(_tags).where(this_row).values(paper_group_key=target_group))
        counts["user_paper_tags"] += 1


def _rename_or_drop(
    conn: Connection,
    table: sa.TableClause,
    key_column: str,
    scope: list[sa.ColumnElement[bool]],
    old: str,
    new: str,
    counts: Counter[str],
) -> None:
    """Rename a single-key row, dropping it when the new key already exists
    (the canonical row wins)."""
    column = table.c[key_column]
    if conn.execute(sa.select(sa.literal(1)).where(*scope, column == old)).first() is None:
        return
    if conn.execute(sa.select(sa.literal(1)).where(*scope, column == new)).first() is None:
        conn.execute(sa.update(table).where(*scope, column == old).values({key_column: new}))
    else:
        conn.execute(sa.delete(table).where(*scope, column == old))
    counts[table.name] += 1


def _rekey_user(
    conn: Connection,
    user_id: uuid.UUID,
    old: str,
    new: str,
    target_group: str,
    counts: Counter[str],
) -> None:
    """Move one user's rows from ``old`` to ``new`` under ``target_group``.

    Order matters: pins reference their entry through a composite foreign key
    with ON DELETE CASCADE, so the target entry exists before any pin moves
    in, and an old entry is deleted only once no pin is left under it.
    """
    v, e, s, t, n = _versions.c, _entries.c, _states.c, _tags.c, _notes.c
    pin_old = _pin(conn, user_id, old)
    pin_new = _pin(conn, user_id, new)
    old_groups = {pin.paper_group_key for pin in (pin_old, pin_new) if pin is not None}
    old_groups.discard(target_group)

    # 1. Target entry first.
    if (pin_old is not None or pin_new is not None) and not _entry_exists(
        conn, user_id, target_group
    ):
        values = {
            "user_id": user_id,
            "paper_group_key": target_group,
            "primary_canonical_key": new,
        }
        created_at = _earliest(*(_entry_created_at(conn, user_id, g) for g in old_groups))
        if created_at is not None:
            values["created_at"] = created_at
        conn.execute(sa.insert(_entries).values(values))
        counts["user_library_entries"] += 1

    # 2. Pins: merge into an existing pin for the new key, else rename.
    if pin_old is not None:
        if pin_new is not None:
            conn.execute(
                sa.delete(_versions).where(v.user_id == user_id, v.paper_canonical_key == old)
            )
            conn.execute(
                sa.update(_versions)
                .where(v.user_id == user_id, v.paper_canonical_key == new)
                .values(
                    paper_group_key=target_group,
                    source_provider=pin_new.source_provider or pin_old.source_provider,
                    added_at=_earliest(pin_new.added_at, pin_old.added_at),
                )
            )
        else:
            conn.execute(
                sa.update(_versions)
                .where(v.user_id == user_id, v.paper_canonical_key == old)
                .values(paper_canonical_key=new, paper_group_key=target_group)
            )
        counts["user_library_versions"] += 1
    elif pin_new is not None and pin_new.paper_group_key != target_group:
        conn.execute(
            sa.update(_versions)
            .where(v.user_id == user_id, v.paper_canonical_key == new)
            .values(paper_group_key=target_group)
        )
        counts["user_library_versions"] += 1

    # 3. Entries the pins left: annotations follow the moved version (all of
    # them when the entry is now empty, which is then deleted).
    keys = (old, new)
    for group in sorted(old_groups):
        if not _entry_exists(conn, user_id, group):
            continue
        remaining = [
            row[0]
            for row in conn.execute(
                sa.select(v.paper_canonical_key)
                .where(v.user_id == user_id, v.paper_group_key == group)
                .order_by(v.added_at, v.paper_canonical_key)
            )
        ]
        if remaining:
            tag_scope = t.paper_canonical_key.in_(keys)
            note_scope = sa.and_(n.target_type == _untyped("paper"), n.target_key.in_(keys))
        else:
            tag_scope = t.paper_group_key == group
            note_scope = n.paper_group_key == group
        _move_tags(conn, user_id, tag_scope, target_group, counts)
        result = conn.execute(
            sa.update(_notes)
            .where(n.user_id == user_id, note_scope)
            .values(paper_group_key=target_group)
        )
        counts["notes"] += result.rowcount or 0
        in_group = sa.and_(e.user_id == user_id, e.paper_group_key == group)
        if remaining:
            result = conn.execute(
                sa.update(_entries)
                .where(in_group, e.primary_canonical_key.in_(keys))
                .values(primary_canonical_key=remaining[0])
            )
            counts["user_library_entries"] += result.rowcount or 0
        else:
            conn.execute(sa.delete(_entries).where(in_group))
            counts["user_library_entries"] += 1

    result = conn.execute(
        sa.update(_entries)
        .where(e.user_id == user_id, e.primary_canonical_key == old)
        .values(primary_canonical_key=new)
    )
    counts["user_library_entries"] += result.rowcount or 0

    # 4. Reading state: the most progressed one wins, with the latest time.
    state_old = conn.execute(
        sa.select(s.state, s.updated_at).where(s.user_id == user_id, s.paper_canonical_key == old)
    ).first()
    if state_old is not None:
        state_new = conn.execute(
            sa.select(s.state, s.updated_at).where(
                s.user_id == user_id, s.paper_canonical_key == new
            )
        ).first()
        if state_new is None:
            conn.execute(
                sa.update(_states)
                .where(s.user_id == user_id, s.paper_canonical_key == old)
                .values(paper_canonical_key=new)
            )
        else:
            unknown = len(_STATE_PRIORITY)
            winner = min(
                (state_new.state, state_old.state), key=lambda st: _STATE_RANK.get(st, unknown)
            )
            conn.execute(
                sa.delete(_states).where(s.user_id == user_id, s.paper_canonical_key == old)
            )
            conn.execute(
                sa.update(_states)
                .where(s.user_id == user_id, s.paper_canonical_key == new)
                .values(
                    state=_untyped(winner),
                    updated_at=max(state_new.updated_at, state_old.updated_at),
                )
            )
        counts["user_paper_states"] += 1

    # 5. Tags: rename, dropping the ones the new key already has; then anchor
    # every tag of the new key to the target group without duplicates.
    for row in conn.execute(
        sa.select(t.tag).where(t.user_id == user_id, t.paper_canonical_key == old)
    ).all():
        this_row = sa.and_(t.user_id == user_id, t.paper_canonical_key == old, t.tag == row.tag)
        clash = conn.execute(
            sa.select(sa.literal(1)).where(
                t.user_id == user_id, t.paper_canonical_key == new, t.tag == row.tag
            )
        ).first()
        if clash is None:
            conn.execute(sa.update(_tags).where(this_row).values(paper_canonical_key=new))
        else:
            conn.execute(sa.delete(_tags).where(this_row))
        counts["user_paper_tags"] += 1
    _move_tags(conn, user_id, t.paper_canonical_key == new, target_group, counts)

    # 6. Notes on the paper.
    paper_note = sa.and_(n.user_id == user_id, n.target_type == _untyped("paper"))
    result = conn.execute(
        sa.update(_notes)
        .where(paper_note, n.target_key == old)
        .values(target_key=new, paper_group_key=target_group)
    )
    counts["notes"] += result.rowcount or 0
    result = conn.execute(
        sa.update(_notes)
        .where(
            paper_note,
            n.target_key == new,
            sa.or_(n.paper_group_key.is_(None), n.paper_group_key != target_group),
        )
        .values(paper_group_key=target_group)
    )
    counts["notes"] += result.rowcount or 0

    # 7. Dismissals and Zotero links keep the canonical row on conflict.
    _rename_or_drop(
        conn,
        _dismissed,
        "paper_canonical_key",
        [_dismissed.c.user_id == user_id],
        old,
        new,
        counts,
    )
    _rename_or_drop(
        conn,
        _zotero_links,
        "local_key",
        [_zotero_links.c.user_id == user_id, _zotero_links.c.local_type == "paper"],
        old,
        new,
        counts,
    )


def _rekey_edges(conn: Connection, mapping: dict[str, str], counts: Counter[str]) -> None:
    """Rename both ends of stored citation edges, dropping an edge whose
    renamed form already exists."""
    ed = _edges.c
    olds = list(mapping)
    for start in range(0, len(olds), 500):
        chunk = olds[start : start + 500]
        rows = conn.execute(
            sa.select(ed.source_key, ed.target_key, ed.relation_type).where(
                sa.or_(ed.source_key.in_(chunk), ed.target_key.in_(chunk))
            )
        ).all()
        for row in rows:
            source = mapping.get(row.source_key, row.source_key)
            target = mapping.get(row.target_key, row.target_key)
            this_edge = sa.and_(
                ed.source_key == row.source_key,
                ed.target_key == row.target_key,
                ed.relation_type == _untyped(row.relation_type),
            )
            clash = conn.execute(
                sa.select(sa.literal(1)).where(
                    ed.source_key == source,
                    ed.target_key == target,
                    ed.relation_type == _untyped(row.relation_type),
                )
            ).first()
            if clash is None:
                conn.execute(
                    sa.update(_edges).where(this_edge).values(source_key=source, target_key=target)
                )
            else:
                conn.execute(sa.delete(_edges).where(this_edge))
            counts["paper_graph_edges"] += 1


# ── Entry points ────────────────────────────────────────────────────────────


def repair_paper_keys(conn: Connection, *, dry_run: bool = False) -> RepairReport:
    """Re-key every legacy DOI key to its ``doi:`` form, for all users.

    Idempotent: a second run maps nothing. Keys that cannot become a valid DOI
    (``doi:not-a-doi``) are left alone and reported. With ``dry_run`` the work
    happens inside a savepoint that is rolled back, so the counts are exact
    but nothing is written.
    """
    mapping, unrepairable = _plan(conn)
    counts: Counter[str] = Counter()
    savepoint = conn.begin_nested() if dry_run else None
    try:
        for old, new in mapping.items():
            _rekey_collection_rows(conn, old, new, None, counts)
            for user_id in _users_with_key(conn, old):
                target_group = _target_group(conn, user_id, old, new)
                _rekey_user(conn, user_id, old, new, target_group, counts)
        _rekey_edges(conn, mapping, counts)
    finally:
        if savepoint is not None:
            savepoint.rollback()
    return RepairReport(
        mapped=len(mapping), counts=dict(sorted(counts.items())), unrepairable=unrepairable
    )


def rekey_user_paper(
    conn: Connection,
    *,
    user_id: uuid.UUID,
    old_key: str,
    new_key: str,
    target_group: str,
    collection_ids: Iterable[uuid.UUID],
) -> dict[str, int]:
    """The same re-key for one user: their own rows plus the rows of the
    given collections (the ones they may edit). Global graph edges and other
    users' rows are left alone."""
    if old_key == new_key:
        return {}
    counts: Counter[str] = Counter()
    _rekey_collection_rows(conn, old_key, new_key, collection_ids, counts)
    _rekey_user(conn, user_id, old_key, new_key, target_group, counts)
    return dict(sorted(counts.items()))
