# Vision & Scope

## 1. Product Vision

**OpenBib** is an academic platform for discovering, organizing, and exploring research papers — designed the way Spotify and YouTube handle music and video: through personal collections, social sharing, intelligent discovery, and visual exploration.

The platform connects researchers and students around papers by combining:

- **Personal collections** (like playlists) that can be private or public
- **Paper discovery** that relates your saved papers to new, relevant ones
- **Graph-based exploration** that visualizes how papers connect through citations, authors, and topics
- **Social features** that let you browse other users' public collections and import them
- **Annotation tools** for notes, highlights, and reading-state tracking visible to collaborators

## 2. Problem Statement

No single existing platform combines all of the following:

1. **Discovery that adapts** — relating your saved papers to new relevant ones, with the ability to dismiss irrelevant suggestions
2. **Graph exploration** — visualizing citation networks, co-authorship, and topical similarity across multiple criteria
3. **Version awareness** — distinguishing preprints, conference papers, journal extensions, and corrections of the same work
4. **Collection-based organization** — creating shareable, playlist-like groupings of papers with read links and account editing permissions
5. **Social browsing** — discovering what other researchers are reading through their public collections
6. **Lean data model** — storing only user-specific data (collections, notes, preferences) while relying on public APIs for paper metadata

Existing tools (Zotero, Mendeley, ResearchRabbit, Connected Papers, Semantic Scholar) each cover some of these, but none integrates them into a single, modern, easy-to-use experience.

## 3. Target Users

| Persona | Needs |
|---------|-------|
| **PhD students** | Literature review, tracking reading progress, discovering foundational and recent works |
| **Postdocs / Researchers** | Staying current in their field, organizing papers by project, sharing with collaborators |
| **Research group leads** | Curating shared collections for the lab, seeing what the team is reading |
| **Curious academics** | Browsing public collections to discover new research areas |

## 4. Product Principles

1. **Simplicity first** — The interface should be clean, modern, and require minimal learning. Core actions (search, save, explore) within 3 clicks.
2. **User-data-only storage** — Public paper metadata is fetched from external APIs (OpenAlex, arXiv, Crossref, Europe PMC) and cached with configurable TTLs. Only user-specific data (collections, notes, preferences, reading states) is persisted in our database.
3. **API-first architecture** — The backend exposes a well-documented REST API. The frontend is a separate SPA that consumes it. Third-party integrations are possible.
4. **Openness** — The platform relies on open-access data providers. No paywalled data sources are required for core functionality.
5. **Graceful degradation** — When an external provider is unavailable, the platform degrades explicitly (clear messages, no silent data loss) while user data remains fully accessible.
6. **Explainability** — Every recommendation or connection shown to the user includes a human-readable reason (e.g., "Cited by 3 papers in your collection").

## 5. Core Analogies

| Platform concept | Analogy |
|-----------------|---------|
| **Collection** | Spotify playlist / YouTube playlist |
| **Public collection** | Public playlist anyone can browse and import |
| **Paper discovery** | "Discover Weekly" / recommended videos |
| **Graph explorer** | Interactive network map of related content |
| **Reading states** | "Liked", "Watch Later", "Already Watched" |
| **Notes & highlights** | Shared comments on a collaborative playlist |
| **Following an author** | Subscribing to a channel |

## 6. MVP Scope

### In scope (MVP)

- User registration, login, logout, password recovery, profile management
- Collection CRUD with revocable read links and account editors
- Add papers by DOI, title, URL, or from search results
- Bibliographic search across multiple providers with filters and ordering
- Duplicate detection and version distinction (preprint vs. journal, etc.)
- Interactive graph exploration (citations, authors, topics, similarity)
- Paper recommendations from seed papers, collections, and user feedback
- Reading states (unseen, saved, to-read, reading, read, important, ignored, excluded)
- Custom tags per paper
- Notes on papers, collections, and authors
- Collaboration: invite members with roles (owner / editor / viewer)
- Browse and import other users' public collections
- Import papers from DOI lists and BibTeX files; export collections
- Provider integration with OpenAlex, arXiv, Crossref, and Europe PMC
- Configurable caching with per-provider, per-query-type TTLs

### Deferred (post-MVP)

- Timeline / temporal evolution visualization
- Activity feed and notification system
- Advanced personalization engine (implicit signals, profile attenuation, feedback-loop control)
- Full audit trail and activity history
- Identity federation (OAuth with Google, ORCID, institutional SSO)
- Admin dashboard and moderation tools
- Sync with external reference managers (Zotero, Mendeley)
- Mobile-native applications

## 7. Success Criteria

1. A user can register, create a collection, add papers by DOI or search, and see a graph of their connections — within a single session.
2. Recommendations surface at least 5 relevant papers from a 3-paper seed collection.
3. A second user can browse the first user's public collection, import it, and add their own notes.
4. The system remains usable when one external provider is down (graceful degradation).
5. Cached API responses reduce redundant calls by ≥90% within their TTL window.

Current implemented sharing contract: [Collection sharing](../Architecture/CollectionSharing.md).
