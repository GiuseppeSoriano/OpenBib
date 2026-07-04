"""Application configuration loaded from environment variables."""

from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    # Database
    database_url: str = "postgresql+asyncpg://openbib:openbib@localhost:5432/openbib"

    # Redis
    redis_url: str = "redis://localhost:6379/0"

    # Auth
    jwt_secret_key: str = "CHANGE-ME-IN-PRODUCTION"
    jwt_access_token_expire_minutes: int = 30
    jwt_refresh_token_expire_days: int = 7
    jwt_algorithm: str = "HS256"

    # Providers
    openalex_api_key: str = ""
    openalex_email: str = ""
    crossref_mailto: str = ""

    # Cache TTLs (seconds)
    cache_ttl_lookup: int = 86400
    cache_ttl_search: int = 3600
    cache_ttl_references: int = 604800
    cache_ttl_citations: int = 43200
    cache_ttl_author: int = 86400

    # CORS
    cors_origins: list[str] = ["http://localhost:3000", "http://localhost:5173"]

    # Rate Limits
    rate_limit_global: str = "100/minute"
    rate_limit_auth: str = "10/minute"

    model_config = {"env_file": ".env", "env_file_encoding": "utf-8"}


settings = Settings()
