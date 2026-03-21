from __future__ import annotations

import html
import json
import re
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qsl, quote, urlencode, urlparse, urlunparse
from urllib.request import Request, urlopen

from .config import AppConfig


DOI_PATTERN = re.compile(r"10\.\d{4,9}/[-._;()/:A-Z0-9]+", re.IGNORECASE)


def utcnow() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def normalize_doi(value: Optional[str]) -> Optional[str]:
    if not value:
        return None
    return value.strip().lower().replace("https://doi.org/", "").replace("http://doi.org/", "").replace("doi:", "")


def normalize_text(value: str) -> str:
    sanitized = "".join(character.lower() if character.isalnum() else " " for character in value)
    return " ".join(sanitized.split())


def extract_doi_from_text(value: str) -> Optional[str]:
    match = DOI_PATTERN.search(value)
    return normalize_doi(match.group(0)) if match else None


def reconstruct_abstract(inverted_index: Optional[Dict[str, List[int]]]) -> Optional[str]:
    if not inverted_index:
        return None
    positions: Dict[int, str] = {}
    for token, indexes in inverted_index.items():
        for index in indexes:
            positions[index] = token
    return " ".join(positions[position] for position in sorted(positions))


def strip_html(value: Optional[str]) -> Optional[str]:
    if not value:
        return value
    without_tags = re.sub(r"<[^>]+>", " ", value)
    return " ".join(html.unescape(without_tags).split())


@dataclass
class ProviderCapability:
    name: str
    requires_credentials: bool
    credential_type: str
    supported_identifiers: List[str]
    features: List[str]
    trust_priority: int
    limitations: List[str]
    absent_credential_behavior: str
    base_url: str


class ProviderError(Exception):
    def __init__(self, provider: str, message: str, *, status_code: Optional[int] = None) -> None:
        super().__init__(message)
        self.provider = provider
        self.message = message
        self.status_code = status_code


class HttpTransport:
    def get_json(self, url: str, *, headers: Optional[Dict[str, str]] = None, timeout: int = 20) -> Dict[str, Any]:
        raise NotImplementedError


class UrllibHttpTransport(HttpTransport):
    def get_json(self, url: str, *, headers: Optional[Dict[str, str]] = None, timeout: int = 20) -> Dict[str, Any]:
        request = Request(url, headers=headers or {})
        try:
            with urlopen(request, timeout=timeout) as response:
                return json.loads(response.read().decode("utf-8"))
        except HTTPError as error:
            detail = error.read().decode("utf-8", errors="ignore")
            raise ProviderError("http", f"HTTP {error.code}: {detail or error.reason}", status_code=error.code) from error
        except URLError as error:
            raise ProviderError("http", f"Network error: {error.reason}") from error


class BaseProvider:
    capability: ProviderCapability

    def __init__(self, config: AppConfig, transport: Optional[HttpTransport] = None) -> None:
        self.config = config
        self.transport = transport or UrllibHttpTransport()

    def docs(self) -> Dict[str, Any]:
        capability = self.capability
        return {
            "name": capability.name,
            "data_provided": capability.features,
            "supported_identifiers": capability.supported_identifiers,
            "requires_credentials": capability.requires_credentials,
            "credential_type": capability.credential_type,
            "known_limitations": capability.limitations,
            "absent_credential_behavior": capability.absent_credential_behavior,
            "trust_priority": capability.trust_priority,
            "base_url": capability.base_url,
        }

    def is_enabled(self) -> bool:
        return True

    def lookup(self, identifier_type: str, value: str) -> Optional[Dict[str, Any]]:
        raise NotImplementedError

    def search(self, query: str) -> List[Dict[str, Any]]:
        raise NotImplementedError

    def relations(self, seed_record: Dict[str, Any]) -> Dict[str, Any]:
        return {"references": [], "citations": [], "degraded": []}


