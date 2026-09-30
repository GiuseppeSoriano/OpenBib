"""Sharing capability boundaries, account collaboration and PostgreSQL races."""

import asyncio
import hashlib
from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from httpx import ASGITransport, AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker

from app.auth.service import create_access_token, create_session
from app.collections import service
from app.collections.models import CollectionMember
from app.collections.schemas import CollectionCreate, CollectionUpdate
from app.collections.sharing import read_link
from app.library.models import UserLibraryVersion
from app.users.models import User
from tests.test_auth import user_for_test


async def setup(db):
    owner, editor, viewer, stranger = [await user_for_test(db) for _ in range(4)]
    coll = await service.create_collection(db, owner.id, CollectionCreate(name="Research"))
    await service.add_member(db, coll.id, owner.id, editor.email)
    db.add(CollectionMember(collection_id=coll.id, user_id=viewer.id, role="viewer"))
    token = (await read_link(db, coll.id, owner.id, "enable"))["url"].split("#share=")[1]
    auth = {}
    for role, user in zip(
        ("owner", "editor", "viewer", "stranger"), (owner, editor, viewer, stranger), strict=True
    ):
        session, _ = await create_session(db, user.id)
        auth[role] = {"Authorization": f"Bearer {create_access_token(user.id, session.id)}"}
    auth["anonymous"] = {}
    await db.commit()

    def snapshot(row):
        return SimpleNamespace(**{c.name: getattr(row, c.name) for c in row.__table__.columns})

    return (
        snapshot(coll),
        tuple(snapshot(u) for u in (owner, editor, viewer, stranger)),
        token,
        auth,
    )


@pytest.mark.parametrize("role", ["owner", "editor", "viewer", "stranger", "anonymous"])
@pytest.mark.parametrize("has_link", [False, True])
async def test_permission_matrix(db, client_app, role, has_link):
    coll, users, token, auth = await setup(db)
    headers = {**auth[role], **({"X-Collection-Share-Token": token} if has_link else {})}
    base = f"/api/v1/collections/{coll.id}"
    async with AsyncClient(
        transport=ASGITransport(app=client_app), base_url="http://testserver", headers=headers
    ) as c:
        can_read = role in ("owner", "editor", "viewer") or has_link
        for path in (base, base + "/papers", f"/api/v1/graph/collection/{coll.id}"):
            result = await c.get(path)
            assert result.status_code == (200 if can_read else 404)
            assert result.headers["cache-control"] == "no-store"
        result = await c.post(base + "/papers", json={"paper_canonical_key": "doi:10.1/shared"})
        assert result.status_code == (
            201 if role in ("owner", "editor") else 401 if role == "anonymous" else 403
        )
        result = await c.patch(base, json={"name": "Changed", "revision": 1})
        assert result.status_code == (
            200 if role in ("owner", "editor") else 401 if role == "anonymous" else 403
        )
        for path in ("members", "read-link"):
            assert (await c.get(base + "/" + path)).status_code == (
                200 if role == "owner" else 401 if role == "anonymous" else 403
            )
        for path, body in (
            ("import/dois", {"dois": ["10.2/import"]}),
            ("import/keys", {"keys": ["doi:10.2/import2"]}),
        ):
            assert (await c.post(base + "/" + path, json=body)).status_code == (
                200 if role in ("owner", "editor") else 401 if role == "anonymous" else 403
            )
        # Sharing mutations and collection deletion remain owner-only, even with a link.
        if role != "owner":
            for method, path, body in (
                ("put", "/read-link", None),
                ("post", "/read-link/rotate", None),
                ("delete", "/read-link", None),
                ("post", "/members", {"email": users[3].email}),
                ("delete", "/members/" + str(users[1].id), None),
                ("delete", "", None),
            ):
                result = await c.request(method, base + path, json=body)
                assert result.status_code == (401 if role == "anonymous" else 403)


