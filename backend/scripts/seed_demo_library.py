"""Seed a demo Library for local development and the responsive regression pass.

Dev-only: refuses to run when ENVIRONMENT=production (exit code 2). No
provider is called; papers are synthetic ``doi:10.5555/openbib-demo.*`` rows
(10.5555 is the DOI test prefix), apart from one DOI-less Semantic Scholar
record (an ``s2:`` key) and the audit paper of ``--legacy-raw-doi``. The
users must already exist.

    docker compose exec api python -m scripts.seed_demo_library \\
        --email audit@example.com --papers 400 --collections 4 --long-data
    docker compose exec api python -m scripts.seed_demo_library \\
        --email audit@example.com --legacy-raw-doi
    docker compose exec api python -m scripts.seed_demo_library \\
        --email audit@example.com --long-data --share-with editor@example.com

--papers N        cached metadata, Library entries, reading states, tags, notes
--collections N   spread the seeded papers over N demo collections
--long-data       a 200-character collection name, a 300-character title with
                  a 180-character unbroken token, 60 authors, missing metadata,
                  v1/v2/published versions, two same-year Crossref preprints
                  without a version, a 5,000-character note, an HTML abstract,
                  a DOI-less Semantic Scholar record and an unresolved entry
                  with a ~200-character DOI
--share-with EMAIL
                  share the long-data collection: that existing, verified
                  account becomes an editor, and a read link is enabled and
                  printed
--legacy-raw-doi  the pre-normalization key shapes from the UI audit, which
                  migration 1d2e3f4a5b6c repairs: run it with the database at
                  c7d8e9f0a1b2 (``alembic downgrade c7d8e9f0a1b2``)
--reset           first remove the demo rows this script writes for the user

Re-running without --reset keeps existing rows and adds what is missing.
"""

from __future__ import annotations

import argparse
import asyncio
import hashlib
import sys
from collections import Counter
from datetime import date, datetime, timedelta

from sqlalchemy import delete, func, or_, select, text
from sqlalchemy.ext.asyncio import AsyncSession

# Import every model module so SQLAlchemy can resolve FK relationships
# even when running outside the FastAPI app entrypoint.
from app.auth import models as _auth_models  # noqa: F401
from app.collections.models import Collection, CollectionMember, CollectionPaper
from app.collections.sharing import read_link
from app.common.canonical import build_paper_group_key
from app.common.identifiers import synthetic_group_key
from app.config import settings
from app.database import async_session_factory
from app.graph import models as _graph_models  # noqa: F401
from app.library.models import UserLibraryEntry, UserLibraryVersion
from app.notes.models import Note
from app.papers.models import UserPaperState, UserPaperTag
from app.papers.service import cache_papers
from app.providers.base import Author, PaperMetadata
from app.users.models import User
from app.zotero import models as _zotero_models  # noqa: F401

SEED_MARKER = "Seeded by scripts.seed_demo_library"
DEMO_PREFIX = "doi:10.5555/openbib-demo."
AUDIT_COLLECTION = "OpenBib UI audit — temporary test"
TNN = "doi:10.1109/tnn.2008.2005605"
LEGACY_KEYS = (
    "10.1109/tnn.2008.2005605",
    TNN,
    "https://dx.doi.org/10.1109/TNN.2008.2005605",
    "doi:DOI:10.1000/XYZ123",
    "doi:not-a-doi",
)
# What the repair turns the legacy keys into, so --reset also finds them.
REPAIRED_KEYS = ("doi:10.1000/xyz123",)
# A DOI-less record: Semantic Scholar keys it by its 40-hex paperId.
S2_DEMO_ID = hashlib.sha1(b"openbib-demo-s2").hexdigest()
S2_DEMO_KEY = f"s2:{S2_DEMO_ID}"

