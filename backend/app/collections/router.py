"""Collection router — CRUD, papers, members."""

import uuid

from fastapi import APIRouter, HTTPException, Request, Response

from app.collections import service
from app.collections.access import ShareToken, authorize
from app.collections.schemas import (
    CollectionCreate,
    CollectionPaperRead,
    CollectionRead,
    CollectionUpdate,
    IdentifierImport,
    KeyImport,
    MemberAdd,
    MemberRead,
    PaperAdd,
    ReadLinkRead,
)
from app.collections.sharing import read_link
from app.common.rate_limit import enforce_rate_limit
from app.dependencies import DB, CurrentUser, OptionalUser, Redis

router = APIRouter(prefix="/collections", tags=["collections"])


@router.get("", response_model=list[CollectionRead])
async def list_collections(user: CurrentUser, db: DB):
    rows = await service.list_collections(db, user.id)
    return rows


@router.get("/paper-memberships")
async def paper_memberships(user: CurrentUser, db: DB):
    return await service.get_paper_memberships(db, user.id)


@router.post("", response_model=CollectionRead, status_code=201)
async def create_collection(body: CollectionCreate, user: CurrentUser, db: DB):
    coll = await service.create_collection(db, user.id, body)
    return {
        **coll.__dict__,
        "paper_count": 0,
        "is_owner": coll.owner_id == user.id,
        "can_edit": True,
        "can_manage_access": coll.owner_id == user.id,
    }


@router.get("/public", deprecated=True)
async def list_public_collections():
    raise HTTPException(
        status_code=410, detail="Public collections have been replaced by read links"
    )


@router.get("/{collection_id}", response_model=CollectionRead)
async def get_collection(
    collection_id: uuid.UUID, user: OptionalUser, db: DB, share_token: ShareToken = None
):
    user_id = user.id if user else None
    return await service.get_collection_detail(db, collection_id, user_id, share_token)


@router.patch("/{collection_id}", response_model=CollectionRead)
async def update_collection(
    collection_id: uuid.UUID, body: CollectionUpdate, user: CurrentUser, db: DB
):
    await service.update_collection(db, collection_id, user.id, body)
    return await service.get_collection_detail(db, collection_id, user.id)


@router.delete("/{collection_id}", status_code=204)
async def delete_collection(collection_id: uuid.UUID, user: CurrentUser, db: DB):
    await service.delete_collection(db, collection_id, user.id)


# --- Papers in collection ---


@router.get("/{collection_id}/papers", response_model=list[CollectionPaperRead])
async def list_collection_papers(
    collection_id: uuid.UUID, user: OptionalUser, db: DB, share_token: ShareToken = None
):
    user_id = user.id if user else None
    return await service.list_papers(db, collection_id, user_id, share_token)


@router.post("/{collection_id}/papers", response_model=CollectionPaperRead, status_code=201)
async def add_paper(collection_id: uuid.UUID, body: PaperAdd, user: CurrentUser, db: DB):
    return await service.add_paper(db, collection_id, user.id, body.paper_canonical_key)


@router.delete("/{collection_id}/papers/{paper_key:path}", status_code=204)
async def remove_paper(collection_id: uuid.UUID, paper_key: str, user: CurrentUser, db: DB):
    await service.remove_paper(db, collection_id, user.id, paper_key)


# --- Members ---


@router.get("/{collection_id}/members", response_model=list[MemberRead])
async def list_members(collection_id: uuid.UUID, user: CurrentUser, db: DB):
    return await service.list_members(db, collection_id, user.id)


@router.post("/{collection_id}/members", status_code=200)
async def add_member(
    collection_id: uuid.UUID,
    body: MemberAdd,
    user: CurrentUser,
    db: DB,
    redis: Redis,
    request: Request,
    response: Response,
):
    await authorize(db, collection_id, user.id, permission="manage")
    await enforce_rate_limit(
        redis,
        request,
        response,
        scope="collection-members",
        identity=f"user:{user.id}",
        limit=20,
        window_seconds=3600,
        fail_closed=True,
    )
    await service.add_member(db, collection_id, user.id, str(body.email))
    return {"status": "ok"}


@router.delete("/{collection_id}/members/{member_id}", status_code=204)
async def remove_member(collection_id: uuid.UUID, member_id: uuid.UUID, user: CurrentUser, db: DB):
    await service.remove_member(db, collection_id, user.id, member_id)


# --- Import (export is handled by the Zotero sync in app/zotero) ---


@router.post("/{collection_id}/import/dois")
async def import_dois(collection_id: uuid.UUID, body: IdentifierImport, user: CurrentUser, db: DB):
    from app.collections.import_export import import_doi_list

    result = await import_doi_list(db, collection_id, user.id, body.dois)
    return result


@router.post("/{collection_id}/import/keys")
async def import_keys(collection_id: uuid.UUID, body: KeyImport, user: CurrentUser, db: DB):
    from app.collections.import_export import import_canonical_keys

    result = await import_canonical_keys(db, collection_id, user.id, body.keys)
    return result


@router.get("/{collection_id}/read-link", response_model=ReadLinkRead)
async def get_read_link(collection_id: uuid.UUID, user: CurrentUser, db: DB):
    return await read_link(db, collection_id, user.id)


@router.put("/{collection_id}/read-link", response_model=ReadLinkRead)
async def enable_read_link(collection_id: uuid.UUID, user: CurrentUser, db: DB):
    return await read_link(db, collection_id, user.id, "enable")


@router.post("/{collection_id}/read-link/rotate", response_model=ReadLinkRead)
async def rotate_read_link(collection_id: uuid.UUID, user: CurrentUser, db: DB):
    return await read_link(db, collection_id, user.id, "rotate")


@router.delete("/{collection_id}/read-link", status_code=204)
async def disable_read_link(collection_id: uuid.UUID, user: CurrentUser, db: DB):
    await read_link(db, collection_id, user.id, "disable")
