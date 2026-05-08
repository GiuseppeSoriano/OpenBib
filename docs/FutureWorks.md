# Future Works

This document tracks planned features and enhancements that have been deferred from the current implementation. When a new future extension is identified, add it here with a brief rationale and design notes.

---

## 1. Intelligent Paper Recommendations

**Status:** Deferred — backend scaffolding exists but the feature is not production-ready.

**Motivation:** Help users discover relevant papers they might have missed, reducing the cold-start problem of building a new research collection.

**Design direction:** Draw inspiration from [Scholar Inbox](https://www.scholar-inbox.com/), which delivers personalised daily digests based on a user's reading history and explicitly rated papers. Key ideas to explore:

- **Citation-neighbourhood similarity** — two papers are considered similar if the research community consistently treats them as related, which shows up in citation patterns in two complementary ways: (1) *bibliographic coupling* — both papers cite many of the same sources, meaning they build on the same prior work; (2) *co-citation* — many third papers cite both of them together, meaning the community groups them in the same intellectual neighbourhood. The more these overlaps accumulate, the higher the similarity score. A foundation for this is already implemented in `backend/app/recommendations/`.
- **Personalised digest** — periodic (e.g., weekly) email or in-app feed of new papers matching the user's inferred interests.
- **Explicit feedback loop** — thumbs-up / thumbs-down ratings on recommendations to continuously improve relevance.
- **Collection-aware filtering** — avoid recommending papers already present in any of the user's collections.
- **Cold-start handling** — fall back to trending/popular papers in the user's detected domain when reading history is sparse.

**Prerequisites before re-introducing the UI:**
- Define and validate a recommendation quality metric.
- Implement at least one feedback mechanism (explicit rating or implicit dwell-time).
- Add pagination and result caching to the recommendations endpoint.
- Write integration tests covering the recommendation pipeline end-to-end.

---

*Add new future extensions below, following the same structure: title, status, motivation, design direction, prerequisites.*