async def test_link_lifecycle_revocation_and_no_secret_export(db, client_app, caplog):
    from app.users.service import export_user_data

    coll, users, token, auth = await setup(db)
    base = f"/api/v1/collections/{coll.id}"
    assert coll.read_link_digest == hashlib.sha256(token.encode()).hexdigest()
    assert token.encode() not in coll.read_link_ciphertext
    export = await export_user_data(db, users[0])
    assert not any(key.startswith("read_link_") for key in export["collections_owned"][0])
    async with AsyncClient(
        transport=ASGITransport(app=client_app), base_url="http://testserver"
    ) as c:
        original = (await c.get(base + "/read-link", headers=auth["owner"])).json()
        assert (await c.put(base + "/read-link", headers=auth["owner"])).json() == original
        new = (
            (await c.post(base + "/read-link/rotate", headers=auth["owner"]))
            .json()["url"]
            .split("#share=")[1]
        )
        assert new != token
        for path in (base, base + "/papers", f"/api/v1/graph/collection/{coll.id}"):
            assert (
                await c.get(path, headers={"X-Collection-Share-Token": token})
            ).status_code == 404
        assert (await c.get(base, headers={"X-Collection-Share-Token": new})).status_code == 200
        assert (await c.delete(base + "/read-link", headers=auth["owner"])).status_code == 204
        assert (await c.get(base, headers={"X-Collection-Share-Token": new})).status_code == 404
        assert (await c.get(base, headers=auth["editor"])).status_code == 200
        other = await service.create_collection(db, users[0].id, CollectionCreate(name="Other"))
        assert (
            await c.get(
                f"/api/v1/collections/{other.id}", headers={"X-Collection-Share-Token": token}
            )
        ).status_code == 404
    assert token not in caplog.text and new not in caplog.text


async def test_members_contract_lists_imports_and_revision(db, client_app):
    coll, users, token, auth = await setup(db)
    owner, editor, viewer, stranger = users
    base = f"/api/v1/collections/{coll.id}"
    async with AsyncClient(
        transport=ASGITransport(app=client_app), base_url="http://testserver", headers=auth["owner"]
    ) as c:
        for _ in range(2):
            assert (
                await c.post(base + "/members", json={"email": f" {editor.email.upper()} "})
            ).status_code == 200
        assert (
            await c.post(base + "/members", json={"user_id": str(stranger.id), "role": "owner"})
        ).status_code == 422
        assert (await c.delete(base + f"/members/{owner.id}")).status_code == 403
        missing = await c.post(base + "/members", json={"email": "missing@example.com"})
        actual_stranger = await db.get(User, stranger.id)
        actual_stranger.email_verified_at = None
        await db.commit()
        unverified = await c.post(base + "/members", json={"email": stranger.email})
        assert (
            missing.status_code == unverified.status_code == 400
            and missing.json() == unverified.json()
        )
        members = (await c.get(base + "/members")).json()
        assert len(members) == 2
        assert (await c.post(base + "/members", json={"email": viewer.email})).status_code == 200
        actual_editor = await db.get(User, editor.id)
        actual_editor.email = "changed@example.com"
        await db.commit()
        assert (await c.get(base, headers=auth["editor"])).json()["can_edit"]
        assert (
            await c.patch(base, json={"revision": 1, "name": "New", "description": None})
        ).status_code == 200
        assert (await c.patch(base, json={"revision": 1, "name": "Stale"})).status_code == 409
        assert (
            await c.patch(base, json={"revision": 2, "visibility": "public"})
        ).status_code == 422
        assert (
            await c.post("/api/v1/collections", json={"name": "Legacy", "visibility": "public"})
        ).status_code == 422
        assert (await c.get("/api/v1/collections/public")).status_code == 410
        result = await c.post(
            base + "/import/keys",
            headers=auth["editor"],
            json={"keys": ["doi:10.1/one", "doi:10.1/one"]},
        )
        # Uncached DOIs are stored as pending while the provider is unavailable.
        counts = result.json()
        assert counts["duplicate"] == counts["unresolved"] == counts["skipped"] == 1
        assert counts["total"] == 2
        assert (
            await c.post(base + "/papers", json={"paper_canonical_key": "doi:10.1/one"})
        ).status_code == 409
        versions = (await db.execute(select(UserLibraryVersion))).scalars().all()
        assert len(versions) == 1 and versions[0].user_id == editor.id
        assert len((await c.get("/api/v1/collections", headers=auth["editor"])).json()) == 1
        assert (await service.get_user_stats(db, editor.id))["total_collections"] == 1
        assert (await service.get_paper_memberships(db, editor.id))["doi:10.1/one"] == [
            str(coll.id)
        ]
        assert (await c.delete(base + f"/members/{editor.id}")).status_code == 204
        assert (await c.get("/api/v1/collections", headers=auth["editor"])).json() == []
        assert (
            await c.post(
                base + "/papers",
                headers={**auth["editor"], "X-Collection-Share-Token": token},
                json={"paper_canonical_key": "doi:10.1/two"},
            )
        ).status_code == 403


