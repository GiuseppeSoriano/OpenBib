"""Versioned, deployment-specific legal configuration."""

from __future__ import annotations

import json
from datetime import date
from functools import lru_cache
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, EmailStr, Field, HttpUrl, StrictBool, model_validator

from app.config import settings


class OperatorConfig(BaseModel):
    name: str = Field(min_length=2)
    address: str = Field(min_length=5)
    country: str = Field(min_length=2)
    privacy_email: EmailStr
    support_email: EmailStr


class ThirdPartyConfig(BaseModel):
    name: str
    purpose: str
    role: str
    region: str
    privacy_url: HttpUrl
    transfer_safeguard: str | None = None


class RetentionConfig(BaseModel):
    access_logs_days: int = Field(14, ge=14, le=14)
    security_events_days: int = Field(90, ge=90, le=90)
    backups_days: Literal[0, 30] = 30


class LegalConfig(BaseModel):
    schema_version: int = 1
    service_name: str
    public_url: HttpUrl
    effective_date: str
    privacy_version: str
    terms_version: str
    minimum_age: int = Field(16, ge=13, le=18)
    backups_enabled: StrictBool = True
    deletion_journal_enabled: StrictBool | None = None
    operator: OperatorConfig
    data_location: str
    third_parties: list[ThirdPartyConfig]
    retention: RetentionConfig = RetentionConfig()

    @model_validator(mode="after")
    def validate_backup_policy(self):
        if self.deletion_journal_enabled is None:
            self.deletion_journal_enabled = self.backups_enabled
        if self.backups_enabled and not self.deletion_journal_enabled:
            raise ValueError("Backups require the deletion journal")
        if self.retention.backups_days != (30 if self.backups_enabled else 0):
            raise ValueError("Backup retention must be 30 days when enabled, otherwise 0")
        return self


def _development_config() -> LegalConfig:
    return LegalConfig.model_validate(
        {
            "service_name": "OpenBib local development",
            "public_url": "http://localhost:3000",
            "effective_date": "2026-09-02",
            "privacy_version": "dev-1",
            "terms_version": "dev-1",
            "backups_enabled": False,
            "deletion_journal_enabled": False,
            "retention": {"backups_days": 0},
            "operator": {
                "name": "Local operator",
                "address": "Local development only",
                "country": "Local",
                "privacy_email": "privacy@example.com",
                "support_email": "support@example.com",
            },
            "data_location": "Local development machine",
            "third_parties": [],
        }
    )


@lru_cache
def get_legal_config() -> LegalConfig:
    if not settings.legal_config_path:
        if settings.environment == "production":
            raise RuntimeError("LEGAL_CONFIG_PATH is required in production")
        return _development_config()
    path = Path(settings.legal_config_path)
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
        config = LegalConfig.model_validate(raw)
    except (OSError, json.JSONDecodeError, ValueError) as exc:
        raise RuntimeError("Invalid legal configuration") from exc
    if settings.environment == "production":
        if (
            config.backups_enabled != settings.backups_enabled
            or config.deletion_journal_enabled != settings.deletion_journal_enabled
        ):
            raise RuntimeError("Legal backup policy does not match runtime configuration")
        try:
            date.fromisoformat(config.effective_date)
        except ValueError:
            raise RuntimeError("Legal effective_date must be an ISO date") from None

        def has_empty_strings(value):
            if isinstance(value, str):
                return not value.strip()
            if isinstance(value, dict):
                return any(has_empty_strings(child) for child in value.values())
            if isinstance(value, list):
                return any(has_empty_strings(child) for child in value)
            return False

        if has_empty_strings(raw) or len(config.third_parties) < 3:
            raise RuntimeError("Legal configuration is incomplete")
        serialized = json.dumps(raw).lower()
        if any(
            marker in serialized
            for marker in ("example.com", "replace-me", "replace me", "your ", "todo")
        ):
            raise RuntimeError("Legal configuration still contains placeholder values")
        if str(config.public_url).rstrip("/") != settings.app_public_url.rstrip("/"):
            raise RuntimeError("Legal public_url does not match APP_PUBLIC_URL")
    return config
