"""Exercise clean and previous-head upgrades in a disposable PostgreSQL database."""

import asyncio
import base64
import hashlib
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


def migrate(revision, key_file, success=True, command="upgrade"):
    env = {
        **os.environ,
        "DATABASE_URL": TARGET,
        "ENVIRONMENT": "test",
        "APP_ENCRYPTION_KEYS_FILE": str(key_file) if key_file else "",
        "APP_ACTIVE_KEY_VERSION": "1",
        "DATABASE_URL_FILE": "",
    }
    result = subprocess.run(
        [sys.executable, "-m", "alembic", command, revision], env=env, capture_output=True
    )
    if (result.returncode == 0) != success:
        print(result.stderr.decode(errors="replace"), file=sys.stderr)
        raise RuntimeError("Unexpected migration outcome; inspect the disposable database")
    return result.stderr.decode(errors="replace")


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
        check_key_repair(key_file)
        print(
            "Clean upgrade, previous-head upgrade, encryption round-trip, failure atomicity, "
            "pre-OTP and collection sharing upgrades, and the legacy paper-key repair "
            "(logged counts, re-upgrade idempotency) passed"
        )


# Seed at c7d8 (the schema the audit found, with collections.visibility) so
# the upgrade also crosses the later revisions; downgrade only to the repair's
# parent, since its own downgrade is the no-op.
KEY_REPAIR_FROM = "c7d8e9f0a1b2"
KEY_REPAIR_PARENT = "f8a9b0c1d2e3"
TNN = "doi:10.1109/tnn.2008.2005605"
RAW_KEYS = ("10.1109/tnn.2008.2005605", "https://dx.doi.org/10.1109/TNN.2008.2005605")
# A Semantic Scholar key with no cached row: valid as stored, never repaired or reported.
S2_KEY = "s2:" + "c" * 40


def synthetic_group(key):
    return "group:" + hashlib.sha256(key.encode("utf-8")).hexdigest()[:16]


def seed_legacy_keys():
    """The audit shape at c7d8: raw and doi: rows for one paper, conflicting
    states, a duplicate tag and a note on the raw key, plus an invalid key
    and an uncached ``s2:`` key."""
    user_id, collection_id = str(uuid.uuid4()), str(uuid.uuid4())
    statements = [
        (
            "INSERT INTO users (id,email,password_hash,display_name) VALUES (:u,'repair@example.com','test-only','Repair')",
            {},
        ),
        (
            "INSERT INTO collections (id,owner_id,name,visibility) VALUES (:c,:u,'Audit','private')",
            {},
        ),
        (
            "INSERT INTO collection_members (collection_id,user_id,role) VALUES (:c,:u,'owner')",
            {},
        ),
        (
            "INSERT INTO cached_paper_metadata (canonical_key,paper_group_key,title,authors_json,topics_json,keywords_json,provider_source) VALUES (:k,'group:gnn','The Graph Neural Network Model','[]','[]','[]','openalex')",
            {"k": TNN},
        ),
    ]
    keys = [(RAW_KEYS[0], 0), (TNN, 1), (RAW_KEYS[1], 2), ("doi:not-a-doi", 3), (S2_KEY, 4)]
    for key, position in keys:
        group = "group:gnn" if key == TNN else synthetic_group(key)
        statements += [
            (
                "INSERT INTO collection_papers (collection_id,paper_canonical_key,added_by,position) VALUES (:c,:k,:u,:p)",
                {"k": key, "p": position},
            ),
            (
                "INSERT INTO user_library_entries (user_id,paper_group_key,primary_canonical_key) VALUES (:u,:g,:k)",
                {"k": key, "g": group},
            ),
            (
                "INSERT INTO user_library_versions (user_id,paper_canonical_key,paper_group_key) VALUES (:u,:k,:g)",
                {"k": key, "g": group},
            ),
        ]
    statements += [
        (
            "INSERT INTO user_paper_states (user_id,paper_canonical_key,state) VALUES (:u,:raw,'reading'),(:u,:k,'to_read')",
            {"raw": RAW_KEYS[0], "k": TNN},
        ),
        (
            "INSERT INTO user_paper_tags (user_id,paper_canonical_key,tag,paper_group_key) VALUES (:u,:raw,'gnn',:g),(:u,:k,'gnn','group:gnn')",
            {"raw": RAW_KEYS[0], "k": TNN, "g": synthetic_group(RAW_KEYS[0])},
        ),
        (
            "INSERT INTO notes (id,user_id,target_type,target_key,paper_group_key,content) VALUES (:n,:u,'paper',:raw,:g,'Raw-key note')",
            {"n": str(uuid.uuid4()), "raw": RAW_KEYS[0], "g": synthetic_group(RAW_KEYS[0])},
        ),
    ]
    for statement, parameters in statements:
        asyncio.run(sql(statement, {"u": user_id, "c": collection_id, **parameters}))


def assert_key_repair():
    rows = asyncio.run(
        sql("SELECT paper_canonical_key, position FROM collection_papers ORDER BY position")
    )
    assert [(row["paper_canonical_key"], row["position"]) for row in rows] == [
        (TNN, 0),
        ("doi:not-a-doi", 3),
        (S2_KEY, 4),
    ], rows
    kept = [("doi:not-a-doi", synthetic_group("doi:not-a-doi")), (S2_KEY, synthetic_group(S2_KEY))]
    entries = asyncio.run(
        sql("SELECT paper_group_key, primary_canonical_key FROM user_library_entries")
    )
    assert sorted(
        (row["paper_group_key"], row["primary_canonical_key"]) for row in entries
    ) == sorted([("group:gnn", TNN), *((group, key) for key, group in kept)]), entries
    pins = asyncio.run(
        sql("SELECT paper_canonical_key, paper_group_key FROM user_library_versions")
    )
    assert sorted((row["paper_canonical_key"], row["paper_group_key"]) for row in pins) == sorted(
        [(TNN, "group:gnn"), *kept]
    ), pins
    states = asyncio.run(sql("SELECT paper_canonical_key, state FROM user_paper_states"))
    assert [(row["paper_canonical_key"], row["state"]) for row in states] == [(TNN, "reading")]
    tags = asyncio.run(sql("SELECT paper_canonical_key, tag, paper_group_key FROM user_paper_tags"))
    assert [tuple(row.values()) for row in tags] == [(TNN, "gnn", "group:gnn")], tags
    notes = asyncio.run(sql("SELECT target_key, paper_group_key FROM notes"))
    assert [tuple(row.values()) for row in notes] == [(TNN, "group:gnn")], notes


def check_key_repair(key_file):
    reset()
    migrate(KEY_REPAIR_FROM, key_file)
    seed_legacy_keys()
    log = migrate("head", key_file)
    assert "Paper key repair: 2 keys mapped, 1 unrepairable" in log, log
    assert_key_repair()
    # The downgrade is a documented no-op; upgrading again re-runs the repair
    # over already repaired data, which must change nothing.
    migrate(KEY_REPAIR_PARENT, key_file, command="downgrade")
    log = migrate("head", key_file)
    assert "Paper key repair: 0 keys mapped, 1 unrepairable" in log, log
    assert_key_repair()


if __name__ == "__main__":
    main()
