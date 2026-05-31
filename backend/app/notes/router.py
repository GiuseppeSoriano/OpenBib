"""Notes router."""

import uuid

from fastapi import APIRouter, Query

from app.common.exceptions import ForbiddenError, NotFoundError
from app.dependencies import DB, CurrentUser
from app.notes.models import Note
from app.notes.schemas import NoteCreate, NoteRead, NoteUpdate
from app.papers.service import get_cached_paper
from sqlalchemy import select, or_

router = APIRouter(prefix="/notes", tags=["notes"])


@router.post("", response_model=NoteRead, status_code=201)
async def create_note(body: NoteCreate, user: CurrentUser, db: DB):
    paper_group_key: str | None = None
    if body.target_type.value == "paper":
        cached = await get_cached_paper(db, body.target_key)
        if cached is not None:
            paper_group_key = cached.paper_group_key
    note = Note(
        user_id=user.id,
        target_type=body.target_type.value,
        target_key=body.target_key,
        paper_group_key=paper_group_key,
        content=body.content,
    )
    db.add(note)
    await db.flush()
    return note


@router.get("", response_model=list[NoteRead])
async def list_notes(
    user: CurrentUser,
    db: DB,
    target_type: str | None = None,
    target_key: str | None = None,
    paper_group_key: str | None = None,
):
    stmt = select(Note).where(Note.user_id == user.id)
    if target_type:
        stmt = stmt.where(Note.target_type == target_type)
    if paper_group_key:
        # Group-anchored lookup: surface every paper note for this logical
        # paper, regardless of the original target_key version.
        stmt = stmt.where(Note.target_type == "paper").where(
            Note.paper_group_key == paper_group_key
        )
    elif target_key:
        # Backwards-compatible per-version lookup: also include any notes
        # already migrated to the same group_key as the requested key, so
        # callers querying by canonical_key see all sibling-version notes.
        cached = await get_cached_paper(db, target_key)
        group_key = cached.paper_group_key if cached else None
        if group_key:
            stmt = stmt.where(
                or_(
                    Note.target_key == target_key,
                    Note.paper_group_key == group_key,
                )
            )
        else:
            stmt = stmt.where(Note.target_key == target_key)
    stmt = stmt.order_by(Note.updated_at.desc())
    result = await db.execute(stmt)
    return list(result.scalars().all())


@router.patch("/{note_id}", response_model=NoteRead)
async def update_note(note_id: uuid.UUID, body: NoteUpdate, user: CurrentUser, db: DB):
    note = await db.get(Note, note_id)
    if note is None:
        raise NotFoundError("Note not found")
    if note.user_id != user.id:
        raise ForbiddenError()
    note.content = body.content
    db.add(note)
    await db.flush()
    return note


@router.delete("/{note_id}", status_code=204)
async def delete_note(note_id: uuid.UUID, user: CurrentUser, db: DB):
    note = await db.get(Note, note_id)
    if note is None:
        raise NotFoundError("Note not found")
    if note.user_id != user.id:
        raise ForbiddenError()
    await db.delete(note)
