from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, Optional


def _parse_bool(value: Optional[str], default: bool) -> bool:
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "on"}


def load_dotenv(env_path: str = ".env") -> Dict[str, str]:
    path = Path(env_path)
    loaded: Dict[str, str] = {}
    if not path.exists():
        return loaded
    for line in path.read_text(encoding="utf-8").splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#") or "=" not in stripped:
            continue
        key, value = stripped.split("=", 1)
        key = key.strip()
        value = value.strip().strip("'").strip('"')
        loaded[key] = value
        os.environ.setdefault(key, value)
    return loaded


@dataclass(frozen=True)
class AppConfig:
    openalex_api_key: Optional[str]
    opencitations_access_token: Optional[str]
    crossref_mailto: Optional[str]
    europepmc_enabled: bool
    europepmc_email: Optional[str]
    request_timeout_seconds: int
    max_related_works: int
    provider_cache_ttl_seconds: int
    search_cache_ttl_seconds: int
    reference_cache_ttl_seconds: int
    citation_cache_ttl_seconds: int
    graph_store_backend: str = "sqlite"
    read_model_store_backend: str = "sqlite"
    mongodb_uri: Optional[str] = None
    mongodb_database: str = "reference_manager"
    neo4j_uri: Optional[str] = None
    neo4j_username: Optional[str] = None
    neo4j_password: Optional[str] = None
    neo4j_database: Optional[str] = None

    @classmethod
    def from_env(cls, env_path: str = ".env") -> "AppConfig":
        load_dotenv(env_path)
        return cls(
            openalex_api_key=os.getenv("OPENALEX_API_KEY"),
            opencitations_access_token=os.getenv("OPENCITATIONS_ACCESS_TOKEN"),
            crossref_mailto=os.getenv("CROSSREF_MAILTO"),
            europepmc_enabled=_parse_bool(os.getenv("EUROPEPMC_ENABLED"), True),
            europepmc_email=os.getenv("EUROPEPMC_EMAIL") or os.getenv("CROSSREF_MAILTO"),
            request_timeout_seconds=int(os.getenv("REQUEST_TIMEOUT_SECONDS", "20")),
            max_related_works=int(os.getenv("MAX_RELATED_WORKS", "100")),
            provider_cache_ttl_seconds=int(os.getenv("PROVIDER_CACHE_TTL_SECONDS", "86400")),
            search_cache_ttl_seconds=int(os.getenv("SEARCH_CACHE_TTL_SECONDS", "3600")),
            reference_cache_ttl_seconds=int(os.getenv("REFERENCE_CACHE_TTL_SECONDS", str(7 * 24 * 3600))),
            citation_cache_ttl_seconds=int(os.getenv("CITATION_CACHE_TTL_SECONDS", str(12 * 3600))),
            graph_store_backend=os.getenv("GRAPH_STORE_BACKEND", "sqlite"),
            read_model_store_backend=os.getenv("READ_MODEL_STORE_BACKEND", "sqlite"),
            mongodb_uri=os.getenv("MONGODB_URI"),
            mongodb_database=os.getenv("MONGODB_DATABASE", "reference_manager"),
            neo4j_uri=os.getenv("NEO4J_URI"),
            neo4j_username=os.getenv("NEO4J_USERNAME"),
            neo4j_password=os.getenv("NEO4J_PASSWORD"),
            neo4j_database=os.getenv("NEO4J_DATABASE"),
        )
