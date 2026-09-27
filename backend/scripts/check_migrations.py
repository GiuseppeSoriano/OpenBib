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
        # Upgrade the actual pre-OTP head with existing account/action data.
        reset()
        migrate("d6e7f8a9b0c1", key_file)
        asyncio.run(
            sql(
                "INSERT INTO users (id,email,password_hash,display_name) VALUES (:id,'otp-migration@example.com','preserved-hash','Preserved')",
                {"id": user_id},
            )
        )
        for digit, purpose in enumerate(("verify_email", "reset_password", "change_email"), 1):
            asyncio.run(
                sql(
                    "INSERT INTO user_action_tokens (id,user_id,purpose,token_digest,expires_at) VALUES (:id,:uid,:purpose,:digest,CURRENT_TIMESTAMP + INTERVAL '1 day')",
                    {
                        "id": str(uuid.uuid4()),
                        "uid": user_id,
                        "purpose": purpose,
                        "digest": str(digit) * 64,
                    },
                )
            )
        migrate("head", key_file)
        assert (
            asyncio.run(sql("SELECT password_hash FROM users"))[0]["password_hash"]
            == "preserved-hash"
        )
        actions = asyncio.run(sql("SELECT purpose,used_at FROM user_action_tokens"))
        assert all((r["used_at"] is not None) == (r["purpose"] == "verify_email") for r in actions)
        assert asyncio.run(sql("SELECT count(*) AS n FROM registration_challenges"))[0]["n"] == 0
        # Preserve all collection identities/content and legacy roles; no links enabled.
        reset()
        migrate("e7f8a9b0c1d2", key_file)
        users = [str(uuid.uuid4()) for _ in range(4)]
        for index, uid in enumerate(users):
            asyncio.run(
                sql(
                    "INSERT INTO users (id,email,password_hash,display_name) VALUES (:id,:email,'hash','Fixture')",
                    {"id": uid, "email": f"sharing{index}@example.com"},
                )
            )
        collections = [str(uuid.uuid4()) for _ in range(3)]
        for cid, visibility in zip(collections, ("private", "shared", "public"), strict=True):
            asyncio.run(
                sql(
                    "INSERT INTO collections (id,owner_id,name,visibility) VALUES (:id,:owner,'Preserved',:visibility)",
                    {"id": cid, "owner": users[0], "visibility": visibility},
                )
            )
            asyncio.run(
                sql(
                    "INSERT INTO collection_papers (collection_id,paper_canonical_key,added_by) VALUES (:id,'doi:10.1/preserved',:owner)",
                    {"id": cid, "owner": users[0]},
                )
            )
            for uid, role in zip(users, ("owner", "editor", "viewer", "owner"), strict=True):
                asyncio.run(
                    sql(
                        "INSERT INTO collection_members (collection_id,user_id,role) VALUES (:cid,:uid,:role)",
                        {"cid": cid, "uid": uid, "role": role},
                    )
                )
        migrate("head", key_file)
        rows = asyncio.run(sql("SELECT id,owner_id,revision,read_link_digest FROM collections"))
        assert {str(r["id"]) for r in rows} == set(collections)
        assert all(
            str(r["owner_id"]) == users[0] and r["revision"] == 1 and r["read_link_digest"] is None
            for r in rows
        )
        assert asyncio.run(sql("SELECT count(*) AS n FROM collection_papers"))[0]["n"] == 3
        assert (
            asyncio.run(sql("SELECT count(*) AS n FROM collection_members WHERE role='editor'"))[0][
                "n"
            ]
            == 6
        )
        assert (
            asyncio.run(sql("SELECT count(*) AS n FROM collection_members WHERE role='viewer'"))[0][
                "n"
            ]
            == 3
        )
        assert not asyncio.run(
            sql(
                "SELECT column_name FROM information_schema.columns WHERE table_name='collections' AND column_name='visibility'"
            )
        )
        assert not asyncio.run(sql("SELECT typname FROM pg_type WHERE typname='visibility_enum'"))
        print(
            "Clean upgrade, previous-head upgrade, encryption round-trip, failure atomicity pre-OTP and collection sharing upgrades passed"
        )


if __name__ == "__main__":
    main()