TOPICS = (
    "graph neural networks",
    "citation analysis",
    "protein structure prediction",
    "climate model ensembles",
    "sparse attention",
    "federated learning",
    "causal inference",
    "reinforcement learning",
    "scholarly metadata",
    "information retrieval",
    "open access publishing",
    "scientific knowledge graphs",
)
TITLE_TEMPLATES = (
    "A survey of {a}",
    "{A} at scale",
    "Revisiting {a}: lessons from {b}",
    "Towards robust {a}",
    "On the limits of {a} for {b}",
    "Benchmarking {a} with {b}",
)
GIVEN_NAMES = (
    "Ada",
    "Wei",
    "Priya",
    "Lars",
    "Chiara",
    "Kwame",
    "Sofia",
    "Hiroshi",
    "Amara",
    "Jonas",
)
SURNAMES = (
    "Rossi",
    "Nakamura",
    "Okafor",
    "Lindqvist",
    "Moreau",
    "Kowalski",
    "Haddad",
    "García",
    "Chen",
    "Müller",
    "Ferreira",
    "Novak",
)
VENUES = (
    "Nature",
    "NeurIPS",
    "IEEE Transactions on Neural Networks",
    "Journal of Informetrics",
    "PLOS ONE",
    None,
)
PROVIDERS = ("openalex", "crossref", "europepmc")
TAGS = ("to-cite", "survey", "methods", "dataset", "baseline", "reviewed", "thesis")
STATES = ("to_read", "reading", "read", "important", "saved", None, None)

LONG_COLLECTION_NAME = (
    "Long data check: an exceptionally long collection name that keeps going so that cards, "
    "headers, menus and dialogs have to wrap or truncate it gracefully on every viewport, "
    "in both languages at 2× text"
)  # 200 characters, the column limit
UNBROKEN_TOKEN = ("Pneumonoultramicroscopicsilicovolcanoconiosis" * 4)[:180]
LONG_TITLE = (
    f"On {UNBROKEN_TOKEN} and other unbroken identifiers: why interfaces must wrap long "
    "tokens, long subtitles and long qualifiers gracefully."
)  # 300 characters
UNRESOLVED_LONG_KEY = "doi:10.5555/openbib-demo.unresolved." + (
    "an-unresolved-identifier-with-a-very-long-suffix-" * 4
)[:168].rstrip("-")
HTML_ABSTRACT = (
    "<h4>Background</h4>Odour perception is hard to predict from molecular structure."
    "<h4>Methods</h4>We train a graph neural network on 5,000 labelled molecules."
    "<h4>Results</h4>The model outperforms fingerprint baselines on held-out odorants."
    "<h4>Conclusions</h4>Message passing captures structure–odour relationships."
)


