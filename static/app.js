const byId = (id) => document.getElementById(id);

const DEMO_PASSWORD = "Preview2026Demo";
const DEMO_NAME = "Frontend Preview";
const DEMO_STORAGE_KEY = "reference-manager-demo-email";

const state = {
  bootstrap: null,
  system: null,
  activeCollection: null,
  activePaper: null,
  activeRelations: null,
  activePaperMode: "empty",
  demoCredentials: null,
  workspacePapers: [],
  search: {
    query: "",
    local: [],
    external: [],
    degraded: [],
  },
  graphOpsMessage: "Nessuna operazione sul grafo eseguita.",
  graphOpsTone: "success",
};

const CITATION_PAGE_SIZE = 10;

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    credentials: "same-origin",
    ...options,
  });
  if (response.status === 204) {
    return null;
  }
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload.error || "Request failed");
  }
  return payload;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function formValues(form) {
  return Object.fromEntries(new FormData(form).entries());
}

function numberOrNull(value) {
  return value ? Number(value) : null;
}

function setOutput(target, payload) {
  target.textContent = JSON.stringify(payload, null, 2);
}

function truncate(value, limit = 220) {
  if (!value) {
    return "";
  }
  return value.length > limit ? `${value.slice(0, limit).trim()}...` : value;
}

function joinAuthors(paper) {
  if (Array.isArray(paper.authors) && paper.authors.length) {
    return paper.authors.join(", ");
  }
  if (Array.isArray(paper.author_details) && paper.author_details.length) {
    return paper.author_details
      .map((author) => author.name)
      .filter(Boolean)
      .join(", ");
  }
  return "Autori non disponibili";
}

function providerName(paper) {
  if (paper.provider) {
    return paper.provider;
  }
  const rawSource = Array.isArray(paper.raw_sources) ? paper.raw_sources[0] : null;
  const source = Array.isArray(paper.sources) ? paper.sources[0] : null;
  return rawSource?.provider || source?.provider || "workspace";
}

function metaChip(label) {
  return `<span class="meta-chip">${escapeHtml(label)}</span>`;
}

function userContextBadges(paper, { activeCollectionId = null } = {}) {
  const context = paper.user_context || {};
  const badges = [];
  if (context.saved_by_user) {
    badges.push(metaChip("Salvato in libreria"));
  } else if (context.discovery_id) {
    badges.push(metaChip("Solo discovery"));
  }
  if (context.in_collections_count) {
    badges.push(metaChip(`${context.in_collections_count} collezioni`));
  }
  if (activeCollectionId && Array.isArray(context.collection_ids) && context.collection_ids.includes(activeCollectionId)) {
    badges.push(metaChip("Nella collezione attiva"));
  }
  if (context.is_hidden) {
    badges.push(metaChip("Nascosto"));
  }
  if (context.is_excluded) {
    badges.push(metaChip("Escluso"));
  }
  return badges.join("");
}

function relationSectionEmpty(direction) {
  return direction === "references"
    ? "Nessuna reference disponibile dai provider per questo paper."
    : "Nessuna citation disponibile dai provider per questo paper.";
}

function mergeRelationsPayload(current, incoming) {
  const currentCitations = current?.citations;
  const incomingCitations = incoming.citations;
  let mergedCitations = incomingCitations || currentCitations || null;
  if (currentCitations && incomingCitations) {
    const incomingPage = incomingCitations.pagination?.page || 1;
    if (incomingPage > 1) {
      const seen = new Set();
      const mergedItems = [...(currentCitations.items || []), ...(incomingCitations.items || [])].filter((item) => {
        const key = item.paper?.id || item.paper?.doi || item.paper?.title;
        if (!key || seen.has(key)) {
          return false;
        }
        seen.add(key);
        return true;
      });
      mergedCitations = { ...incomingCitations, items: mergedItems };
    }
  }
  return {
    paper_id: incoming.paper_id || current?.paper_id || null,
    cache_hit: incoming.cache_hit ?? current?.cache_hit ?? false,
    refreshed: incoming.refreshed || current?.refreshed || [],
    degraded: incoming.degraded || current?.degraded || [],
    references: incoming.references || current?.references || null,
    citations: mergedCitations,
  };
}

function setGraphFeedback(message, tone = "success") {
  state.graphOpsMessage = message;
  state.graphOpsTone = tone;
  const target = byId("graph-ops-feedback");
  if (!target) {
    return;
  }
  target.textContent = message;
  target.className = `feedback-area ${tone}`;
}

