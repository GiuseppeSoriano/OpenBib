from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Dict, List, Optional


CATALOG: List[Dict[str, Any]] = [
    {
        "doi": "10.1000/litdisc.2020.001",
        "title": "Visual Discovery for Scholarly Graph Exploration",
        "abstract": "Introduces a visual workflow for exploring scholarly relations, citations, and topic clusters.",
        "authors": ["Elena Marino", "Marco Berti"],
        "affiliations": ["University of Turin", "University of Milan"],
        "venue": "Journal of Scholarly Systems",
        "year": 2020,
        "published_at": "2020-06-18",
        "publication_type": "journal",
        "keywords": ["literature discovery", "visual analytics", "citation graph"],
        "topics": ["literature discovery", "graph exploration"],
        "canonical_url": "https://example.org/papers/visual-discovery",
        "pdf_url": "https://example.org/papers/visual-discovery.pdf",
        "external_ids": {"openalex": "W1001"},
        "language": "en",
        "references": ["10.1000/litdisc.2018.003"],
        "citations": ["10.1000/litdisc.2021.004", "10.1000/litdisc.2022.007"],
        "similar": ["10.1000/litdisc.2021.004", "10.1000/litdisc.2019.002"],
    },
    {
        "doi": "10.1000/litdisc.2019.002",
        "title": "Semantic Similarity Signals for Academic Recommendation",
        "abstract": "Explores similarity-based recommendation using textual and citation features.",
        "authors": ["Laura Conti", "Elena Marino"],
        "affiliations": ["Sapienza University", "University of Turin"],
        "venue": "Proceedings of Discovery Systems",
        "year": 2019,
        "published_at": "2019-09-12",
        "publication_type": "conference",
        "keywords": ["semantic similarity", "recommendation", "ranking"],
        "topics": ["recommendations", "semantic similarity"],
        "canonical_url": "https://example.org/papers/semantic-similarity",
        "pdf_url": "https://example.org/papers/semantic-similarity.pdf",
        "external_ids": {"openalex": "W1002"},
        "language": "en",
        "references": ["10.1000/litdisc.2018.003"],
        "citations": ["10.1000/litdisc.2020.001", "10.1000/litdisc.2021.004"],
        "similar": ["10.1000/litdisc.2020.001", "10.1000/litdisc.2023.008"],
    },
    {
        "doi": "10.1000/litdisc.2018.003",
        "title": "Seed Papers and Citation Chaining in Literature Reviews",
        "abstract": "Discusses seed-driven exploration using citation chaining and manual curation.",
        "authors": ["Marco Berti", "Giulia Rinaldi"],
        "affiliations": ["University of Milan", "University of Bologna"],
        "venue": "Review Science Quarterly",
        "year": 2018,
        "published_at": "2018-02-03",
        "publication_type": "journal",
        "keywords": ["seed papers", "citation chaining"],
        "topics": ["literature discovery", "timeline analysis"],
        "canonical_url": "https://example.org/papers/seed-chaining",
        "pdf_url": "https://example.org/papers/seed-chaining.pdf",
        "external_ids": {"openalex": "W1003"},
        "language": "en",
        "references": [],
        "citations": ["10.1000/litdisc.2019.002", "10.1000/litdisc.2020.001"],
        "similar": ["10.1000/litdisc.2024.009"],
    },
    {
        "doi": "10.1000/litdisc.2021.004",
        "title": "Explainable Scholarly Recommendations with Feedback Loops",
        "abstract": "Presents explainable recommendation strategies that respect explicit relevance feedback.",
        "authors": ["Sara Valli", "Laura Conti"],
        "affiliations": ["Politecnico di Torino", "Sapienza University"],
        "venue": "ACM Knowledge Interfaces",
        "year": 2021,
        "published_at": "2021-04-09",
        "publication_type": "conference",
        "keywords": ["explainability", "feedback loops", "recommendations"],
        "topics": ["recommendations", "personalization"],
        "canonical_url": "https://example.org/papers/explainable-recommendations",
        "pdf_url": "https://example.org/papers/explainable-recommendations.pdf",
        "external_ids": {"openalex": "W1004"},
        "language": "en",
        "references": ["10.1000/litdisc.2020.001", "10.1000/litdisc.2019.002"],
        "citations": ["10.1000/litdisc.2022.007"],
        "similar": ["10.1000/litdisc.2023.008"],
    },
    {
        "doi": "10.1000/litdisc.2022.007",
        "title": "Temporal Signals in Research Topic Evolution",
        "abstract": "Studies topic drift, seminal work detection, and acceleration phases in research timelines.",
        "authors": ["Giulia Rinaldi", "Tommaso Greco"],
        "affiliations": ["University of Bologna", "University of Padua"],
        "venue": "Temporal Knowledge Review",
        "year": 2022,
        "published_at": "2022-11-01",
        "publication_type": "journal",
        "keywords": ["timeline", "topic evolution", "growth phases"],
        "topics": ["timeline analysis", "topic evolution"],
        "canonical_url": "https://example.org/papers/temporal-signals",
        "pdf_url": "https://example.org/papers/temporal-signals.pdf",
        "external_ids": {"openalex": "W1007"},
        "language": "en",
        "references": ["10.1000/litdisc.2020.001", "10.1000/litdisc.2021.004"],
        "citations": ["10.1000/litdisc.2024.009"],
        "similar": ["10.1000/litdisc.2024.009"],
    },
    {
        "doi": "10.1000/litdisc.2023.008",
        "title": "Collaborative Curation of Shared Reference Collections",
        "abstract": "Analyzes permission-aware collaboration and shared annotation on reference collections.",
        "authors": ["Sara Valli", "Enrico Fontana"],
        "affiliations": ["Politecnico di Torino", "University of Florence"],
        "venue": "Collaborative Systems Letters",
        "year": 2023,
        "published_at": "2023-03-15",
        "publication_type": "journal",
        "keywords": ["collaboration", "shared collections", "permissions"],
        "topics": ["collaboration", "annotations"],
        "canonical_url": "https://example.org/papers/shared-collections",
        "pdf_url": "https://example.org/papers/shared-collections.pdf",
        "external_ids": {"openalex": "W1008"},
        "language": "en",
        "references": ["10.1000/litdisc.2021.004"],
        "citations": ["10.1000/litdisc.2024.009"],
        "similar": ["10.1000/litdisc.2021.004"],
    },
    {
        "doi": "10.1000/litdisc.2024.009",
        "title": "Robust Bibliographic Reconciliation Across Metadata Providers",
        "abstract": "Describes cross-source deduplication, confidence-driven merge review, and degraded provider states.",
        "authors": ["Enrico Fontana", "Elena Marino"],
        "affiliations": ["University of Florence", "University of Turin"],
        "venue": "Metadata Engineering Journal",
        "year": 2024,
        "published_at": "2024-01-20",
        "publication_type": "journal",
        "keywords": ["deduplication", "provider fallback", "metadata quality"],
        "topics": ["deduplication", "providers"],
        "canonical_url": "https://example.org/papers/reconciliation",
        "pdf_url": "https://example.org/papers/reconciliation.pdf",
        "external_ids": {"openalex": "W1009"},
        "language": "en",
        "references": ["10.1000/litdisc.2018.003", "10.1000/litdisc.2022.007", "10.1000/litdisc.2023.008"],
        "citations": [],
        "similar": ["10.1000/litdisc.2022.007"],
    },
]


