const byId = (id) => document.getElementById(id);

const DEMO_PASSWORD = "Preview2026Demo";
const DEMO_NAME = "Frontend Preview";
const DEMO_STORAGE_KEY = "reference-manager-demo-email";

const state = {
  bootstrap: null,
  system: null,
  activeCollection: null,
  activePaper: null,
  activePaperMode: "empty",
  demoCredentials: null,
  workspacePapers: [],
  search: {
    query: "",
    local: [],
    external: [],
    degraded: [],
  },
};

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
  const rawSource = Array.isArray(paper.raw_sources) ? paper.raw_sources[0] : null;
  const source = Array.isArray(paper.sources) ? paper.sources[0] : null;
  return rawSource?.provider || source?.provider || "workspace";
}

function metaChip(label) {
  return `<span class="meta-chip">${escapeHtml(label)}</span>`;
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
    { label: "Paper nel DB", value: counts.papers ?? 0 },
    { label: "Notifiche", value: counts.notifications ?? 0 },
    { label: "Import", value: counts.imports ?? 0 },
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

  if (!state.activeCollection) {
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
    metaChip(`${papers.length} paper nel database locale`),
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
          ${metaChip(collectionPaperIds.has(paper.id) ? "Nella collezione attiva" : "Solo nel database locale")}
          ${metaChip(providerName(paper))}
        </div>
        <button class="action-button secondary" type="button" data-action="open-paper" data-paper-id="${paper.id}">
          Apri dettaglio
        </button>
      </article>
    `,
    "Nessun paper salvato nel backend.",
  );
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
    target.textContent = "Seleziona un paper locale o un risultato esterno per vedere i metadati completi.";
    return;
  }

  const paper = state.activePaper;
  const topics = paper.topics || paper.metadata?.topics || [];
  const keywords = paper.metadata?.keywords || [];
  const sources = paper.sources || paper.raw_sources || [];
  const notes = paper.notes || [];
  const relations = paper.relations || [];
  target.className = "detail-panel";
  target.innerHTML = `
    <div class="detail-top">
      <div>
        <h3 class="detail-title">${escapeHtml(paper.title || "Titolo non disponibile")}</h3>
        <p class="detail-meta">${escapeHtml(joinAuthors(paper))}</p>
      </div>
      ${metaChip(state.activePaperMode === "external" ? "Preview API" : `Paper #${paper.id}`)}
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
    </div>

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
}

async function loadPaper(paperId) {
  const payload = await api(`/api/papers/${paperId}`);
  state.activePaper = payload.paper;
  state.activePaperMode = "local";
  renderPaperDetail();
}

async function selectCollection(collectionId) {
  state.activeCollection = { id: Number(collectionId) };
  await refreshActiveCollection();
  renderCollections();
  renderActiveCollection();
  renderWorkspacePapers();
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
    state.activePaperMode = "external";
    renderPaperDetail();
  } else {
    state.activePaper = null;
    state.activePaperMode = "empty";
  }
  renderSearchResults();
  renderPaperDetail();
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
  if (action === "preview-external") {
    const paper = state.search.external[Number(actionTarget.dataset.resultIndex)];
    if (!paper) {
      return;
    }
    state.activePaper = paper;
    state.activePaperMode = "external";
    renderPaperDetail();
    return;
  }
});
initialize(false);