function renderCards(target, items, renderItem, emptyMessage) {
  target.innerHTML = "";
  if (!items || !items.length) {
    target.innerHTML = `<div class="paper-card"><p class="empty-copy">${escapeHtml(emptyMessage)}</p></div>`;
    return;
  }
  for (const item of items) {
    const node = document.createElement("article");
    node.innerHTML = renderItem(item);
    target.appendChild(node.firstElementChild);
  }
}

function updateSessionStatus(message, tone = "warning", detail = "") {
  const status = byId("session-status");
  status.textContent = message;
  status.className = `status-line ${tone}`;
  byId("session-subtext").textContent = detail;
}

function demoCandidateEmails() {
  const stored = window.localStorage.getItem(DEMO_STORAGE_KEY);
  const candidates = [];
  if (stored) {
    candidates.push(stored);
  }
  candidates.push("demo.preview@reference-manager.test");
  for (let index = 1; index <= 6; index += 1) {
    candidates.push(`demo.preview.${index}@reference-manager.test`);
  }
  return [...new Set(candidates)];
}

async function loginDemoUser(email) {
  await api("/api/login", {
    method: "POST",
    body: JSON.stringify({
      email,
      password: DEMO_PASSWORD,
    }),
  });
  window.localStorage.setItem(DEMO_STORAGE_KEY, email);
  state.demoCredentials = { email, password: DEMO_PASSWORD };
}

async function registerDemoUser(email) {
  await api("/api/register", {
    method: "POST",
    body: JSON.stringify({
      email,
      password: DEMO_PASSWORD,
      display_name: DEMO_NAME,
    }),
  });
  window.localStorage.setItem(DEMO_STORAGE_KEY, email);
  state.demoCredentials = { email, password: DEMO_PASSWORD };
}

