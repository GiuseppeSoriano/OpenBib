"""Encrypted transactional email outbox and localized lifecycle messages."""

import json
import uuid

from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.models import EmailOutbox
from app.common.crypto import keyring
from app.config import settings


async def queue_email(
    db: AsyncSession, user_id: uuid.UUID, recipient: str, subject: str, body: str
) -> None:
    row = EmailOutbox(id=uuid.uuid4(), user_id=user_id)
    payload = json.dumps(
        {"recipient": recipient, "subject": subject, "body": body}, ensure_ascii=False
    )
    encrypted = keyring.encrypt(payload, purpose="email", aad=f"email:{row.user_id}:{row.id}")
    row.payload_ciphertext = encrypted.ciphertext
    row.payload_nonce = encrypted.nonce
    row.key_version = encrypted.key_version
    db.add(row)
    await db.flush()


def lifecycle_email(kind: str, locale: str, token: str) -> tuple[str, str]:
    routes = {
        "verify_email": "verify-email",
        "reset_password": "reset-password",
        "change_email": "confirm-email",
    }
    url = f"{settings.app_public_url.rstrip('/')}/{routes[kind]}#token={token}"
    text = {
        "en": {
            "verify_email": (
                "Verify your OpenBib email",
                f"Open this link to verify your email address. It expires in 24 hours:\n\n{url}",
            ),
            "reset_password": (
                "Reset your OpenBib password",
                f"Open this link to choose a new password. It expires in one hour:\n\n{url}",
            ),
            "change_email": (
                "Confirm your new OpenBib email",
                f"Open this link to confirm your new email address. It expires in 24 hours:\n\n{url}",
            ),
        },
        "it": {
            "verify_email": (
                "Verifica la tua email OpenBib",
                f"Apri questo link per verificare l’indirizzo email. Scade tra 24 ore:\n\n{url}",
            ),
            "reset_password": (
                "Reimposta la password OpenBib",
                f"Apri questo link per scegliere una nuova password. Scade tra un’ora:\n\n{url}",
            ),
            "change_email": (
                "Conferma la nuova email OpenBib",
                f"Apri questo link per confermare il nuovo indirizzo email. Scade tra 24 ore:\n\n{url}",
            ),
        },
    }
    return text[locale][kind]