def _normalize(value: str) -> str:
    return " ".join(value.lower().replace("-", " ").split())


def _provider_results() -> Dict[str, Dict[str, Any]]:
    return {record["doi"]: record for record in CATALOG}


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


class BaseProvider:
    capability: ProviderCapability

    def lookup(self, identifier_type: str, value: str) -> Optional[Dict[str, Any]]:
        raise NotImplementedError

    def search(self, query: str) -> List[Dict[str, Any]]:
        raise NotImplementedError

    def relations(self, doi: str) -> Dict[str, List[str]]:
        raise NotImplementedError


class OpenCatalogProvider(BaseProvider):
    capability = ProviderCapability(
        name="open-catalog",
        requires_credentials=False,
        credential_type="none",
        supported_identifiers=["doi", "title", "url"],
        features=["lookup", "search", "authors", "citations", "similarity", "topics"],
        trust_priority=1,
        limitations=["deterministic local fixture", "limited catalog size"],
        absent_credential_behavior="fully available without credentials",
    )

    def __init__(self) -> None:
        self.records = _provider_results()

    def lookup(self, identifier_type: str, value: str) -> Optional[Dict[str, Any]]:
        value_norm = _normalize(value)
        if identifier_type == "doi":
            return self.records.get(value.strip().lower())
        for record in self.records.values():
            if identifier_type == "title" and _normalize(record["title"]) == value_norm:
                return record
            if identifier_type == "url" and value.strip() in {record["canonical_url"], record["pdf_url"]}:
                return record
        return None

    def search(self, query: str) -> List[Dict[str, Any]]:
        query_norm = _normalize(query)
        if not query_norm:
            return []
        matches: List[Dict[str, Any]] = []
        for record in self.records.values():
            haystacks = [
                record["title"],
                record.get("abstract", ""),
                record.get("venue", ""),
                " ".join(record.get("authors", [])),
                " ".join(record.get("keywords", [])),
                " ".join(record.get("topics", [])),
            ]
            if any(query_norm in _normalize(text) for text in haystacks):
                matches.append(record)
        return matches

    def relations(self, doi: str) -> Dict[str, List[str]]:
        record = self.records.get(doi)
        if not record:
            return {"references": [], "citations": [], "similar": []}
        return {
            "references": list(record.get("references", [])),
            "citations": list(record.get("citations", [])),
            "similar": list(record.get("similar", [])),
        }


