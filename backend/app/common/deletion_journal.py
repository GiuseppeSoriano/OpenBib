"""Durable encrypted deletion receipts, kept independently from database snapshots."""

import asyncio
import base64
import json
import uuid
from datetime import timedelta

import boto3
from botocore.config import Config

from app.auth.service import utcnow
from app.common.crypto import EncryptedValue, keyring
from app.config import settings

PREFIX = "openbib-deletions/v1/"


def client():
    return boto3.client(
        "s3",
        endpoint_url=settings.s3_endpoint_url or None,
        region_name=settings.aws_region,
        aws_access_key_id=settings.aws_access_key_id,
        aws_secret_access_key=settings.aws_secret_access_key,
        config=Config(connect_timeout=5, read_timeout=10, retries={"max_attempts": 2}),
    )


async def record_deletion(user_id: uuid.UUID) -> None:
    if settings.environment != "production":
        return
    encrypted = keyring.encrypt(
        json.dumps(
            {
                "user_id": str(user_id),
                "requested_at": utcnow().isoformat(),
                "expires_at": (utcnow() + timedelta(days=30)).isoformat(),
            }
        ),
        purpose="deletion",
        aad=str(user_id),
    )
    body = json.dumps(
        {
            "version": encrypted.key_version,
            "nonce": base64.b64encode(encrypted.nonce).decode(),
            "ciphertext": base64.b64encode(encrypted.ciphertext).decode(),
        }
    ).encode()
    await asyncio.to_thread(
        client().put_object,
        Bucket=settings.deletion_journal_bucket,
        Key=f"{PREFIX}{user_id}.json",
        Body=body,
        ContentType="application/json",
    )


def read_receipts() -> list[dict]:
    s3 = client()
    receipts = []
    for page in s3.get_paginator("list_objects_v2").paginate(
        Bucket=settings.deletion_journal_bucket, Prefix=PREFIX
    ):
        for item in page.get("Contents", []):
            user_id = uuid.UUID(item["Key"].removeprefix(PREFIX).removesuffix(".json"))
            raw = s3.get_object(Bucket=settings.deletion_journal_bucket, Key=item["Key"])[
                "Body"
            ].read(16384)
            data = json.loads(raw)
            value = EncryptedValue(
                base64.b64decode(data["ciphertext"]),
                base64.b64decode(data["nonce"]),
                data["version"],
            )
            receipts.append(
                json.loads(keyring.decrypt(value, purpose="deletion", aad=str(user_id)))
            )
    return receipts
