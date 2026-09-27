"""Application configuration loaded from environment variables and Docker secret files."""

from __future__ import annotations

import base64
import json
from pathlib import Path
from typing import Literal
from urllib.parse import urlsplit

from pydantic import Field, model_validator
from pydantic_settings import BaseSettings

_DEV_KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="


class Settings(BaseSettings):
    environment: Literal["development", "test", "production"] = "development"
    app_public_url: str = "http://localhost:3000"
    legal_config_path: str = ""
    log_directory: str = "/var/log/openbib"
    # Preserve protection for existing instances; new operators may explicitly opt out.
    backups_enabled: bool = True
    deletion_journal_enabled: bool | None = None
    deletion_journal_bucket: str = ""
    s3_endpoint_url: str = ""
    aws_region: str = "us-east-1"
    aws_access_key_id: str = ""
    aws_access_key_id_file: str = ""
    aws_secret_access_key: str = ""
    aws_secret_access_key_file: str = ""

    # Database
    database_url: str = "postgresql+asyncpg://openbib:openbib@localhost:5432/openbib"
    database_url_file: str = ""

    # Redis
    redis_url: str = "redis://localhost:6379/0"
    redis_url_file: str = ""

    # Auth
    jwt_secret_key: str = "CHANGE-ME-IN-PRODUCTION-32-BYTES-MINIMUM"
    jwt_secret_key_file: str = ""
    jwt_access_token_expire_minutes: int = 10
    jwt_refresh_token_expire_days: int = 7
    jwt_algorithm: str = "HS256"
    jwt_issuer: str = "openbib"
    jwt_audience: str = "openbib-web"
    cookie_secure: bool = False

    # Versioned application encryption keys: {"1": "<base64 32-byte key>"}
    app_encryption_keys: str = f'{{"1":"{_DEV_KEY}"}}'
    app_encryption_keys_file: str = ""
    app_active_key_version: int = 1
    rate_limit_hmac_key: str = "development-rate-limit-key"
    rate_limit_hmac_key_file: str = ""

    # SMTP
    smtp_host: str = ""
    smtp_port: int = 1025
    smtp_username: str = ""
    smtp_password: str = ""
    smtp_password_file: str = ""
    smtp_starttls: bool = False
    email_from: str = "OpenBib <noreply@localhost>"
    email_worker_poll_seconds: float = 5.0

    # Providers
    openalex_api_key: str = ""
    openalex_email: str = ""
    crossref_mailto: str = ""
    # Budget for resolving one DOI across the provider chain before it is
    # stored as pending, plus the per-request limits of batch imports.
    doi_resolve_timeout_seconds: float = 10.0
    import_resolve_concurrency: int = 4
    import_request_budget_seconds: float = 25.0

    # Graph related-paper ranges: range size, OpenAlex page size, depth cap in
    # raw provider records, per-request scan budget (hydration gets 5 s more,
    # so a request ends within 25 s) and top-up concurrency.
    graph_related_range_size: int = Field(30, ge=5, le=100)
    graph_related_chunk_size: int = Field(200, ge=1, le=200)
    graph_related_max_results: int = Field(10000, ge=200, le=50000)
    graph_related_scan_budget_seconds: float = Field(20.0, gt=0, le=20)
    graph_related_topup_concurrency: int = Field(4, ge=1, le=8)

    # Cache TTLs (seconds)
    cache_ttl_lookup: int = 86400
    cache_ttl_search: int = 3600
    cache_ttl_references: int = 604800
    cache_ttl_citations: int = 43200
    cache_ttl_author: int = 86400

    # CORS
    cors_origins: list[str] = ["http://localhost:3000", "http://localhost:5173"]
    allowed_hosts: list[str] = ["localhost", "127.0.0.1", "testserver"]

    @staticmethod
    def _read_file(path: str, field: str) -> str:
        try:
            value = Path(path).read_text(encoding="utf-8").strip()
        except OSError as exc:
            raise ValueError(f"Unable to read {field} secret file") from exc
        if not value:
            raise ValueError(f"{field} secret file is empty")
        return value

    @model_validator(mode="after")
    def load_secret_files_and_validate(self):
        if self.deletion_journal_enabled is None:
            self.deletion_journal_enabled = self.backups_enabled
        if self.backups_enabled and not self.deletion_journal_enabled:
            raise ValueError("Backups require the off-site deletion journal")
        for field in (
            "database_url",
            "redis_url",
            "jwt_secret_key",
            "app_encryption_keys",
            "rate_limit_hmac_key",
            "smtp_password",
            "aws_access_key_id",
            "aws_secret_access_key",
        ):
            if field.startswith("aws_") and not self.deletion_journal_enabled:
                continue
            file_path = getattr(self, f"{field}_file", "")
            if file_path:
                setattr(self, field, self._read_file(file_path, field))
        try:
            keys = json.loads(self.app_encryption_keys)
        except json.JSONDecodeError as exc:
            raise ValueError("APP_ENCRYPTION_KEYS must be valid JSON") from exc
        if not isinstance(keys, dict) or any(
            not str(k).isdigit() or not 1 <= int(k) <= 32767 for k in keys
        ):
            raise ValueError("Invalid encryption key versions")
        try:
            if any(len(base64.b64decode(value, validate=True)) != 32 for value in keys.values()):
                raise ValueError
        except (ValueError, TypeError):
            raise ValueError("Encryption keys must be base64-encoded 32-byte values") from None
        if str(self.app_active_key_version) not in keys:
            raise ValueError("APP_ACTIVE_KEY_VERSION is missing from APP_ENCRYPTION_KEYS")
        if self.environment == "production":
            failures: list[str] = []
            for field in (
                "jwt_secret_key",
                "rate_limit_hmac_key",
                "smtp_password",
                "aws_access_key_id",
                "aws_secret_access_key",
            ):
                if field.startswith("aws_") and not self.deletion_journal_enabled:
                    continue
                if any(
                    marker in getattr(self, field).lower()
                    for marker in ("replace-me", "change-me", "test-only", "example")
                ):
                    failures.append(f"{field} contains a placeholder")
            if (
                self.deletion_journal_enabled
                and self.s3_endpoint_url
                and not self.s3_endpoint_url.startswith("https://")
            ):
                failures.append("S3_ENDPOINT_URL must use HTTPS")
            if self.cors_origins != [self.app_public_url.rstrip("/")]:
                failures.append("Production CORS must contain only APP_PUBLIC_URL")
            if self.deletion_journal_enabled and (
                not self.deletion_journal_bucket
                or not self.aws_access_key_id
                or not self.aws_secret_access_key
            ):
                failures.append("S3 deletion journal and credentials are required")
            if not self.app_public_url.startswith("https://"):
                failures.append("APP_PUBLIC_URL must use https")
            if not self.cookie_secure:
                failures.append("COOKIE_SECURE must be true")
            if len(self.jwt_secret_key) < 32 or "CHANGE-ME" in self.jwt_secret_key.upper():
                failures.append(
                    "JWT_SECRET_KEY must be a non-default secret of at least 32 characters"
                )
            if (
                self.rate_limit_hmac_key == "development-rate-limit-key"
                or len(self.rate_limit_hmac_key) < 32
            ):
                failures.append("RATE_LIMIT_HMAC_KEY must be a non-default secret")
            if _DEV_KEY in self.app_encryption_keys:
                failures.append("APP_ENCRYPTION_KEYS must not contain the development key")
            for field in ("database_url", "redis_url"):
                password = urlsplit(getattr(self, field)).password or ""
                if len(password) < 24:
                    failures.append(f"{field} requires a strong password")
            if (
                self.jwt_access_token_expire_minutes != 10
                or self.jwt_refresh_token_expire_days != 7
                or self.jwt_algorithm != "HS256"
            ):
                failures.append("Production token lifetimes must be 10 minutes / 7 days and HS256")
            if not self.smtp_starttls or not self.smtp_username or not self.smtp_password:
                failures.append("Authenticated SMTP with STARTTLS is required")
            if not self.smtp_host or not self.email_from:
                failures.append("SMTP_HOST and EMAIL_FROM are required")
            if not self.legal_config_path:
                failures.append("LEGAL_CONFIG_PATH is required")
            if not self.allowed_hosts or "*" in self.allowed_hosts:
                failures.append("ALLOWED_HOSTS must contain explicit hosts")
            if failures:
                raise ValueError("Invalid production configuration: " + "; ".join(failures))
        return self

    model_config = {
        "env_file": ".env",
        "env_file_encoding": "utf-8",
        "extra": "ignore",
        "hide_input_in_errors": True,
    }


settings = Settings()