class PremiumGraphProvider(BaseProvider):
    capability = ProviderCapability(
        name="premium-graph",
        requires_credentials=True,
        credential_type="api_key",
        supported_identifiers=["doi", "title"],
        features=["lookup", "search", "citations", "similarity", "recommendation_enrichment"],
        trust_priority=2,
        limitations=["credential required", "simulated quota state"],
        absent_credential_behavior="recommendation enrichment and extended relations unavailable",
    )

    def __init__(self) -> None:
        self.records = _provider_results()

    def lookup(self, identifier_type: str, value: str) -> Optional[Dict[str, Any]]:
        base = OpenCatalogProvider().lookup(identifier_type, value)
        if not base:
            return None
        enriched = dict(base)
        enriched["metadata_quality_hint"] = "premium_enriched"
        return enriched

    def search(self, query: str) -> List[Dict[str, Any]]:
        return OpenCatalogProvider().search(query)

    def relations(self, doi: str) -> Dict[str, List[str]]:
        return OpenCatalogProvider().relations(doi)


class ProviderRegistry:
    def __init__(self) -> None:
        self.providers: List[BaseProvider] = [PremiumGraphProvider(), OpenCatalogProvider()]

    def docs(self) -> List[Dict[str, Any]]:
        documents = []
        for provider in self.providers:
            cap = provider.capability
            documents.append(
                {
                    "name": cap.name,
                    "data_provided": cap.features,
                    "supported_identifiers": cap.supported_identifiers,
                    "requires_credentials": cap.requires_credentials,
                    "credential_type": cap.credential_type,
                    "known_limitations": cap.limitations,
                    "absent_credential_behavior": cap.absent_credential_behavior,
                    "trust_priority": cap.trust_priority,
                }
            )
        return documents

    def search(self, query: str, credential_states: Dict[str, str]) -> Dict[str, Any]:
        results: List[Dict[str, Any]] = []
        degraded: List[str] = []
        for provider in sorted(self.providers, key=lambda item: item.capability.trust_priority, reverse=True):
            state = credential_states.get(provider.capability.name, "valid")
            if provider.capability.requires_credentials and state != "valid":
                degraded.append(f"{provider.capability.name}: {state}")
                continue
            results.extend(provider.search(query))
        if not results:
            results = OpenCatalogProvider().search(query)
        return {"results": results, "degraded": degraded}

    def lookup(self, identifier_type: str, value: str, credential_states: Dict[str, str]) -> Dict[str, Any]:
        degraded: List[str] = []
        for provider in sorted(self.providers, key=lambda item: item.capability.trust_priority, reverse=True):
            state = credential_states.get(provider.capability.name, "valid")
            if provider.capability.requires_credentials and state != "valid":
                degraded.append(f"{provider.capability.name}: {state}")
                continue
            record = provider.lookup(identifier_type, value)
            if record:
                return {"record": record, "provider": provider.capability.name, "degraded": degraded}
        fallback = OpenCatalogProvider().lookup(identifier_type, value)
        return {"record": fallback, "provider": "open-catalog" if fallback else None, "degraded": degraded}

    def relations(self, doi: str, credential_states: Dict[str, str]) -> Dict[str, Any]:
        degraded: List[str] = []
        for provider in sorted(self.providers, key=lambda item: item.capability.trust_priority, reverse=True):
            state = credential_states.get(provider.capability.name, "valid")
            if provider.capability.requires_credentials and state != "valid":
                degraded.append(f"{provider.capability.name}: {state}")
                continue
            return {"relations": provider.relations(doi), "provider": provider.capability.name, "degraded": degraded}
        return {"relations": OpenCatalogProvider().relations(doi), "provider": "open-catalog", "degraded": degraded}

