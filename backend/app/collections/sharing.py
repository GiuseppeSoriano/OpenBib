"""Revocable read links; plaintext is only recovered for the owner."""

import hashlib
import secrets
import uuid

from sqlalchemy.ext.asyncio import AsyncSession

from app.collections.access import authorize
from app.common.crypto import EncryptedValue, keyring
from app.config import settings


async def read_link(
    db: AsyncSession, collection_id: uuid.UUID, user_id: uuid.UUID, action: str = "get"
) -> dict:
    coll, _ = await authorize(db, collection_id, user_id, permission="manage")
    aad = f"collection:{collection_id}"
    if action == "disable":
        coll.read_link_digest = None
        coll.read_link_ciphertext = None
        coll.read_link_nonce = None
        coll.read_link_key_version = None
    elif action == "rotate" or (action == "enable" and not coll.read_link_digest):
        token = secrets.token_urlsafe(32)
        encrypted = keyring.encrypt(token, purpose="collection-read-link", aad=aad)
        coll.read_link_digest = hashlib.sha256(token.encode()).hexdigest()
        coll.read_link_ciphertext = encrypted.ciphertext
        coll.read_link_nonce = encrypted.nonce
        coll.read_link_key_version = encrypted.key_version
    await db.flush()
    if not coll.read_link_digest:
        return {"enabled": False, "url": None}
    token = keyring.decrypt(
        EncryptedValue(coll.read_link_ciphertext, coll.read_link_nonce, coll.read_link_key_version),
        purpose="collection-read-link",
        aad=aad,
    )
    return {
        "enabled": True,
        "url": f"{settings.app_public_url.rstrip('/')}/collections/{collection_id}#share={token}",
    }