async def test_member_limits_fail_closed(db, client_app, monkeypatch):
    from redis.exceptions import ConnectionError

    coll, users, _, auth = await setup(db)
    async with AsyncClient(
        transport=ASGITransport(app=client_app), base_url="http://testserver", headers=auth["owner"]
    ) as c:
        for _ in range(20):
            assert (
                await c.post(
                    f"/api/v1/collections/{coll.id}/members", json={"email": users[1].email}
                )
            ).status_code == 200
        assert (
            await c.post(f"/api/v1/collections/{coll.id}/members", json={"email": users[1].email})
        ).status_code == 429

        async def unavailable(*args, **kwargs):
            raise ConnectionError("offline")

        monkeypatch.setattr(client_app.state.redis, "eval", unavailable)
        assert (
            await c.post(f"/api/v1/collections/{coll.id}/members", json={"email": users[1].email})
        ).status_code == 503


@pytest.mark.parametrize("operation", ["metadata", "paper", "revoke"])
async def test_concurrent_writes_and_revocation(db, engine, operation):
    if engine.dialect.name != "postgresql":
        pytest.skip("Requires PostgreSQL row locks")
    coll, users, _, _ = await setup(db)
    owner, editor, *_ = users
    factory = async_sessionmaker(engine, expire_on_commit=False)
    ready = asyncio.Event()

    async def first():
        async with factory() as tx:
            if operation == "revoke":
                await service.remove_member(tx, coll.id, owner.id, editor.id)
            elif operation == "metadata":
                await service.update_collection(
                    tx, coll.id, owner.id, CollectionUpdate(name="First", revision=1)
                )
            else:
                await service.add_paper(tx, coll.id, owner.id, "doi:10.1/race")
            ready.set()
            await asyncio.sleep(0.1)
            await tx.commit()

    async def second():
        await ready.wait()
        async with factory() as tx:
            try:
                if operation == "metadata":
                    await service.update_collection(
                        tx, coll.id, editor.id, CollectionUpdate(name="Second", revision=1)
                    )
                else:
                    await service.add_paper(tx, coll.id, editor.id, "doi:10.1/race")
                await tx.commit()
                return 200
            except HTTPException as exc:
                await tx.rollback()
                return exc.status_code

    _, result = await asyncio.wait_for(asyncio.gather(first(), second()), timeout=10)
    assert result == (403 if operation == "revoke" else 409)


async def test_zotero_read_capability_is_personal_and_revocable(db, client_app, monkeypatch):
    from app.zotero import service as zotero_service

    coll, users, token, _auth = await setup(db)
    seen = []

    async def sync_papers(_db, user_id, **kwargs):
        seen.append((user_id, kwargs))
        return {
            "items_created": 0,
            "items_updated": 0,
            "skipped": 0,
            "failures": [],
            "collection_key": "qa",
            "zotero_collection_key": "qa",
        }

    monkeypatch.setattr(zotero_service, "sync_papers", sync_papers)
    # Test the authorization/service boundary without calling an external Zotero account.
    await zotero_service.sync_collection(db, users[3].id, coll.id, token)
    assert seen[0][0] == users[3].id
    assert seen[0][1]["local_collection_key"] == str(coll.id)
    await read_link(db, coll.id, users[0].id, "disable")
    with pytest.raises(HTTPException) as error:
        await zotero_service.sync_collection(db, users[3].id, coll.id, token)
    assert error.value.status_code == 404
    async with AsyncClient(
        transport=ASGITransport(app=client_app), base_url="http://testserver"
    ) as c:
        response = await c.post(
            f"/api/v1/zotero/sync/collection/{coll.id}", headers={"X-Collection-Share-Token": token}
        )
        assert response.status_code == 401
    assert len(seen) == 1
