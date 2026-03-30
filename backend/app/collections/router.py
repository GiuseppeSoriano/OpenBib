"""Collection router — CRUD, papers, members."""

import uuid

from fastapi import APIRouter, Query

from app.collections import service
from app.collections.schemas import (
    CollectionCreate,
    CollectionPaperRead,
    CollectionRead,
    CollectionUpdate,
    MemberAdd,
    PaperAdd,
)
from app.dependencies import DB, CurrentUser, OptionalUser

router = APIRouter(prefix="/collections", tags=["collections"])


@router.get("/", response_model=list[CollectionRead])
async def list_collections(user: CurrentUser, db: DB):
    rows = await service.list_collections(db, user.id)
    return rows


@router.post("/", response_model=CollectionRead, status_code=201)
async def create_collection(body: CollectionCreate, user: CurrentUser, db: DB):
    coll = await service.create_collection(db, user.id, body)
    return {**coll.__dict__, "paper_count": 0}


@router.get("/public", response_model=list[CollectionRead])
async def list_public_collections(
    db: DB,
    user: OptionalUser,
    page: int = Query(1, ge=1),
    size: int = Query(25, ge=1, le=100),
):
    from sqlalchemy import func, select
    from app.collections.models import Collection, CollectionPaper

    stmt = (
        select(
            Collection,
            func.count(CollectionPaper.paper_canonical_key).label("paper_count"),
        )
        .outerjoin(CollectionPaper, CollectionPaper.collection_id == Collection.id)
        .where(Collection.visibility == "public")
        .group_by(Collection.id)
        .order_by(Collection.updated_at.desc())
        .offset((page - 1) * size)
        .limit(size)
    )
    result = await db.execute(stmt)
    rows = result.all()
    return [
        {**row.Collection.__dict__, "paper_count": row.paper_count}
        for row in rows
    ]


@router.get("/{collection_id}", response_model=CollectionRead)
async def get_collection(collection_id: uuid.UUID, user: OptionalUser, db: DB):
    user_id = user.id if user else None
    return await service.get_collection_detail(db, collection_id, user_id)


@router.patch("/{collection_id}", response_model=CollectionRead)
async def update_collection(collection_id: uuid.UUID, body: CollectionUpdate, user: CurrentUser, db: DB):
    coll = await service.update_collection(db, collection_id, user.id, body)
    return {**coll.__dict__, "paper_count": 0}


@router.delete("/{collection_id}", status_code=204)
async def delete_collection(collection_id: uuid.UUID, user: CurrentUser, db: DB):
    await service.delete_collection(db, collection_id, user.id)


# --- Papers in collection ---

@router.get("/{collection_id}/papers", response_model=list[CollectionPaperRead])
async def list_collection_papers(collection_id: uuid.UUID, user: OptionalUser, db: DB):
    user_id = user.id if user else None
    return await service.list_papers(db, collection_id, user_id)


@router.post("/{collection_id}/papers", response_model=CollectionPaperRead, status_code=201)
async def add_paper(collection_id: uuid.UUID, body: PaperAdd, user: CurrentUser, db: DB):
    return await service.add_paper(db, collection_id, user.id, body.paper_canonical_key)


@router.delete("/{collection_id}/papers/{paper_key:path}", status_code=204)
async def remove_paper(collection_id: uuid.UUID, paper_key: str, user: CurrentUser, db: DB):
    await service.remove_paper(db, collection_id, user.id, paper_key)


# --- Members ---

@router.post("/{collection_id}/members", status_code=201)
async def add_member(collection_id: uuid.UUID, body: MemberAdd, user: CurrentUser, db: DB):
    await service.add_member(db, collection_id, user.id, body.user_id, body.role.value)
    return {"status": "ok"}


@router.delete("/{collection_id}/members/{member_id}", status_code=204)
async def remove_member(collection_id: uuid.UUID, member_id: uuid.UUID, user: CurrentUser, db: DB):
    await service.remove_member(db, collection_id, user.id, member_id)
