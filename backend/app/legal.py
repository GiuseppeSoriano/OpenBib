"""Versioned, deployment-specific legal configuration."""

from __future__ import annotations

import json
import logging
import re
from datetime import date
from functools import lru_cache
from pathlib import Path
from typing import Annotated, Literal

from pydantic import (
    BaseModel,
    ConfigDict,
    EmailStr,
    Field,
    HttpUrl,
    StrictBool,
    field_validator,
    model_validator,
)

from app.config import settings

logger = logging.getLogger("openbib.legal")

PLACEHOLDER_MARKERS = ("replace-me", "replace me", "<your", "your-", "todo:", "example.com")
# Role identifiers the frontend translates itself (legal.roles.*), compared without separators.
KNOWN_ROLES = {
    "processor",
    "controller",
    "independentcontroller",
    "jointcontroller",
    "subprocessor",
}


class LocalizedText(BaseModel):
    """User-visible legal text in every language the frontend ships."""

    model_config = ConfigDict(extra="forbid")

    en: str = Field(min_length=1)
    it: str = Field(min_length=1)


# Plain strings stay valid so existing single-language files keep loading.
Text = str | LocalizedText


class OperatorConfig(BaseModel):
    name: str = Field(min_length=2)
    # Operators may omit a public postal address; legal suitability remains theirs to review.
    address: str = ""
    country: Annotated[str, Field(min_length=2)] | LocalizedText
    privacy_email: EmailStr
    support_email: EmailStr

    @field_validator("address")
    @classmethod
    def validate_address(cls, value: str) -> str:
        value = value.strip()
        if value and len(value) < 5:
            raise ValueError("A supplied postal address must contain at least five characters")
        return value


class ThirdPartyConfig(BaseModel):
    name: str
    purpose: Text
    role: Text
    region: Text
    privacy_url: HttpUrl
    transfer_safeguard: Text | None = None


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
    data_location: Text
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


def untranslated_fields(config: LegalConfig) -> list[str]:
    """Paths of user-visible fields that are still single-language plain strings."""
    fields = [
        ("data_location", config.data_location),
        ("operator.country", config.operator.country),
    ]
    for index, party in enumerate(config.third_parties):
        prefix = f"third_parties[{index}]"
        fields += [(f"{prefix}.purpose", party.purpose), (f"{prefix}.region", party.region)]
        if party.transfer_safeguard is not None:
            fields.append((f"{prefix}.transfer_safeguard", party.transfer_safeguard))
        if isinstance(party.role, str) and re.sub(r"[^a-z]", "", party.role.lower()) in KNOWN_ROLES:
            continue
        fields.append((f"{prefix}.role", party.role))
    return [path for path, value in fields if isinstance(value, str)]


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

        def has_empty_strings(value, location=()):
            if location == ("operator", "address"):
                return False
            if isinstance(value, str):
                return not value.strip()
            if isinstance(value, dict):
                return any(
                    has_empty_strings(child, (*location, key)) for key, child in value.items()
                )
            if isinstance(value, list):
                return any(
                    has_empty_strings(child, (*location, index))
                    for index, child in enumerate(value)
                )
            return False

        if has_empty_strings(raw) or len(config.third_parties) < 3:
            raise RuntimeError("Legal configuration is incomplete")
        serialized = json.dumps(raw).lower()
        if any(marker in serialized for marker in PLACEHOLDER_MARKERS):
            raise RuntimeError("Legal configuration still contains placeholder values")
        if str(config.public_url).rstrip("/") != settings.app_public_url.rstrip("/"):
            raise RuntimeError("Legal public_url does not match APP_PUBLIC_URL")
        if untranslated := untranslated_fields(config):
            logger.warning(
                "Legal fields are plain strings and show the same text in every language: "
                + ", ".join(untranslated)
            )
    return config