def _note_text(length: int) -> str:
    paragraph = (
        "This long note checks that the notes panel scrolls inside the dialog, wraps long "
        "lines and keeps its actions reachable. "
    )
    return (paragraph * (length // len(paragraph) + 1))[:length]


def _authors(names: list[str]) -> list[Author]:
    return [Author(name=name) for name in names]


def _paper(
    key: str,
    title: str,
    names: list[str],
    *,
    group: str | None = None,
    provider_source: str = "openalex",
    **fields,
) -> PaperMetadata:
    return PaperMetadata(
        canonical_key=key,
        paper_group_key=group or build_paper_group_key(title, names),
        title=title,
        authors=_authors(names),
        doi=key.removeprefix("doi:") if key.startswith("doi:") else None,
        provider_source=provider_source,
        **fields,
    )


def demo_paper(index: int) -> PaperMetadata:
    a = TOPICS[index % len(TOPICS)]
    b = TOPICS[(index * 7 + 3) % len(TOPICS)]
    template = TITLE_TEMPLATES[index % len(TITLE_TEMPLATES)]
    title = f"{template.format(a=a, A=a.capitalize(), b=b)} (demo {index:04d})"
    names = [
        f"{GIVEN_NAMES[(index + k) % len(GIVEN_NAMES)]} {SURNAMES[(index * 3 + k) % len(SURNAMES)]}"
        for k in range(1 + index % 6)
    ]
    year = 1995 + (index * 13) % 31
    return _paper(
        f"{DEMO_PREFIX}{index:04d}",
        title,
        names,
        abstract=f"We study {a} and its interplay with {b}. Demo abstract number {index}.",
        publication_date=date(year, 1 + index % 12, 1 + index % 28),
        venue=VENUES[index % len(VENUES)],
        paper_type="article",
        open_access=index % 3 == 0,
        cited_by_count=(index * 37) % 5000,
        reference_count=10 + index % 90,
        provider_source=PROVIDERS[index % len(PROVIDERS)],
    )


# ── Writers ────────────────────────────────────────────────────────────────


async def _find_user(db: AsyncSession, email: str) -> User | None:
    result = await db.execute(select(User).where(User.email == email.strip().lower()))
    return result.scalar_one_or_none()


async def _collection(db: AsyncSession, user: User, name: str, counts: Counter[str]) -> Collection:
    result = await db.execute(
        select(Collection).where(Collection.owner_id == user.id, Collection.name == name)
    )
    coll = result.scalars().first()
    if coll is None:
        coll = Collection(owner_id=user.id, name=name, description=SEED_MARKER)
        db.add(coll)
        await db.flush()
        db.add(CollectionMember(collection_id=coll.id, user_id=user.id, role="owner"))
        await db.flush()
        counts["collections"] += 1
    return coll


async def _add_to_collection(
    db: AsyncSession, coll: Collection, user: User, key: str, counts: Counter[str]
) -> None:
    if await db.get(CollectionPaper, (coll.id, key)) is not None:
        return
    max_pos = await db.execute(
        select(func.coalesce(func.max(CollectionPaper.position), -1)).where(
            CollectionPaper.collection_id == coll.id
        )
    )
    db.add(
        CollectionPaper(
            collection_id=coll.id,
            paper_canonical_key=key,
            added_by=user.id,
            position=(max_pos.scalar() or 0) + 1,
        )
    )
    await db.flush()
    counts["collection_papers"] += 1


async def _pin(
    db: AsyncSession,
    user: User,
    key: str,
    group: str,
    counts: Counter[str],
    *,
    created_at: datetime | None = None,
    provider: str | None = None,
) -> None:
    """Library entry + version pin, written directly so legacy shapes (raw
    keys under synthetic groups) can be reproduced as they were stored. A
    paper that is already pinned is left where it is."""
    if await db.get(UserLibraryVersion, (user.id, key)) is not None:
        return
    if await db.get(UserLibraryEntry, (user.id, group)) is None:
        entry = UserLibraryEntry(user_id=user.id, paper_group_key=group, primary_canonical_key=key)
        if created_at is not None:
            entry.created_at = created_at
        db.add(entry)
        await db.flush()
        counts["library_entries"] += 1
    pin = UserLibraryVersion(
        user_id=user.id,
        paper_canonical_key=key,
        paper_group_key=group,
        source_provider=provider,
    )
    if created_at is not None:
        pin.added_at = created_at
    db.add(pin)
    await db.flush()
    counts["library_versions"] += 1


async def _state(db: AsyncSession, user: User, key: str, state: str, counts: Counter[str]) -> None:
    if await db.get(UserPaperState, (user.id, key)) is None:
        db.add(UserPaperState(user_id=user.id, paper_canonical_key=key, state=state))
        await db.flush()
        counts["states"] += 1


async def _tag(
    db: AsyncSession, user: User, key: str, tag: str, group: str | None, counts: Counter[str]
) -> None:
    if await db.get(UserPaperTag, (user.id, key, tag)) is None:
        db.add(
            UserPaperTag(user_id=user.id, paper_canonical_key=key, tag=tag, paper_group_key=group)
        )
        await db.flush()
        counts["tags"] += 1


async def _note(
    db: AsyncSession, user: User, key: str, group: str | None, content: str, counts: Counter[str]
) -> None:
    existing = await db.execute(
        select(Note.id).where(
            Note.user_id == user.id, Note.target_type == "paper", Note.target_key == key
        )
    )
    if existing.first() is None:
        db.add(
            Note(
                user_id=user.id,
                target_type="paper",
                target_key=key,
                paper_group_key=group,
                content=content,
            )
        )
        await db.flush()
        counts["notes"] += 1


async def seed_papers(db: AsyncSession, user: User, papers: int, collections: int) -> Counter[str]:
    counts: Counter[str] = Counter()
    batch = [demo_paper(index) for index in range(papers)]
    for start in range(0, len(batch), 100):
        await cache_papers(db, batch[start : start + 100])
    counts["cached_papers"] = len(batch)
    colls = [
        await _collection(db, user, f"Demo collection {number + 1}", counts)
        for number in range(collections)
    ]
    # Newest first in the Library, in seed order.
    now = datetime.now().replace(microsecond=0)
    for index, paper in enumerate(batch):
        key, group = paper.canonical_key, paper.paper_group_key
        await _pin(
            db,
            user,
            key,
            group,
            counts,
            created_at=now - timedelta(minutes=index),
            provider=paper.provider_source,
        )
        if colls:
            await _add_to_collection(db, colls[index % len(colls)], user, key, counts)
            if len(colls) > 1 and index % 5 == 0:
                await _add_to_collection(db, colls[(index + 1) % len(colls)], user, key, counts)
        state = STATES[index % len(STATES)]
        if state is not None:
            await _state(db, user, key, state, counts)
        for offset in range(index % 3):
            await _tag(db, user, key, TAGS[(index + offset * 2) % len(TAGS)], group, counts)
        if index % 10 == 0:
            await _note(db, user, key, group, f"Demo note for paper {index}.", counts)
    return counts


async def seed_long_data(db: AsyncSession, user: User) -> Counter[str]:
    counts: Counter[str] = Counter()
    coll = await _collection(db, user, LONG_COLLECTION_NAME, counts)
    many = [
        f"{GIVEN_NAMES[k % len(GIVEN_NAMES)]} {SURNAMES[(k * 5) % len(SURNAMES)]}-{k + 1}"
        for k in range(60)
    ]
    versions_title = "Scaling laws for citation graphs"
    versions_names = ["Chiara Moreau", "Kwame Okafor"]
    versions_group = build_paper_group_key(versions_title, versions_names)
    preprint_title = "Review of bidirected and multidirected graph neural networks"
    preprint_names = ["Sofia Novak"]
    preprint_group = build_paper_group_key(preprint_title, preprint_names)
    papers = [
        _paper(
            f"{DEMO_PREFIX}long-title",
            LONG_TITLE,
            ["Lars Lindqvist"],
            abstract="A paper whose title carries a 180-character unbroken token.",
            publication_date=date(2024, 5, 2),
            venue="Journal of Informetrics",
        ),
        _paper(
            f"{DEMO_PREFIX}many-authors",
            "A consortium paper with sixty authors",
            many,
            abstract="Checks author lists that must collapse instead of overflowing.",
            publication_date=date(2023, 11, 20),
            venue="Nature",
            cited_by_count=1234,
        ),
        _paper(
            f"{DEMO_PREFIX}sparse",
            "Working paper with missing metadata",
            [],
            provider_source="crossref",
        ),
        _paper(
            f"{DEMO_PREFIX}versions.v1",
            versions_title,
            versions_names,
            group=versions_group,
            version="v1",
            paper_type="preprint",
            venue="arXiv",
            publication_date=date(2021, 2, 1),
            provider_source="arxiv",
        ),
        _paper(
            f"{DEMO_PREFIX}versions.v2",
            versions_title,
            versions_names,
            group=versions_group,
            version="v2",
            paper_type="preprint",
            venue="arXiv",
            publication_date=date(2021, 6, 1),
            provider_source="arxiv",
        ),
        _paper(
            f"{DEMO_PREFIX}versions.published",
            versions_title,
            versions_names,
            group=versions_group,
            paper_type="article",
            venue="Journal of Informetrics",
            publication_date=date(2022, 3, 15),
            cited_by_count=87,
        ),
        _paper(
            f"{DEMO_PREFIX}preprint-a",
            preprint_title,
            preprint_names,
            group=preprint_group,
            paper_type="posted-content",
            publication_date=date(2023, 3, 1),
            provider_source="crossref",
        ),
        _paper(
            f"{DEMO_PREFIX}preprint-b",
            preprint_title,
            preprint_names,
            group=preprint_group,
            paper_type="posted-content",
            publication_date=date(2023, 9, 15),
            provider_source="crossref",
        ),
        _paper(
            f"{DEMO_PREFIX}html-abstract",
            "PharmaGNN: odour prediction with graph neural networks",
            ["Priya Haddad", "Jonas Ferreira"],
            abstract=HTML_ABSTRACT,
            publication_date=date(2022, 8, 9),
            venue="PLOS ONE",
            provider_source="europepmc",
        ),
        _paper(
            S2_DEMO_KEY,
            "A Semantic Scholar record without a DOI",
            ["Amara Chen", "Hiroshi Kowalski"],
            abstract="Keyed by its Semantic Scholar paperId: there is no DOI to show or resolve.",
            publication_date=date(2020, 4, 1),
            venue="Workshop on Scholarly Metadata",
            semantic_scholar_id=S2_DEMO_ID,
            abstract_url=f"https://www.semanticscholar.org/paper/{S2_DEMO_ID}",
            cited_by_count=12,
            provider_source="semantic_scholar",
        ),
    ]
    await cache_papers(db, papers)
    counts["cached_papers"] += len(papers)

    for paper in papers:
        await _pin(db, user, paper.canonical_key, paper.paper_group_key, counts)
    # The collection holds one version per logical paper; the other versions
    # stay pinned in the Library only (so they can be removed from there).
    for paper in papers:
        if paper.canonical_key.endswith((".v1", ".v2", "preprint-b")):
            continue
        await _add_to_collection(db, coll, user, paper.canonical_key, counts)
    for entry_key, primary in (
        (versions_group, f"{DEMO_PREFIX}versions.published"),
        (preprint_group, f"{DEMO_PREFIX}preprint-a"),
    ):
        entry = await db.get(UserLibraryEntry, (user.id, entry_key))
        if entry is not None:
            entry.primary_canonical_key = primary

    long_title_key = f"{DEMO_PREFIX}long-title"
    long_title_group = papers[0].paper_group_key
    await _note(db, user, long_title_key, long_title_group, _note_text(5000), counts)
    await _tag(
        db, user, long_title_key, "a-rather-long-tag-name-for-wrapping", long_title_group, counts
    )
    await _state(db, user, long_title_key, "reading", counts)

    # Pending: no cached metadata, a synthetic group, as after a provider outage.
    unresolved_group = synthetic_group_key(UNRESOLVED_LONG_KEY)
    await _pin(db, user, UNRESOLVED_LONG_KEY, unresolved_group, counts)
    await _add_to_collection(db, coll, user, UNRESOLVED_LONG_KEY, counts)
    await db.flush()
    return counts


async def seed_sharing(
    db: AsyncSession, user: User, editor_email: str
) -> tuple[Counter[str], str | None]:
    """Share the long-data collection: ``editor_email`` (an existing,
    verified account) becomes an editor and a read link is enabled. Returns
    the counts and the read-link URL (``None`` when the editor is unknown)."""
    counts: Counter[str] = Counter()
    editor = await _find_user(db, editor_email)
    if editor is None or editor.email_verified_at is None or editor.id == user.id:
        return counts, None
    coll = await _collection(db, user, LONG_COLLECTION_NAME, counts)
    member = await db.get(CollectionMember, (coll.id, editor.id))
    if member is None:
        db.add(CollectionMember(collection_id=coll.id, user_id=editor.id, role="editor"))
        counts["editors"] += 1
    elif member.role != "editor":
        member.role = "editor"
        counts["editors"] += 1
    await db.flush()
    link = await read_link(db, coll.id, user.id, "enable")
    return counts, link["url"]


async def seed_legacy_raw_doi(db: AsyncSession, user: User) -> Counter[str]:
    """The audit account's state: raw and ``doi:`` rows for one paper in one
    collection, their conflicting states, a duplicate tag and a note on the
    raw key, plus keys that only normalization (or the user) can fix."""
    counts: Counter[str] = Counter()
    names = [
        "Franco Scarselli",
        "Marco Gori",
        "Ah Chung Tsoi",
        "Markus Hagenbuchner",
        "Gabriele Monfardini",
    ]
    gnn = _paper(
        TNN,
        "The Graph Neural Network Model",
        names,
        publication_date=date(2009, 1, 1),
        venue="IEEE Transactions on Neural Networks",
        volume="20",
        issue="1",
        pages="61-80",
        paper_type="article",
        cited_by_count=7000,
    )
    await cache_papers(db, [gnn])
    counts["cached_papers"] += 1
    coll = await _collection(db, user, AUDIT_COLLECTION, counts)
    raw = LEGACY_KEYS[0]
    for key in LEGACY_KEYS:
        group = gnn.paper_group_key if key == TNN else synthetic_group_key(key)
        await _add_to_collection(db, coll, user, key, counts)
        await _pin(db, user, key, group, counts)
    await _state(db, user, raw, "reading", counts)
    await _state(db, user, TNN, "to_read", counts)
    await _tag(db, user, raw, "gnn", synthetic_group_key(raw), counts)
    await _tag(db, user, TNN, "gnn", gnn.paper_group_key, counts)
    await _note(db, user, raw, synthetic_group_key(raw), "Note written on the raw DOI key.", counts)
    return counts


async def reset_demo_data(db: AsyncSession, user: User) -> Counter[str]:
    """Remove what this script writes for the user (the global cached
    metadata stays)."""
    counts: Counter[str] = Counter()
    demo_collections = select(Collection.id).where(
        Collection.owner_id == user.id, Collection.description == SEED_MARKER
    )
    await db.execute(
        delete(CollectionPaper).where(CollectionPaper.collection_id.in_(demo_collections))
    )
    await db.execute(
        delete(CollectionMember).where(CollectionMember.collection_id.in_(demo_collections))
    )
    result = await db.execute(
        delete(Collection).where(
            Collection.owner_id == user.id, Collection.description == SEED_MARKER
        )
    )
    counts["collections"] = result.rowcount or 0

    named = (*LEGACY_KEYS, *REPAIRED_KEYS, S2_DEMO_KEY)

    def demo(column):
        return or_(column.like(f"{DEMO_PREFIX}%"), column.in_(named))

    pins = await db.execute(
        select(UserLibraryVersion.paper_group_key).where(
            UserLibraryVersion.user_id == user.id, demo(UserLibraryVersion.paper_canonical_key)
        )
    )
    groups = {row[0] for row in pins.all()}
    result = await db.execute(
        delete(UserLibraryVersion).where(
            UserLibraryVersion.user_id == user.id, demo(UserLibraryVersion.paper_canonical_key)
        )
    )
    counts["library_versions"] = result.rowcount or 0
    still_pinned = select(UserLibraryVersion.paper_group_key).where(
        UserLibraryVersion.user_id == user.id
    )
    emptied = {
        row[0]
        for row in (
            await db.execute(
                select(UserLibraryEntry.paper_group_key).where(
                    UserLibraryEntry.user_id == user.id,
                    UserLibraryEntry.paper_group_key.in_(groups),
                    UserLibraryEntry.paper_group_key.not_in(still_pinned),
                )
            )
        ).all()
    }
    result = await db.execute(
        delete(UserLibraryEntry).where(
            UserLibraryEntry.user_id == user.id, UserLibraryEntry.paper_group_key.in_(emptied)
        )
    )
    counts["library_entries"] = result.rowcount or 0
    result = await db.execute(
        delete(UserPaperState).where(
            UserPaperState.user_id == user.id, demo(UserPaperState.paper_canonical_key)
        )
    )
    counts["states"] = result.rowcount or 0
    result = await db.execute(
        delete(UserPaperTag).where(
            UserPaperTag.user_id == user.id,
            or_(demo(UserPaperTag.paper_canonical_key), UserPaperTag.paper_group_key.in_(emptied)),
        )
    )
    counts["tags"] = result.rowcount or 0
    result = await db.execute(
        delete(Note).where(
            Note.user_id == user.id,
            Note.target_type == "paper",
            or_(demo(Note.target_key), Note.paper_group_key.in_(emptied)),
        )
    )
    counts["notes"] = result.rowcount or 0
    return counts


async def _alembic_revision(db: AsyncSession) -> str | None:
    try:
        async with db.begin_nested():
            return (await db.execute(text("SELECT version_num FROM alembic_version"))).scalar()
    except Exception:
        return None


def _print_counts(label: str, counts: Counter[str]) -> None:
    summary = ", ".join(f"{name}={count}" for name, count in sorted(counts.items()) if count)
    print(f"{label}: {summary or 'nothing new'}")


async def run(args: argparse.Namespace) -> int:
    async with async_session_factory() as db:
        user = await _find_user(db, args.email)
        if user is None:
            print(
                f"No user with email {args.email!r}; register and verify it first.", file=sys.stderr
            )
            return 1
        if args.legacy_raw_doi:
            revision = await _alembic_revision(db)
            if revision != "c7d8e9f0a1b2":
                print(
                    f"Warning: the database is at {revision!r}, not c7d8e9f0a1b2; the repair "
                    "migration will not run again unless you downgrade first "
                    "(or run python -m scripts.repair_paper_keys --apply).",
                    file=sys.stderr,
                )
        try:
            if args.reset:
                _print_counts("Removed", await reset_demo_data(db, user))
            if args.papers or args.collections:
                _print_counts("Papers", await seed_papers(db, user, args.papers, args.collections))
            if args.long_data:
                _print_counts("Long data", await seed_long_data(db, user))
            if args.legacy_raw_doi:
                _print_counts("Legacy raw-DOI shapes", await seed_legacy_raw_doi(db, user))
            if args.share_with:
                counts, url = await seed_sharing(db, user, args.share_with)
                if url is None:
                    await db.rollback()
                    print(
                        f"No other verified user with email {args.share_with!r}.", file=sys.stderr
                    )
                    return 1
                _print_counts("Sharing", counts)
                print(f"Read link: {url}")
            await db.commit()
        except Exception:
            await db.rollback()
            raise
    return 0


def main(argv: list[str] | None = None) -> int:
    if settings.environment == "production":
        print("Refusing to seed demo data in production.", file=sys.stderr)
        return 2
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--email", required=True, help="Existing account to seed")
    parser.add_argument("--papers", type=int, default=0, metavar="N")
    parser.add_argument("--collections", type=int, default=0, metavar="N")
    parser.add_argument("--long-data", action="store_true")
    parser.add_argument("--legacy-raw-doi", action="store_true")
    parser.add_argument("--share-with", metavar="EMAIL", help="Existing account to add as editor")
    parser.add_argument("--reset", action="store_true")
    args = parser.parse_args(argv)
    if args.papers < 0 or args.collections < 0:
        parser.error("--papers and --collections must not be negative")
    if not (
        args.papers
        or args.collections
        or args.long_data
        or args.legacy_raw_doi
        or args.share_with
        or args.reset
    ):
        parser.error(
            "nothing to do: pass --papers, --long-data, --legacy-raw-doi, --share-with or --reset"
        )
    return asyncio.run(run(args))


if __name__ == "__main__":
    sys.exit(main())