async function ensureDemoSession(forceReset = false) {
  if (forceReset) {
    try {
      await api("/api/logout", { method: "POST", body: "{}" });
    } catch (_error) {
      // Ignore missing session during reset.
    }
  }

  const candidates = demoCandidateEmails();
  const bootstrap = await api("/api/bootstrap");
  if (bootstrap.me && candidates.includes(bootstrap.me.email) && !forceReset) {
    state.demoCredentials = {
      email: bootstrap.me.email,
      password: DEMO_PASSWORD,
    };
    return bootstrap;
  }

  if (bootstrap.me) {
    await api("/api/logout", { method: "POST", body: "{}" });
  }

  let lastError = null;
  for (const email of candidates) {
    try {
      await registerDemoUser(email);
      return await api("/api/bootstrap");
    } catch (error) {
      if (!error.message.includes("gia registrata")) {
        lastError = error;
      }
    }
    try {
      await loginDemoUser(email);
      return await api("/api/bootstrap");
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error("Impossibile inizializzare la sessione demo.");
}

async function fetchWorkspace() {
  const [system, bootstrap] = await Promise.all([
    api("/api/system"),
    api("/api/bootstrap"),
  ]);
  state.system = system;
  state.bootstrap = bootstrap;

  if (!state.bootstrap.me) {
    throw new Error("Sessione demo non disponibile.");
  }

  const papersPayload = await api("/api/papers");
  state.workspacePapers = papersPayload.papers || [];

  const existingIds = new Set((state.bootstrap.collections || []).map((collection) => collection.id));
  if (!existingIds.has(state.activeCollection?.id)) {
    const preferred = state.bootstrap.collections?.[0] || null;
    state.activeCollection = preferred ? { id: preferred.id } : null;
  }

  await refreshActiveCollection();
  renderAll();
}

async function loadPaperRelations(paperId, { direction = "all", forceRefresh = false } = {}) {
  const params = new URLSearchParams();
  params.set("direction", direction);
  params.set("citation_page_size", String(CITATION_PAGE_SIZE));
  if (forceRefresh) {
    params.set("refresh", "1");
  }
  const payload = await api(`/api/papers/${paperId}/relations?${params.toString()}`);
  if (state.activePaper?.id !== paperId) {
    return payload;
  }
  state.activeRelations = mergeRelationsPayload(state.activeRelations, payload);
  renderPaperDetail();
  return payload;
}

async function loadMoreCitations() {
  if (!state.activePaper?.id || state.activePaperMode !== "local") {
    return;
  }
  const nextPage = (state.activeRelations?.citations?.pagination?.page || 1) + 1;
  const params = new URLSearchParams();
  params.set("direction", "citations");
  params.set("citation_page", String(nextPage));
  params.set("citation_page_size", String(CITATION_PAGE_SIZE));
  const payload = await api(`/api/papers/${state.activePaper.id}/relations?${params.toString()}`);
  if (state.activePaper?.id !== payload.paper_id) {
    return;
  }
  state.activeRelations = mergeRelationsPayload(state.activeRelations, payload);
  renderPaperDetail();
}

async function refreshActiveCollection() {
  if (!state.activeCollection?.id) {
    state.activeCollection = null;
    return;
  }
  const payload = await api(`/api/collections/${state.activeCollection.id}`);
  state.activeCollection = payload.collection;
}

function renderStats() {
  const counts = state.system?.counts || {};
  const items = [
    { label: "Utenti", value: counts.users ?? 0 },
    { label: "Collezioni", value: counts.collections ?? 0 },
    { label: "Paper in libreria", value: counts.library_entries ?? 0 },
    { label: "Paper catalogo", value: counts.catalog_papers ?? 0 },
    { label: "Cache discovery", value: counts.discovery_cache ?? 0 },
    { label: "Notifiche", value: counts.notifications ?? 0 },
  ];
  byId("stats-grid").innerHTML = items
    .map(
      (item) => `
        <div class="stat-card">
          <strong>${escapeHtml(item.value)}</strong>
          <span>${escapeHtml(item.label)}</span>
        </div>
      `,
    )
    .join("");
}

function renderCollections() {
  const collections = state.bootstrap?.collections || [];
  renderCards(
    byId("collections-list"),
    collections,
    (collection) => `
      <article class="collection-card ${collection.id === state.activeCollection?.id ? "active" : ""}">
        <div class="collection-top">
          <div>
            <h3 class="collection-title">${escapeHtml(collection.name)}</h3>
            <p class="card-copy">${escapeHtml(collection.description || "Nessuna descrizione")}</p>
          </div>
          ${metaChip(`#${collection.id}`)}
        </div>
        <div class="card-meta">
          ${metaChip(collection.visibility)}
          ${metaChip(collection.status)}
          ${metaChip(`Agg. ${collection.updated_at || "n/a"}`)}
        </div>
        <button class="action-button secondary" type="button" data-action="select-collection" data-collection-id="${collection.id}">
          Apri collezione
        </button>
      </article>
    `,
    "Crea la prima collezione per iniziare a salvare articoli.",
  );

  const options = collections
    .map((collection) => `<option value="${collection.id}">${escapeHtml(collection.name)}</option>`)
    .join("");
  byId("search-collection-id").innerHTML = `<option value="">Tutto il workspace</option>${options}`;

  if (state.activeCollection?.id) {
    byId("search-collection-id").value = String(state.activeCollection.id);
  }
}

function renderActiveCollection() {
  const heading = byId("active-collection-name");
  const meta = byId("active-collection-meta");
  const description = byId("active-collection-description");
  const refreshButton = byId("refresh-collection-graph");

  if (!state.activeCollection) {
    refreshButton.disabled = true;
    heading.textContent = "Seleziona una collezione";
    meta.innerHTML = "";
    description.textContent = "I paper salvati nella collezione selezionata compariranno qui.";
    renderCards(
      byId("collection-paper-list"),
      [],
      () => "",
      "Nessuna collezione attiva.",
    );
    return;
  }

  refreshButton.disabled = false;
  heading.textContent = state.activeCollection.name;
  description.textContent = state.activeCollection.description || "Collezione pronta per ricevere articoli dal backend.";
  meta.innerHTML = [
    metaChip(state.activeCollection.visibility),
    metaChip(state.activeCollection.status),
    metaChip(`${state.activeCollection.papers.length} paper in collezione`),
  ].join("");

  renderCards(
    byId("collection-paper-list"),
    state.activeCollection.papers || [],
    (paper) => renderPaperCard(paper, { mode: "local", compact: true }),
    "Questa collezione non contiene ancora articoli.",
  );
}

function renderWorkspacePapers() {
  const papers = state.workspacePapers || [];
  const collectionPaperIds = new Set((state.activeCollection?.papers || []).map((paper) => paper.id));
  byId("workspace-paper-meta").innerHTML = [
    metaChip(`${papers.length} paper salvati in libreria`),
    state.activeCollection ? metaChip(`${collectionPaperIds.size} presenti nella collezione aperta`) : metaChip("Nessuna collezione selezionata"),
  ].join("");

  renderCards(
    byId("workspace-paper-list"),
    papers,
    (paper) => `
      <article class="paper-card ${collectionPaperIds.has(paper.id) ? "paper-card-highlight" : ""}">
        <div class="paper-top">
          <div>
            <h3 class="paper-title">${escapeHtml(paper.title || "Titolo non disponibile")}</h3>
            <p class="paper-copy">${escapeHtml(truncate(paper.abstract || paper.metadata?.quality_note || "Metadati essenziali disponibili.", 180))}</p>
          </div>
          ${metaChip(`#${paper.id}`)}
        </div>
        <div class="card-meta">
          ${metaChip(paper.venue || "Venue n/a")}
          ${metaChip(paper.year || "Anno n/a")}
          ${metaChip(joinAuthors(paper))}
        </div>
        <div class="card-meta">
          ${paper.doi ? metaChip(`DOI ${paper.doi}`) : ""}
          ${userContextBadges(paper, { activeCollectionId: state.activeCollection?.id || null })}
          ${metaChip(providerName(paper))}
        </div>
        <button class="action-button secondary" type="button" data-action="open-paper" data-paper-id="${paper.id}">
          Apri dettaglio
        </button>
      </article>
    `,
    "Nessun paper salvato in libreria.",
  );
}

function renderRelationItems(items, emptyMessage) {
  if (!items.length) {
    return `<div class="relation-empty">${escapeHtml(emptyMessage)}</div>`;
  }
  return items
    .map(
      (item) => `
        <article class="relation-card">
          <div class="relation-top">
            <div>
              <h4>${escapeHtml(item.paper.title || "Titolo non disponibile")}</h4>
              <p>${escapeHtml(item.paper.venue || "Venue n/d")} · ${escapeHtml(item.paper.year || "Anno n/d")}</p>
            </div>
            ${metaChip(item.edge.state)}
          </div>
          <div class="card-meta">
            ${item.paper.doi ? metaChip(`DOI ${item.paper.doi}`) : ""}
            ${metaChip(`evidenze ${item.edge.evidence_count}`)}
            ${(item.edge.providers || []).map((provider) => metaChip(provider)).join("")}
          </div>
          <p class="relation-copy">${escapeHtml(item.edge.explanation || "Relazione persistita nel grafo locale.")}</p>
          <div class="actions-row">
            <button class="action-button secondary" type="button" data-action="open-paper" data-paper-id="${item.paper.id}">
              Apri paper
            </button>
          </div>
        </article>
      `,
    )
    .join("");
}

function renderCoverageBadges(coverage) {
  if (!coverage?.length) {
    return '<p class="muted-copy">Copertura provider non ancora disponibile.</p>';
  }
  return `
    <div class="card-meta">
      ${coverage
        .map((item) => {
          const suffix = item.count ? ` ${item.count}` : "";
          return `<span class="meta-chip source-badge source-${escapeHtml(item.status)}">${escapeHtml(item.provider)}${escapeHtml(suffix)}</span>`;
        })
        .join("")}
    </div>
  `;
}

function renderPaperCard(paper, { mode, compact = false, index = null } = {}) {
  const abstract = paper.abstract || paper.metadata?.quality_note || "Metadati essenziali disponibili.";
  const actions =
    mode === "external"
      ? `
          <div class="actions-row">
            <button class="action-button secondary" type="button" data-action="preview-external" data-result-index="${index}">
              Anteprima
            </button>
            ${
              paper.user_context?.saved_by_user && paper.persisted_paper_id
                ? `<button class="ghost" type="button" data-action="open-paper" data-paper-id="${paper.persisted_paper_id}">Apri salvato</button>`
                : ""
            }
          </div>
        `
      : `
          <button class="action-button secondary" type="button" data-action="open-paper" data-paper-id="${paper.id}">
            Apri dettaglio
          </button>
        `;

  return `
    <article class="paper-card">
      <div class="paper-top">
        <div>
          <h3 class="paper-title">${escapeHtml(paper.title || "Titolo non disponibile")}</h3>
          <p class="paper-copy">${escapeHtml(truncate(abstract, compact ? 160 : 240))}</p>
        </div>
        ${metaChip(mode === "external" ? providerName(paper) : `#${paper.id}`)}
      </div>
      <div class="card-meta">
        ${metaChip(paper.venue || "Venue n/a")}
        ${metaChip(paper.year || "Anno n/a")}
        ${metaChip(joinAuthors(paper) || "Autori n/a")}
      </div>
      <div class="card-meta">
        ${paper.quality_state ? metaChip(paper.quality_state) : ""}
        ${paper.reliability_state ? metaChip(paper.reliability_state) : ""}
        ${paper.doi ? metaChip(`DOI ${paper.doi}`) : ""}
      </div>
      <div class="card-meta">
        ${userContextBadges(paper, { activeCollectionId: state.activeCollection?.id || null })}
      </div>
      ${actions}
    </article>
  `;
}

function renderSearchResults() {
  byId("local-results-count").textContent = String(state.search.local.length);
  byId("external-results-count").textContent = String(state.search.external.length);

  renderCards(
    byId("search-results-local"),
    state.search.local,
    (paper) => renderPaperCard(paper, { mode: "local" }),
    "Nessun articolo locale trovato per questa query.",
  );

  renderCards(
    byId("search-results-external"),
    state.search.external.map((paper, index) => ({ ...paper, _index: index })),
    (paper) => renderPaperCard(paper, { mode: "external", index: paper._index }),
    "Nessun articolo remoto restituito dai provider.",
  );

  const degraded = state.search.degraded || [];
  const summary = [];
  if (state.search.query) {
    summary.push(`Query attiva: "${state.search.query}"`);
  }
  if (degraded.length) {
    summary.push(`Note provider: ${degraded.join(" · ")}`);
  }
  const feedback = byId("search-feedback");
  feedback.textContent = summary.join(" | ");
  feedback.className = `feedback-area ${degraded.length ? "warning" : "success"}`;
}

function renderDemoCredentials() {
  const credentials = state.demoCredentials;
  if (!credentials) {
    byId("demo-credentials").textContent = "Credenziali demo non ancora inizializzate.";
    return;
  }
  byId("demo-credentials").innerHTML = `
    <strong>Email:</strong> ${escapeHtml(credentials.email)}<br>
    <strong>Password:</strong> ${escapeHtml(credentials.password)}
  `;
}

function renderActivityList(items, emptyMessage) {
  renderCards(
    byId("activity-list"),
    items || [],
    (item) => `
      <article class="activity-card">
        <div class="activity-top">
          <h3 class="activity-title">${escapeHtml(item.title || item.kind || item.event_type || "Evento")}</h3>
          ${metaChip(item.created_at || item.collection_id || item.paper_id || "live")}
        </div>
        <p class="activity-copy">${escapeHtml(item.message || item.explanation || item.summary || "Nessun dettaglio aggiuntivo.")}</p>
      </article>
    `,
    emptyMessage,
  );
}

function renderPaperDetail() {
  const target = byId("paper-detail");
  if (!state.activePaper) {
    target.className = "detail-panel empty-state";
    target.textContent = "Seleziona un paper salvato o un risultato di discovery per vedere i metadati completi.";
    return;
  }

  const paper = state.activePaper;
  const topics = paper.topics || paper.metadata?.topics || [];
  const keywords = paper.metadata?.keywords || [];
  const sources = paper.sources || paper.raw_sources || [];
  const notes = paper.notes || [];
  const relations = paper.relations || [];
  const liveRelations = state.activeRelations || {};
  const referencesSnapshot = liveRelations.references;
  const citationsSnapshot = liveRelations.citations;
  const graph = {
    references: referencesSnapshot?.items || [],
    citations: citationsSnapshot?.items || [],
    summary: {
      references: referencesSnapshot?.summary?.count || 0,
      citations: citationsSnapshot?.summary?.count || 0,
      retrieved_references: referencesSnapshot?.summary?.retrieved || 0,
      retrieved_citations: citationsSnapshot?.summary?.retrieved || 0,
      inferred_references: referencesSnapshot?.summary?.inferred || 0,
      inferred_citations: citationsSnapshot?.summary?.inferred || 0,
      incomplete_references: referencesSnapshot?.summary?.incomplete || 0,
      incomplete_citations: citationsSnapshot?.summary?.incomplete || 0,
    },
  };
  const isLocal = state.activePaperMode === "local";
  const userContext = paper.user_context || {};
  const relationNotes = [
    referencesSnapshot?.fetched_at ? `references ${referencesSnapshot.stale ? "stale" : "fresh"} @ ${referencesSnapshot.fetched_at}` : null,
    citationsSnapshot?.fetched_at ? `citations ${citationsSnapshot.stale ? "stale" : "fresh"} @ ${citationsSnapshot.fetched_at}` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  const degradedNotes = (liveRelations.degraded || []).join(" · ");
  target.className = "detail-panel";
  target.innerHTML = `
    <div class="detail-top">
      <div>
        <h3 class="detail-title">${escapeHtml(paper.title || "Titolo non disponibile")}</h3>
        <p class="detail-meta">${escapeHtml(joinAuthors(paper))}</p>
      </div>
      ${metaChip(state.activePaperMode === "external" ? "Preview API" : `Paper #${paper.id}`)}
    </div>

    ${
      !isLocal
        ? `
          <div class="actions-row detail-actions">
            ${
              userContext.saved_by_user && paper.persisted_paper_id
                ? `<button class="ghost" type="button" data-action="open-paper" data-paper-id="${paper.persisted_paper_id}">Apri versione salvata</button>`
                : `<button class="ghost" type="button" data-action="save-discovery" data-discovery-id="${paper.discovery_id}">Salva in libreria</button>`
            }
            ${
              !userContext.saved_by_user && state.activeCollection?.id
                ? `<button class="ghost" type="button" data-action="save-discovery-to-collection" data-discovery-id="${paper.discovery_id}" data-collection-id="${state.activeCollection.id}">Salva nella collezione attiva</button>`
                : ""
            }
          </div>
        `
        : `
          <div class="actions-row detail-actions">
            <button class="ghost" type="button" data-action="refresh-paper-graph" data-mode="references">Refresh references</button>
            <button class="ghost" type="button" data-action="refresh-paper-graph" data-mode="citations">Refresh citations</button>
            <button class="ghost" type="button" data-action="expand-paper-graph">Espandi 1 hop</button>
          </div>
        `
    }

    <div class="detail-tags">
      ${userContextBadges(paper, { activeCollectionId: state.activeCollection?.id || null })}
    </div>

    <div class="detail-tags">
      ${paper.venue ? metaChip(paper.venue) : ""}
      ${paper.year ? metaChip(paper.year) : ""}
      ${paper.publication_type ? metaChip(paper.publication_type) : ""}
      ${paper.language ? metaChip(paper.language) : ""}
      ${paper.quality_state ? metaChip(paper.quality_state) : ""}
      ${paper.reliability_state ? metaChip(paper.reliability_state) : ""}
    </div>

    <p class="detail-abstract">${escapeHtml(paper.abstract || paper.metadata?.quality_note || "Nessun abstract disponibile.")}</p>

    <div class="detail-section">
      <h3>Metadati</h3>
      <p>DOI: ${escapeHtml(paper.doi || "n/d")}</p>
      <p>Provider principale: ${escapeHtml(providerName(paper))}</p>
      <p>Keywords: ${escapeHtml(keywords.join(", ") || "n/d")}</p>
      <p>Topics: ${escapeHtml(topics.map((topic) => topic.label || topic).join(", ") || "n/d")}</p>
    </div>

    <div class="detail-section">
      <h3>Sorgenti</h3>
      <ul>
        ${
          sources.length
            ? sources
                .slice(0, 6)
                .map(
                  (source) => `<li>${escapeHtml(source.provider || "source")} · ${escapeHtml(source.source_url || source.provider_paper_id || "n/d")}</li>`,
                )
                .join("")
            : "<li>Nessuna sorgente registrata.</li>"
        }
      </ul>
    </div>

    <div class="detail-section">
      <h3>Relazioni e note</h3>
      <p>Relazioni note: ${escapeHtml(relations.length)}</p>
      <p>Note salvate: ${escapeHtml(notes.length)}</p>
      ${relationNotes ? `<p>Snapshot live: ${escapeHtml(relationNotes)}</p>` : ""}
      ${degradedNotes ? `<p>Note provider: ${escapeHtml(degradedNotes)}</p>` : ""}
      ${
        isLocal
          ? `
            <div class="detail-tags">
              ${metaChip(`references ${graph.summary?.references || 0}`)}
              ${metaChip(`citations ${graph.summary?.citations || 0}`)}
              ${metaChip(`retrieved ${((graph.summary?.retrieved_references || 0) + (graph.summary?.retrieved_citations || 0))}`)}
              ${metaChip(`inferred ${((graph.summary?.inferred_references || 0) + (graph.summary?.inferred_citations || 0))}`)}
              ${metaChip(`incomplete ${((graph.summary?.incomplete_references || 0) + (graph.summary?.incomplete_citations || 0))}`)}
            </div>
          `
          : ""
      }
    </div>

    ${
      isLocal
        ? `
          <div class="detail-section">
            <h3>References</h3>
            <p class="muted-copy">${escapeHtml((referencesSnapshot?.sources_used || []).join(", ") || "Provider non ancora interrogati.")}</p>
            ${renderCoverageBadges(referencesSnapshot?.coverage)}
            <div class="relation-list">
              ${renderRelationItems(graph.references || [], relationSectionEmpty("references"))}
            </div>
          </div>

          <div class="detail-section">
            <h3>Citations</h3>
            <p class="muted-copy">${escapeHtml((citationsSnapshot?.sources_used || []).join(", ") || "Provider non ancora interrogati.")}</p>
            ${renderCoverageBadges(citationsSnapshot?.coverage)}
            <div class="relation-list">
              ${renderRelationItems(graph.citations || [], relationSectionEmpty("citations"))}
            </div>
            ${
              citationsSnapshot?.pagination?.has_next
                ? `
                  <div class="actions-row">
                    <button class="ghost" type="button" data-action="load-more-citations">
                      Carica altre citations (${citationsSnapshot.pagination.total_items})
                    </button>
                  </div>
                `
                : ""
            }
          </div>
        `
        : ""
    }

    <div class="detail-links">
      ${paper.canonical_url ? `<a href="${escapeHtml(paper.canonical_url)}" target="_blank" rel="noreferrer">Apri record</a>` : ""}
      ${paper.pdf_url ? `<a href="${escapeHtml(paper.pdf_url)}" target="_blank" rel="noreferrer">Apri PDF</a>` : ""}
      ${paper.doi ? `<a href="https://doi.org/${encodeURIComponent(paper.doi)}" target="_blank" rel="noreferrer">Vai al DOI</a>` : ""}
    </div>
  `;
}

function renderAll() {
  const me = state.bootstrap?.me;
  updateSessionStatus(
    me ? `Sessione demo attiva per ${me.display_name}` : "Sessione demo assente",
    me ? "success" : "warning",
    me ? "Il login reale è nascosto: il frontend riusa automaticamente account di test." : "Verifica connessione backend e cookie di sessione.",
  );
  renderDemoCredentials();
  renderStats();
  renderCollections();
  renderActiveCollection();
  renderWorkspacePapers();
  renderSearchResults();
  renderPaperDetail();
  renderActivityList(state.bootstrap?.feed || [], "Nessuna activity disponibile nel feed.");
  setGraphFeedback(state.graphOpsMessage, state.graphOpsTone);
}

async function loadPaper(paperId) {
  const payload = await api(`/api/papers/${paperId}`);
  state.activePaper = payload.paper;
  state.activeRelations = null;
  state.activePaperMode = "local";
  renderPaperDetail();
  await loadPaperRelations(payload.paper.id);
}

async function selectCollection(collectionId) {
  state.activeCollection = { id: Number(collectionId) };
  await refreshActiveCollection();
  renderCollections();
  renderActiveCollection();
  renderWorkspacePapers();
}

async function refreshPaperGraph(mode) {
  if (!state.activePaper?.id || state.activePaperMode !== "local") {
    return;
  }
  const payload = await loadPaperRelations(state.activePaper.id, { direction: mode, forceRefresh: true });
  await fetchWorkspace();
  await loadPaper(state.activePaper.id);
  setGraphFeedback(
    `Refresh ${mode} completato per il paper #${state.activePaper.id}.`,
    payload.degraded?.length ? "warning" : "success",
  );
}

async function expandActivePaperGraph() {
  if (!state.activePaper?.id || state.activePaperMode !== "local") {
    return;
  }
  const paperId = state.activePaper.id;
  const payload = await api("/api/papers/expand", {
    method: "POST",
    body: JSON.stringify({
      paper_id: paperId,
      depth: 1,
      directions: ["references", "citations"],
      max_nodes: 50,
      force_refresh: true,
      rebuild: false,
    }),
  });
  await fetchWorkspace();
  await loadPaper(paperId);
  setGraphFeedback(
    `Espansione completata: ${payload.expanded_nodes} nodi aggiornati, ${payload.reachable_papers} paper raggiungibili.`,
    payload.degraded?.length ? "warning" : "success",
  );
}

async function refreshActiveCollectionGraph() {
  if (!state.activeCollection?.id) {
    return;
  }
  const payload = await api("/api/collections/refresh", {
    method: "POST",
    body: JSON.stringify({
      collection_id: state.activeCollection.id,
      mode: "all",
      force_refresh: true,
      rebuild: true,
    }),
  });
  await fetchWorkspace();
  setGraphFeedback(
    `Refresh collezione completato: ${payload.stats.refreshed_papers} paper aggiornati.`,
    payload.degraded?.length ? "warning" : "success",
  );
}

async function handleSearch(event) {
  event.preventDefault();
  const values = formValues(event.target);
  const params = new URLSearchParams();
  params.set("q", values.q);
  if (values.collection_id) {
    params.set("collection_id", values.collection_id);
  }

  const result = await api(`/api/search?${params.toString()}`);
  state.search = {
    query: values.q,
    local: result.results || [],
    external: result.external_results || [],
    degraded: result.degraded || [],
  };
  if (state.search.local[0]) {
    await loadPaper(state.search.local[0].id);
  } else if (state.search.external[0]) {
    state.activePaper = state.search.external[0];
    state.activeRelations = null;
    state.activePaperMode = "external";
    renderPaperDetail();
  } else {
    state.activePaper = null;
    state.activeRelations = null;
    state.activePaperMode = "empty";
  }
  renderSearchResults();
  renderPaperDetail();
}

async function saveDiscoveryPaper(discoveryId, collectionId = null) {
  const payload = await api("/api/papers/save", {
    method: "POST",
    body: JSON.stringify({
      discovery_id: Number(discoveryId),
      collection_id: collectionId ? Number(collectionId) : null,
    }),
  });
  await fetchWorkspace();
  await loadPaper(payload.paper.id);
  setGraphFeedback(
    collectionId ? "Paper salvato in libreria e aggiunto alla collezione attiva." : "Paper salvato in libreria.",
    "success",
  );
}

async function handleCollectionCreate(event) {
  event.preventDefault();
  const values = formValues(event.target);
  await api("/api/collections", {
    method: "POST",
    body: JSON.stringify(values),
  });
  event.target.reset();
  await fetchWorkspace();
}

async function handleActivity(kind) {
  if (kind === "feed") {
    const payload = await api("/api/feed");
    renderActivityList(payload.items || [], "Feed vuoto.");
    setOutput(byId("ops-output"), payload);
    return;
  }
  if (kind === "notifications") {
    const payload = await api("/api/notifications");
    renderActivityList(payload.notifications || [], "Nessuna notifica.");
    setOutput(byId("ops-output"), payload);
    return;
  }
  if (kind === "audit") {
    const payload = await api("/api/audit");
    renderActivityList(payload.events || [], "Audit log vuoto.");
    setOutput(byId("ops-output"), payload);
  }
}

async function initialize(forceReset = false) {
  updateSessionStatus("Connessione al backend in corso.", "warning", "Sto inizializzando la sessione demo e caricando i dati del workspace.");
  const refreshButton = byId("refresh-workspace");
  const resetButton = byId("reset-demo");
  refreshButton.disabled = true;
  resetButton.disabled = true;
  try {
    await ensureDemoSession(forceReset);
    await fetchWorkspace();
  } catch (error) {
    updateSessionStatus("Backend non pronto o sessione demo non inizializzabile.", "danger", error.message);
    byId("demo-credentials").textContent = "Nessuna credenziale demo disponibile.";
  } finally {
    refreshButton.disabled = false;
    resetButton.disabled = false;
  }
}

byId("collection-form").addEventListener("submit", (event) => {
  handleCollectionCreate(event).catch((error) => {
    alert(error.message);
  });
});

byId("search-form").addEventListener("submit", (event) => {
  handleSearch(event).catch((error) => {
    alert(error.message);
  });
});

byId("refresh-workspace").addEventListener("click", () => {
  initialize(false).catch((error) => {
    alert(error.message);
  });
});

byId("reset-demo").addEventListener("click", () => {
  initialize(true).catch((error) => {
    alert(error.message);
  });
});

byId("load-feed").addEventListener("click", () => {
  handleActivity("feed").catch((error) => {
    alert(error.message);
  });
});

byId("load-notifications").addEventListener("click", () => {
  handleActivity("notifications").catch((error) => {
    alert(error.message);
  });
});

byId("load-audit").addEventListener("click", () => {
  handleActivity("audit").catch((error) => {
    alert(error.message);
  });
});

byId("refresh-collection-graph").addEventListener("click", () => {
  refreshActiveCollectionGraph().catch((error) => {
    alert(error.message);
  });
});

document.addEventListener("click", (event) => {
  const actionTarget = event.target.closest("[data-action]");
  if (!actionTarget) {
    return;
  }
  const action = actionTarget.dataset.action;
  if (action === "select-collection") {
    selectCollection(actionTarget.dataset.collectionId).catch((error) => alert(error.message));
    return;
  }
  if (action === "open-paper") {
    loadPaper(actionTarget.dataset.paperId).catch((error) => alert(error.message));
    return;
  }
  if (action === "refresh-paper-graph") {
    refreshPaperGraph(actionTarget.dataset.mode).catch((error) => alert(error.message));
    return;
  }
  if (action === "expand-paper-graph") {
    expandActivePaperGraph().catch((error) => alert(error.message));
    return;
  }
  if (action === "load-more-citations") {
    loadMoreCitations().catch((error) => alert(error.message));
    return;
  }
  if (action === "preview-external") {
    const paper = state.search.external[Number(actionTarget.dataset.resultIndex)];
    if (!paper) {
      return;
    }
    state.activePaper = paper;
    state.activeRelations = null;
    state.activePaperMode = "external";
    renderPaperDetail();
    return;
  }
  if (action === "save-discovery") {
    saveDiscoveryPaper(actionTarget.dataset.discoveryId).catch((error) => alert(error.message));
    return;
  }
  if (action === "save-discovery-to-collection") {
    saveDiscoveryPaper(actionTarget.dataset.discoveryId, actionTarget.dataset.collectionId).catch((error) => alert(error.message));
  }
});
initialize(false);
