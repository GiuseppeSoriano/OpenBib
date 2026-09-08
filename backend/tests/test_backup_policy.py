"""Explicit backup opt-out must not weaken SMTP, auth, encryption or deletion safety."""

import base64
import json
from datetime import UTC
from unittest.mock import Mock

import pytest
from pydantic import ValidationError

from app.auth.models import AccountDeletionTombstone
from app.auth.service import utcnow
from app.common import deletion_journal
from app.config import Settings, settings
from app.legal import LegalConfig, _development_config, get_legal_config
from app.users.models import User
from app.users.service import delete_user_account
from tests.test_auth import user_for_test


def production_settings(**overrides):
    values = {
        "environment": "production",
        "app_public_url": "https://library.acme.org",
        "cors_origins": ["https://library.acme.org"],
        "allowed_hosts": ["library.acme.org", "127.0.0.1"],
        "cookie_secure": True,
        "jwt_secret_key": "j" * 48,
        "rate_limit_hmac_key": "h" * 48,
        "app_encryption_keys": json.dumps({"1": base64.b64encode(b"k" * 32).decode()}),
        "database_url": "postgresql+asyncpg://openbib:" + "d" * 32 + "@db/openbib",
        "redis_url": "redis://:" + "r" * 32 + "@cache/0",
        "smtp_starttls": True,
        "smtp_host": "smtp.acme.org",
        "smtp_username": "mail@acme.org",
        "smtp_password": "p" * 32,
        "email_from": "OpenBib <mail@acme.org>",
        "legal_config_path": "/run/openbib/legal.json",
        "backups_enabled": False,
    }
    return Settings(_env_file=None, **(values | overrides))


def test_production_without_backups_needs_no_s3_secrets(tmp_path):
    config = production_settings(aws_access_key_id_file=str(tmp_path / "missing"))
    assert not config.backups_enabled and not config.deletion_journal_enabled
    assert config.aws_access_key_id == config.aws_secret_access_key == ""


@pytest.mark.parametrize(
    "overrides",
    [
        {"backups_enabled": True},
        {"deletion_journal_enabled": True},
        {"cookie_secure": False},
        {"smtp_password": ""},
        {"smtp_starttls": False},
        {"jwt_secret_key": "short"},
        {"rate_limit_hmac_key": "short"},
        {"legal_config_path": ""},
    ],
)
def test_opt_out_does_not_relax_other_production_checks(overrides):
    with pytest.raises(ValidationError):
        production_settings(**overrides)


def test_existing_config_keeps_backup_protection():
    config = Settings(_env_file=None)
    assert config.backups_enabled and config.deletion_journal_enabled
    with pytest.raises(ValidationError, match="require the off-site"):
        production_settings(backups_enabled=True, deletion_journal_enabled=False)


def test_journal_can_outlive_new_backups():
    config = production_settings(
        deletion_journal_enabled=True,
        deletion_journal_bucket="retiring-journal",
        aws_access_key_id="access-key",
        aws_secret_access_key="s" * 32,
    )
    assert not config.backups_enabled and config.deletion_journal_enabled


async def test_no_backup_account_deletion_never_contacts_s3(db, monkeypatch):
    user = await user_for_test(db)
    user_id = user.id
    monkeypatch.setattr(settings, "environment", "production")
    monkeypatch.setattr(settings, "backups_enabled", False)
    monkeypatch.setattr(settings, "deletion_journal_enabled", False)
    client = Mock(side_effect=AssertionError("S3 must not be contacted"))
    monkeypatch.setattr(deletion_journal.boto3, "client", client)
    await delete_user_account(db, user)
    await db.commit()
    assert await db.get(User, user_id) is None
    assert await db.get(AccountDeletionTombstone, user_id) is None
    client.assert_not_called()
    with pytest.raises(RuntimeError, match="disabled"):
        deletion_journal.read_receipts()
    with pytest.raises(RuntimeError, match="disabled"):
        deletion_journal.client()


async def test_retiring_backup_keeps_thirty_day_tombstone(db, monkeypatch):
    user = await user_for_test(db)
    monkeypatch.setattr(settings, "backups_enabled", False)
    monkeypatch.setattr(settings, "deletion_journal_enabled", True)
    await delete_user_account(db, user)
    tombstone = await db.get(AccountDeletionTombstone, user.id)
    assert 29 < (tombstone.expires_at.replace(tzinfo=UTC) - utcnow()).total_seconds() / 86400 <= 30


@pytest.mark.parametrize(
    "backups,journal,days,valid",
    [
        (False, False, 0, True),
        (False, True, 0, True),
        (True, True, 30, True),
        (False, False, 30, False),
        (True, True, 0, False),
        (True, False, 30, False),
    ],
)
def test_legal_policy_is_consistent(backups, journal, days, valid):
    raw = _development_config().model_dump(mode="json")
    raw.update(backups_enabled=backups, deletion_journal_enabled=journal)
    raw["retention"]["backups_days"] = days
    if valid:
        assert LegalConfig.model_validate(raw).retention.backups_days == days
    else:
        with pytest.raises(ValidationError):
            LegalConfig.model_validate(raw)


def test_legacy_legal_file_retains_backup_policy():
    raw = _development_config().model_dump(mode="json")
    raw.pop("backups_enabled")
    raw.pop("deletion_journal_enabled")
    raw["retention"]["backups_days"] = 30
    config = LegalConfig.model_validate(raw)
    assert config.backups_enabled and config.deletion_journal_enabled


@pytest.mark.parametrize("field", ["backups_enabled", "deletion_journal_enabled"])
def test_legal_flags_reject_strings_that_the_browser_would_treat_as_true(field):
    raw = _development_config().model_dump(mode="json")
    raw[field] = "false"
    with pytest.raises(ValidationError):
        LegalConfig.model_validate(raw)


def test_production_refuses_misleading_legal_policy(tmp_path, monkeypatch):
    path = tmp_path / "legal.json"
    path.write_text(_development_config().model_dump_json())
    monkeypatch.setattr(settings, "environment", "production")
    monkeypatch.setattr(settings, "legal_config_path", str(path))
    monkeypatch.setattr(settings, "backups_enabled", True)
    get_legal_config.cache_clear()
    try:
        with pytest.raises(RuntimeError, match="does not match"):
            get_legal_config()
    finally:
        get_legal_config.cache_clear()


def test_production_accepts_complete_legal_file_without_backup_supplier(tmp_path, monkeypatch):
    raw = _development_config().model_dump(mode="json")
    raw.update(public_url="https://library.acme.org", data_location="European Union")
    raw["operator"].update(privacy_email="privacy@acme.org", support_email="support@acme.org")
    raw["third_parties"] = [
        {
            "name": name,
            "purpose": purpose,
            "role": "processor",
            "region": "European Union",
            "privacy_url": "https://acme.org/privacy",
        }
        for name, purpose in [
            ("Host", "Hosting"),
            ("Mail", "Transactional email"),
            ("Catalog", "Search"),
        ]
    ]
    path = tmp_path / "legal.json"
    path.write_text(json.dumps(raw))
    config = production_settings(legal_config_path=str(path))
    for field in (
        "environment",
        "app_public_url",
        "legal_config_path",
        "backups_enabled",
        "deletion_journal_enabled",
    ):
        monkeypatch.setattr(settings, field, getattr(config, field))
    get_legal_config.cache_clear()
    try:
        assert get_legal_config().retention.backups_days == 0
    finally:
        get_legal_config.cache_clear()