class OpenAlexProvider(BaseProvider):
    capability = ProviderCapability(
        name="openalex",
        requires_credentials=True,
        credential_type="api_key",
        supported_identifiers=["doi", "title", "url"],
        features=["lookup", "search", "authors", "references", "citations", "topics"],
        trust_priority=100,
        limitations=["free API key required", "related-work ingestion may be truncated by configured max graph size"],
        absent_credential_behavior="primary graph retrieval unavailable until OPENALEX_API_KEY is configured",
        base_url="https://api.openalex.org",
    )

    def is_enabled(self) -> bool:
        return bool(self.config.openalex_api_key)

    def _request(self, path_or_url: str, *, params: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        if not self.config.openalex_api_key:
            raise ProviderError(self.capability.name, "Missing OPENALEX_API_KEY.")
        params = {key: value for key, value in (params or {}).items() if value not in (None, "", [])}
        if path_or_url.startswith("http"):
            parsed = urlparse(path_or_url)
            existing = dict(parse_qsl(parsed.query, keep_blank_values=True))
            existing.update({key: str(value) for key, value in params.items()})
            existing["api_key"] = self.config.openalex_api_key
            query = urlencode(existing, doseq=True)
            url = urlunparse((parsed.scheme, parsed.netloc, parsed.path, parsed.params, query, parsed.fragment))
        else:
            query = urlencode({**{key: str(value) for key, value in params.items()}, "api_key": self.config.openalex_api_key}, doseq=True)
            url = f"{self.capability.base_url}{path_or_url}"
            if query:
                url = f"{url}?{query}"
        return self.transport.get_json(url, timeout=self.config.request_timeout_seconds)

    def _normalize_work(self, raw: Dict[str, Any]) -> Dict[str, Any]:
        primary_location = raw.get("primary_location") or {}
        source = primary_location.get("source") or {}
        authorships = raw.get("authorships") or []
        authors = [authorhip.get("author", {}).get("display_name") for authorhip in authorships if authorhip.get("author", {}).get("display_name")]
        affiliations = []
        author_details = []
        for authorship in authorships:
            institutions = authorship.get("institutions") or []
            author = authorship.get("author") or {}
            affiliation_names = [institution.get("display_name") for institution in institutions if institution.get("display_name")]
            affiliations.extend(affiliation_names)
            author_details.append(
                {
                    "name": author.get("display_name"),
                    "openalex_id": author.get("id"),
                    "orcid": author.get("orcid"),
                    "affiliations": affiliation_names,
                }
            )
        topics = [topic.get("display_name") for topic in raw.get("topics") or [] if topic.get("display_name")]
        keywords = [item.get("display_name") for item in raw.get("keywords") or [] if item.get("display_name")]
        concept_keywords = [concept.get("display_name") for concept in raw.get("concepts") or [] if concept.get("display_name")]
        doi = normalize_doi(raw.get("doi"))
        return {
            "doi": doi,
            "title": raw.get("display_name") or raw.get("title"),
            "subtitle": None,
            "abstract": reconstruct_abstract(raw.get("abstract_inverted_index")),
            "authors": authors,
            "author_details": author_details,
            "affiliations": sorted({item for item in affiliations if item}),
            "venue": source.get("display_name"),
            "year": raw.get("publication_year"),
            "published_at": raw.get("publication_date"),
            "publication_type": raw.get("type"),
            "keywords": sorted({item for item in keywords + concept_keywords if item}),
            "topics": sorted({item for item in topics if item}),
            "canonical_url": primary_location.get("landing_page_url") or raw.get("doi"),
            "pdf_url": primary_location.get("pdf_url"),
            "external_ids": {
                "openalex": raw.get("id"),
                "pmid": normalize_doi(raw.get("ids", {}).get("pmid")) if isinstance(raw.get("ids", {}).get("pmid"), str) else raw.get("ids", {}).get("pmid"),
                "pmcid": raw.get("ids", {}).get("pmcid"),
            },
            "language": raw.get("language"),
            "citation_count": raw.get("cited_by_count"),
            "reference_count": len(raw.get("referenced_works") or []),
            "raw_sources": [
                {
                    "provider": self.capability.name,
                    "provider_id": raw.get("id"),
                    "source_url": raw.get("id"),
                    "retrieved_at": utcnow(),
                    "is_primary": True,
                    "payload": raw,
                }
            ],
            "graph_hints": {
                "openalex_id": raw.get("id"),
                "referenced_works": raw.get("referenced_works") or [],
                "cited_by_api_url": raw.get("cited_by_api_url"),
            },
        }

    def _get_work(self, path_or_id: str) -> Optional[Dict[str, Any]]:
        work_id = path_or_id
        if path_or_id.startswith("https://openalex.org/"):
            work_id = path_or_id.rsplit("/", 1)[-1]
        try:
            payload = self._request(f"/works/{quote(work_id, safe='')}")
            return payload
        except ProviderError as error:
            if error.status_code == 404:
                return None
            raise

    def lookup(self, identifier_type: str, value: str) -> Optional[Dict[str, Any]]:
        if not self.is_enabled():
            return None
        if identifier_type == "doi":
            doi = normalize_doi(value)
            if not doi:
                return None
            work = self._get_work(f"https://doi.org/{doi}")
            return self._normalize_work(work) if work else None
        if identifier_type == "url":
            extracted = extract_doi_from_text(value)
            return self.lookup("doi", extracted) if extracted else None
        search_results = self.search(value)
        exact = [item for item in search_results if normalize_text(item.get("title") or "") == normalize_text(value)]
        return exact[0] if exact else (search_results[0] if search_results else None)

    def search(self, query: str) -> List[Dict[str, Any]]:
        if not self.is_enabled() or not query.strip():
            return []
        payload = self._request("/works", params={"search": query, "per-page": 10})
        return [self._normalize_work(item) for item in payload.get("results", [])]

    def _paginate_url(self, url: str) -> List[Dict[str, Any]]:
        records: List[Dict[str, Any]] = []
        page = 1
        per_page = min(200, self.config.max_related_works or 100)
        while len(records) < self.config.max_related_works:
            payload = self._request(url, params={"page": page, "per-page": per_page})
            results = payload.get("results", [])
            if not results:
                break
            records.extend(results)
            total_pages = payload.get("meta", {}).get("count", 0)
            if len(results) < per_page or len(records) >= total_pages:
                break
            page += 1
        return records[: self.config.max_related_works]

    def relations(self, seed_record: Dict[str, Any]) -> Dict[str, Any]:
        if not self.is_enabled():
            return {"references": [], "citations": [], "degraded": ["OpenAlex non configurato."]}
        openalex_id = seed_record.get("graph_hints", {}).get("openalex_id") or seed_record.get("external_ids", {}).get("openalex")
        if not openalex_id and seed_record.get("doi"):
            looked_up = self.lookup("doi", seed_record["doi"])
            openalex_id = looked_up.get("graph_hints", {}).get("openalex_id") if looked_up else None
            if looked_up:
                seed_record = looked_up
        referenced = seed_record.get("graph_hints", {}).get("referenced_works")
        cited_by_url = seed_record.get("graph_hints", {}).get("cited_by_api_url")
        if openalex_id and (referenced is None or cited_by_url is None or (not referenced and not cited_by_url)):
            refreshed = self._get_work(openalex_id)
            if refreshed:
                seed_record = self._normalize_work(refreshed)
        if not openalex_id:
            return {"references": [], "citations": [], "degraded": ["OpenAlex ID non disponibile per recuperare il grafo."]}
        referenced = seed_record.get("graph_hints", {}).get("referenced_works") or []
        cited_by_url = seed_record.get("graph_hints", {}).get("cited_by_api_url")
        references: List[Dict[str, Any]] = []
        for raw_id in referenced[: self.config.max_related_works]:
            raw = self._get_work(raw_id)
            if raw:
                references.append(self._normalize_work(raw))
        citations: List[Dict[str, Any]] = []
        if cited_by_url:
            citations = [self._normalize_work(item) for item in self._paginate_url(cited_by_url)]
        degraded: List[str] = []
        if len(referenced) > self.config.max_related_works:
            degraded.append("Lista references troncata al limite configurato.")
        return {"references": references, "citations": citations, "degraded": degraded}


class CrossrefProvider(BaseProvider):
    capability = ProviderCapability(
        name="crossref",
        requires_credentials=False,
        credential_type="mailto",
        supported_identifiers=["doi", "title"],
        features=["lookup", "search", "reference_enrichment", "citation_count"],
        trust_priority=60,
        limitations=["citation network completo non disponibile per tutti i record"],
        absent_credential_behavior="available without credentials, but mailto is recommended",
        base_url="https://api.crossref.org",
    )

    def _request(self, path: str, *, params: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        params = {key: value for key, value in (params or {}).items() if value not in (None, "", [])}
        if self.config.crossref_mailto:
            params.setdefault("mailto", self.config.crossref_mailto)
        url = f"{self.capability.base_url}{path}"
        if params:
            url = f"{url}?{urlencode({key: str(value) for key, value in params.items()}, doseq=True)}"
        headers = {"User-Agent": f"ReferenceManager/0.1 (mailto:{self.config.crossref_mailto or 'not-provided'})"}
        return self.transport.get_json(url, headers=headers, timeout=self.config.request_timeout_seconds)

    def _normalize_work(self, raw: Dict[str, Any]) -> Dict[str, Any]:
        issued_parts = (((raw.get("issued") or {}).get("date-parts") or [[None]])[0] or [None, None, None])
        year = issued_parts[0]
        published_at = "-".join(str(part).zfill(2) for part in issued_parts if part is not None) if year else None
        authors = []
        affiliations = []
        author_details = []
        for item in raw.get("author") or []:
            given = item.get("given", "")
            family = item.get("family", "")
            full_name = " ".join(part for part in [given, family] if part).strip()
            if not full_name:
                continue
            authors.append(full_name)
            affiliation_names = [entry.get("name") for entry in item.get("affiliation", []) if entry.get("name")]
            affiliations.extend(affiliation_names)
            author_details.append(
                {
                    "name": full_name,
                    "orcid": item.get("ORCID"),
                    "affiliations": affiliation_names,
                }
            )
        doi = normalize_doi(raw.get("DOI"))
        references = []
        for reference in raw.get("reference") or []:
            references.append(
                {
                    "doi": normalize_doi(reference.get("DOI")),
                    "title": reference.get("article-title") or reference.get("unstructured"),
                    "authors": [],
                    "year": reference.get("year"),
                    "manual": not bool(reference.get("DOI")),
                    "raw_reference": reference,
                }
            )
        return {
            "doi": doi,
            "title": (raw.get("title") or [None])[0],
            "abstract": strip_html(raw.get("abstract")),
            "authors": authors,
            "author_details": author_details,
            "affiliations": sorted({item for item in affiliations if item}),
            "venue": (raw.get("container-title") or [None])[0],
            "year": year,
            "published_at": published_at,
            "publication_type": raw.get("type"),
            "canonical_url": raw.get("URL"),
            "external_ids": {"crossref": doi},
            "language": raw.get("language"),
            "citation_count": raw.get("is-referenced-by-count"),
            "reference_count": raw.get("references-count"),
            "raw_sources": [
                {
                    "provider": self.capability.name,
                    "provider_id": doi,
                    "source_url": raw.get("URL"),
                    "retrieved_at": utcnow(),
                    "is_primary": False,
                    "payload": raw,
                }
            ],
            "graph_hints": {"reference_records": references},
        }

    def lookup(self, identifier_type: str, value: str) -> Optional[Dict[str, Any]]:
        if identifier_type == "doi":
            doi = normalize_doi(value)
            if not doi:
                return None
            try:
                payload = self._request(f"/works/{quote(doi, safe='')}")
                return self._normalize_work(payload.get("message", {}))
            except ProviderError as error:
                if error.status_code == 404:
                    return None
                raise
        results = self.search(value)
        exact = [item for item in results if normalize_text(item.get("title") or "") == normalize_text(value)]
        return exact[0] if exact else (results[0] if results else None)

    def search(self, query: str) -> List[Dict[str, Any]]:
        if not query.strip():
            return []
        payload = self._request("/works", params={"query.title": query, "rows": 10})
        return [self._normalize_work(item) for item in payload.get("message", {}).get("items", [])]

    def relations(self, seed_record: Dict[str, Any]) -> Dict[str, Any]:
        if not seed_record.get("doi"):
            return {"references": [], "citations": [], "degraded": []}
        enriched = self.lookup("doi", seed_record["doi"])
        if not enriched:
            return {"references": [], "citations": [], "degraded": []}
        return {
            "references": enriched.get("graph_hints", {}).get("reference_records", []),
            "citations": [],
            "degraded": ["Crossref non fornisce una lista completa dei citing papers per tutti i record."],
        }


class EuropePMCProvider(BaseProvider):
    capability = ProviderCapability(
        name="europepmc",
        requires_credentials=False,
        credential_type="email",
        supported_identifiers=["doi", "title"],
        features=["lookup", "search", "references", "citations", "biomedical_enrichment"],
        trust_priority=40,
        limitations=["mainly biomedical coverage"],
        absent_credential_behavior="provider can be disabled entirely without affecting general scholarly retrieval",
        base_url="https://www.ebi.ac.uk/europepmc/webservices/rest",
    )

    def is_enabled(self) -> bool:
        return self.config.europepmc_enabled

    def _request(self, path: str, *, params: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        params = {key: value for key, value in (params or {}).items() if value not in (None, "", [])}
        params.setdefault("format", "json")
        if self.config.europepmc_email:
            params.setdefault("email", self.config.europepmc_email)
        url = f"{self.capability.base_url}{path}"
        if params:
            url = f"{url}?{urlencode({key: str(value) for key, value in params.items()}, doseq=True)}"
        return self.transport.get_json(url, timeout=self.config.request_timeout_seconds)

    def _normalize_result(self, raw: Dict[str, Any]) -> Dict[str, Any]:
        authors = [name.strip() for name in (raw.get("authorString") or "").replace(".", ". ").split(",") if name.strip()]
        doi = normalize_doi(raw.get("doi"))
        return {
            "doi": doi,
            "title": raw.get("title"),
            "abstract": raw.get("abstractText"),
            "authors": authors,
            "affiliations": [],
            "venue": raw.get("journalTitle"),
            "year": int(raw["pubYear"]) if str(raw.get("pubYear", "")).isdigit() else None,
            "published_at": raw.get("firstPublicationDate"),
            "publication_type": raw.get("pubType"),
            "canonical_url": raw.get("fullTextUrlList", {}).get("fullTextUrl", [{}])[0].get("url") if raw.get("fullTextUrlList") else None,
            "external_ids": {"europepmc": raw.get("id"), "pmid": raw.get("pmid"), "pmcid": raw.get("pmcid")},
            "language": raw.get("language"),
            "citation_count": raw.get("citedByCount"),
            "reference_count": raw.get("hasReferences"),
            "raw_sources": [
                {
                    "provider": self.capability.name,
                    "provider_id": raw.get("id"),
                    "source_url": f"{self.capability.base_url}/article/{raw.get('source')}/{raw.get('id')}",
                    "retrieved_at": utcnow(),
                    "is_primary": False,
                    "payload": raw,
                }
            ],
            "graph_hints": {"europepmc_source": raw.get("source"), "europepmc_id": raw.get("id")},
        }

    def lookup(self, identifier_type: str, value: str) -> Optional[Dict[str, Any]]:
        if not self.is_enabled():
            return None
        if identifier_type == "doi":
            doi = normalize_doi(value)
            if not doi:
                return None
            payload = self._request("/search", params={"query": f'DOI:"{doi}"', "pageSize": 1, "resultType": "core"})
        else:
            payload = self._request("/search", params={"query": f'TITLE:"{value}"', "pageSize": 5, "resultType": "core"})
        results = payload.get("resultList", {}).get("result", []) or []
        return self._normalize_result(results[0]) if results else None

    def search(self, query: str) -> List[Dict[str, Any]]:
        if not self.is_enabled() or not query.strip():
            return []
        payload = self._request("/search", params={"query": query, "pageSize": 10, "resultType": "core"})
        return [self._normalize_result(item) for item in payload.get("resultList", {}).get("result", []) or []]

    def relations(self, seed_record: Dict[str, Any]) -> Dict[str, Any]:
        if not self.is_enabled():
            return {"references": [], "citations": [], "degraded": []}
        source = seed_record.get("graph_hints", {}).get("europepmc_source")
        identifier = seed_record.get("graph_hints", {}).get("europepmc_id")
        if not source or not identifier:
            if seed_record.get("doi"):
                enriched = self.lookup("doi", seed_record["doi"])
                if enriched:
                    source = enriched.get("graph_hints", {}).get("europepmc_source")
                    identifier = enriched.get("graph_hints", {}).get("europepmc_id")
        if not source or not identifier:
            return {"references": [], "citations": [], "degraded": []}
        references_payload = self._request(f"/{source}/{identifier}/references", params={"page": 1, "pageSize": self.config.max_related_works})
        citations_payload = self._request(f"/{source}/{identifier}/citations", params={"page": 1, "pageSize": self.config.max_related_works})
        references = [self._normalize_result(item) for item in references_payload.get("referenceList", {}).get("reference", []) or []]
        citations = [self._normalize_result(item) for item in citations_payload.get("citationList", {}).get("citation", []) or []]
        return {"references": references, "citations": citations, "degraded": []}


class ProviderRegistry:
    def __init__(self, config: AppConfig, transport: Optional[HttpTransport] = None) -> None:
        self.config = config
        self.providers: List[BaseProvider] = [
            OpenAlexProvider(config, transport),
            CrossrefProvider(config, transport),
            EuropePMCProvider(config, transport),
        ]

    def docs(self) -> List[Dict[str, Any]]:
        return [provider.docs() for provider in self.providers]

    def _provider_available(self, provider: BaseProvider, credential_states: Dict[str, str]) -> bool:
        state = credential_states.get(provider.capability.name, "valid")
        if provider.capability.requires_credentials and state not in {"valid", "configured"}:
            return False
        return provider.is_enabled()

    def lookup(self, identifier_type: str, value: str, credential_states: Dict[str, str]) -> Dict[str, Any]:
        degraded: List[str] = []
        seed: Optional[Dict[str, Any]] = None
        source_provider: Optional[str] = None
        enrichments: List[Dict[str, Any]] = []
        for provider in sorted(self.providers, key=lambda item: item.capability.trust_priority, reverse=True):
            if not self._provider_available(provider, credential_states):
                degraded.append(f"{provider.capability.name}: unavailable or missing credentials")
                continue
            try:
                record = provider.lookup(identifier_type, value)
            except ProviderError as error:
                degraded.append(f"{provider.capability.name}: {error.message}")
                continue
            if not record:
                continue
            if seed is None:
                seed = record
                source_provider = provider.capability.name
            else:
                enrichments.append(record)
        if seed and enrichments:
            seed = self._merge_record(seed, enrichments)
        return {"record": seed, "provider": source_provider, "degraded": degraded}

    def search(self, query: str, credential_states: Dict[str, str]) -> Dict[str, Any]:
        degraded: List[str] = []
        results: List[Dict[str, Any]] = []
        seen_keys = set()
        for provider in sorted(self.providers, key=lambda item: item.capability.trust_priority, reverse=True):
            if not self._provider_available(provider, credential_states):
                degraded.append(f"{provider.capability.name}: unavailable or missing credentials")
                continue
            try:
                provider_results = provider.search(query)
            except ProviderError as error:
                degraded.append(f"{provider.capability.name}: {error.message}")
                continue
            for item in provider_results:
                key = item.get("doi") or normalize_text(item.get("title") or "")
                if key in seen_keys:
                    continue
                seen_keys.add(key)
                results.append(item)
        return {"results": results, "degraded": degraded}

    def relations(self, seed_record: Dict[str, Any], credential_states: Dict[str, str]) -> Dict[str, Any]:
        degraded: List[str] = []
        references: List[Dict[str, Any]] = []
        citations: List[Dict[str, Any]] = []
        for provider in sorted(self.providers, key=lambda item: item.capability.trust_priority, reverse=True):
            if not self._provider_available(provider, credential_states):
                continue
            try:
                payload = provider.relations(seed_record)
            except ProviderError as error:
                degraded.append(f"{provider.capability.name}: {error.message}")
                continue
            references = self._merge_relation_lists(references, payload.get("references", []))
            citations = self._merge_relation_lists(citations, payload.get("citations", []))
            degraded.extend(payload.get("degraded", []))
        return {"relations": {"references": references, "citations": citations, "similar": []}, "provider": "aggregated", "degraded": degraded}

    def _merge_record(self, seed: Dict[str, Any], enrichments: List[Dict[str, Any]]) -> Dict[str, Any]:
        merged = dict(seed)
        raw_sources = list(seed.get("raw_sources", []))
        for enrichment in enrichments:
            raw_sources.extend(enrichment.get("raw_sources", []))
            for field in ("abstract", "venue", "published_at", "publication_type", "language", "canonical_url", "pdf_url"):
                if not merged.get(field) and enrichment.get(field):
                    merged[field] = enrichment[field]
            for list_field in ("authors", "affiliations", "keywords", "topics", "author_details"):
                merged[list_field] = self._merge_lists(merged.get(list_field, []), enrichment.get(list_field, []))
            merged["external_ids"] = {**enrichment.get("external_ids", {}), **merged.get("external_ids", {})}
            merged["graph_hints"] = {**enrichment.get("graph_hints", {}), **merged.get("graph_hints", {})}
            if not merged.get("citation_count") and enrichment.get("citation_count") is not None:
                merged["citation_count"] = enrichment["citation_count"]
            if not merged.get("reference_count") and enrichment.get("reference_count") is not None:
                merged["reference_count"] = enrichment["reference_count"]
        merged["raw_sources"] = raw_sources
        return merged

    def _merge_relation_lists(self, current: List[Dict[str, Any]], incoming: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        merged = {item.get("doi") or normalize_text(item.get("title") or ""): item for item in current if item.get("doi") or item.get("title")}
        for item in incoming:
            key = item.get("doi") or normalize_text(item.get("title") or "")
            if not key:
                continue
            if key in merged:
                merged[key] = self._merge_record(merged[key], [item])
            else:
                merged[key] = item
        return list(merged.values())

    def _merge_lists(self, first: List[Any], second: List[Any]) -> List[Any]:
        seen = set()
        merged = []
        for collection in (first, second):
            for item in collection:
                marker = json.dumps(item, sort_keys=True, ensure_ascii=True) if isinstance(item, dict) else str(item)
                if marker in seen:
                    continue
                seen.add(marker)
                merged.append(item)
        return merged
