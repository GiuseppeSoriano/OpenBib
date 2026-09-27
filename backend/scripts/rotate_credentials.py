"""Re-encrypt Zotero credentials and collection links with the active application key."""

from __future__ import annotations

import asyncio

from sqlalchemy import select

from app.collections.models import Collection
from app.common.crypto import EncryptedValue, keyring
from app.database import async_session_factory
from app.zotero.models import ZoteroCredentials


async def rotate() -> int:
    updated = 0
    while True:
        async with async_session_factory() as db:
            rows = (
                await db.execute(
                    select(ZoteroCredentials)
                    .where(ZoteroCredentials.api_key_version != keyring.active_version)
                    .order_by(ZoteroCredentials.user_id)
                    .limit(100)
                    .with_for_update(skip_locked=True)
                )
            ).scalars()
            rows = list(rows)
            if not rows:
                break
            for row in rows:
                if row.api_key_version == keyring.active_version:
                    continue
                aad = f"zotero:{row.user_id}"
                plaintext = keyring.decrypt(
                    EncryptedValue(row.api_key_ciphertext, row.api_key_nonce, row.api_key_version),
                    purpose="zotero",
                    aad=aad,
                )
                encrypted = keyring.encrypt(plaintext, purpose="zotero", aad=aad)
                row.api_key_ciphertext = encrypted.ciphertext
                row.api_key_nonce = encrypted.nonce
                row.api_key_version = encrypted.key_version
                updated += 1
            await db.commit()
    while True:
        async with async_session_factory() as db:
            rows = list(
                (
                    await db.execute(
                        select(Collection)
                        .where(Collection.read_link_key_version != keyring.active_version)
                        .order_by(Collection.id)
                        .limit(100)
                        .with_for_update(skip_locked=True)
                    )
                ).scalars()
            )
            if not rows:
                break
            for row in rows:
                aad = f"collection:{row.id}"
                plaintext = keyring.decrypt(
                    EncryptedValue(
                        row.read_link_ciphertext, row.read_link_nonce, row.read_link_key_version
                    ),
                    purpose="collection-read-link",
                    aad=aad,
                )
                encrypted = keyring.encrypt(plaintext, purpose="collection-read-link", aad=aad)
                row.read_link_ciphertext = encrypted.ciphertext
                row.read_link_nonce = encrypted.nonce
                row.read_link_key_version = encrypted.key_version
                updated += 1
            await db.commit()
    return updated


if __name__ == "__main__":
    print(f"Rotated {asyncio.run(rotate())} encrypted credential/link value(s)")
