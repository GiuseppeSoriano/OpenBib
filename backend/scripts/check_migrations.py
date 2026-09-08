"""Exercise clean and previous-head upgrades in a disposable PostgreSQL database."""

import asyncio
import base64
import json
import os
import subprocess
import sys
import tempfile
import uuid
from pathlib import Path
from urllib.parse import urlsplit

from sqlalchemy import text
from sqlalchemy.ext.asyncio import create_async_engine

PREVIOUS = "a1b2c3d4e5f6"
TARGET = os.environ["MIGRATION_TEST_DATABASE_URL"]
if not urlsplit(TARGET).path.endswith("_migration_test"):
    raise SystemExit("Refusing to modify a database not ending in _migration_test")


async def sql(statement, parameters=None):
    engine = create_async_engine(TARGET)
    try:
        async with engine.begin() as connection:
            result = await connection.execute(text(statement), parameters or {})
            return result.mappings().all() if result.returns_rows else []
    finally:
        await engine.dispose()


def migrate(revision, key_file, success=True):
    env = {
        **os.environ,
        "DATABASE_URL": TARGET,
        "ENVIRONMENT": "test",
        "APP_ENCRYPTION_KEYS_FILE": str(key_file) if key_file else "",
        "APP_ACTIVE_KEY_VERSION": "1",
        "DATABASE_URL_FILE": "",
    }
    result = subprocess.run(
        [sys.executable, "-m", "alembic", "upgrade", revision], env=env, capture_output=True
    )
    if (result.returncode == 0) != success:
        raise RuntimeError("Unexpected migration outcome; inspect the disposable database")


def reset():
    asyncio.run(sql("DROP SCHEMA public CASCADE"))
    asyncio.run(sql("CREATE SCHEMA public"))


def main():
    with tempfile.TemporaryDirectory(prefix="openbib-migration-") as directory:
        key_file = Path(directory) / "keys.json"
        key_file.write_text(json.dumps({"1": base64.b64encode(os.urandom(32)).decode()}))
        reset()
        migrate("head", key_file)
        reset()
        migrate(PREVIOUS, key_file)
        user_id = str(uuid.uuid4())
        asyncio.run(
            sql(
                "INSERT INTO users (id,email,password_hash,display_name) VALUES (:id,'migration@example.com','test-only','Migration')",
                {"id": user_id},
            )
        )
        asyncio.run(
            sql(
                "INSERT INTO zotero_credentials (user_id,api_key,zotero_user_id) VALUES (:id,'migration-fixture-key','123')",
                {"id": user_id},
            )
        )
        invalid_file = Path(directory) / "invalid.json"
        invalid_file.write_text('{"1":"too-short"}')
        migrate("head", invalid_file, success=False)
        assert (
            asyncio.run(sql("SELECT api_key FROM zotero_credentials"))[0]["api_key"]
            == "migration-fixture-key"
        )
        # This failure happens inside upgrade(), after DDL and backfills, not at Settings startup.
        migrate("head", None, success=False)
        assert (
            asyncio.run(sql("SELECT version_num FROM alembic_version"))[0]["version_num"]
            == PREVIOUS
        )
        assert not asyncio.run(
            sql(
                "SELECT column_name FROM information_schema.columns WHERE table_name='users' AND column_name='email_verified_at'"
            )
        )
        assert (
            asyncio.run(sql("SELECT api_key FROM zotero_credentials"))[0]["api_key"]
            == "migration-fixture-key"
        )
        migrate("head", key_file)
        from app.common.crypto import EncryptedValue, EncryptionKeyring

        ring = EncryptionKeyring(key_file.read_text(), 1)
        row = asyncio.run(
            sql("SELECT api_key_ciphertext,api_key_nonce,api_key_version FROM zotero_credentials")
        )[0]
        assert (
            ring.decrypt(
                EncryptedValue(
                    row["api_key_ciphertext"], row["api_key_nonce"], row["api_key_version"]
                ),
                purpose="zotero",
                aad=f"zotero:{user_id}",
            )
            == "migration-fixture-key"
        )
        assert not asyncio.run(
            sql(
                "SELECT column_name FROM information_schema.columns WHERE table_name='zotero_credentials' AND column_name='api_key'"
            )
        )
        print(
            "Clean upgrade, previous-head upgrade, encryption round-trip and failure atomicity passed"
        )


if __name__ == "__main__":
    main()
