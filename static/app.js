const byId = (id) => document.getElementById(id);

const DEMO_PASSWORD = "Preview2026Demo";
const DEMO_NAME = "Frontend Preview";
const DEMO_STORAGE_KEY = "reference-manager-demo-email";
const CITATION_PAGE_SIZE = 10;
const VALID_STATES = [
  "non_visto",
  "visto",
  "salvato",
  "da_leggere",
  "in_lettura",
  "letto",
  "importante",
  "ignorato",
  "escluso",
];

const state = {
  bootstrap: null,
  system: null,
  collectionDetails: {},
  activeCollection: null,
  activeCollectionTab: "list",
  activeCollectionGraph: null,
  activeCollectionTimeline: null,
  activeCollectionRecommendations: [],
  activePaper: null,
  activePaperMode: "empty",
  activePaperRuns: [],
  activeRelations: null,
  demoCredentials: null,
  workspacePapers: [],
  search: {
    query: "",
    local: [],
    external: [],
    degraded: [],
  },
  activityKind: "feed",
  graphOpsMessage: "Nessuna operazione sul grafo eseguita.",
  graphOpsTone: "success",
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

function truncate(value, limit = 220) {
  if (!value) {
    return "";
  }
  return value.length > limit ? `${value.slice(0, limit).trim()}...` : value;
}

function formValues(form) {
  return Object.fromEntries(new FormData(form).entries());
}

function metaChip(label, tone = "") {
  return `<span class="meta-chip ${tone ? `meta-${tone}` : ""}">${escapeHtml(label)}</span>`;
}

function countChip(value) {
  return `<span class="count-chip">${escapeHtml(value)}</span>`;
}

function providerName(paper) {
  if (paper.provider) {
    return paper.provider;
  }
  const rawSource = Array.isArray(paper.raw_sources) ? paper.raw_sources[0] : null;
  const source = Array.isArray(paper.sources) ? paper.sources[0] : null;
  return rawSource?.provider || source?.provider || "workspace";
}

function joinAuthors(paper) {
  if (Array.isArray(paper.authors) && paper.authors.length) {
    if (typeof paper.authors[0] === "string") {
      return paper.authors.join(", ");
    }
    return paper.authors
      .map((author) => author.canonical_name || author.name || author.display_name)
      .filter(Boolean)
      .join(", ");
  }
  if (Array.isArray(paper.author_details) && paper.author_details.length) {
    return paper.author_details
      .map((author) => author.name)
      .filter(Boolean)
      .join(", ");
  }
  return "Autori non disponibili";
}

function userContextBadges(paper, { activeCollectionId = null } = {}) {
  const context = paper.user_context || {};
  const badges = [];
  if (context.saved_by_user) {
    badges.push(metaChip("Salvato"));
  } else if (context.discovery_id) {
    badges.push(metaChip("Discovery"));
  }
  if (context.in_collections_count) {
    badges.push(metaChip(`${context.in_collections_count} collezioni`));
  }
  if (activeCollectionId && Array.isArray(context.collection_ids) && context.collection_ids.includes(activeCollectionId)) {
    badges.push(metaChip("Nella collection attiva", "secondary"));
  }
  if (context.is_hidden) {
    badges.push(metaChip("Nascosto", "warning"));
  }
  if (context.is_excluded) {
    badges.push(metaChip("Escluso", "danger"));
  }
  return badges.join("");
}

function setOutput(target, payload) {
  target.textContent = JSON.stringify(payload, null, 2);
}

function setGraphFeedback(message, tone = "success") {
  state.graphOpsMessage = message;
  state.graphOpsTone = tone;
  const target = byId("graph-ops-feedback");
  target.textContent = message;
  target.className = `feedback-area ${tone}`;
}

function renderCards(target, items, renderItem, emptyMessage) {
  target.innerHTML = "";
  if (!items || !items.length) {
    target.innerHTML = `<div class="empty-block">${escapeHtml(emptyMessage)}</div>`;
    return;
  }
  for (const item of items) {
    const wrapper = document.createElement("div");
    wrapper.innerHTML = renderItem(item);
    target.appendChild(wrapper.firstElementChild);
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
    body: JSON.stringify({ email, password: DEMO_PASSWORD }),
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
      // ignore
    }
  }

  const candidates = demoCandidateEmails();
  const bootstrap = await api("/api/bootstrap");
  if (bootstrap.me && candidates.includes(bootstrap.me.email) && !forceReset) {
    state.demoCredentials = { email: bootstrap.me.email, password: DEMO_PASSWORD };
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

async function fetchCollectionDetails(collectionIds) {
  const payloads = await Promise.all(collectionIds.map((collectionId) => api(`/api/collections/${collectionId}`)));
  state.collectionDetails = Object.fromEntries(payloads.map((payload) => [payload.collection.id, payload.collection]));
}

async function loadActiveCollectionAncillaries() {
  if (!state.activeCollection?.id) {
    state.activeCollectionGraph = null;
    state.activeCollectionTimeline = null;
    state.activeCollectionRecommendations = [];
    return;
  }

  const collection = state.activeCollection;
  const params = new URLSearchParams();
  const seeds = (collection.papers || []).slice(0, 8);
  for (const paper of seeds) {
    params.append("seed", String(paper.id));
  }
  params.set("depth", "2");

  const requests = [
    seeds.length ? api(`/api/graph?${params.toString()}`) : Promise.resolve({ nodes: [], edges: [], degraded: [] }),
    api(`/api/timeline?collection_id=${collection.id}`),
    api(`/api/recommendations?collection_id=${collection.id}`),
  ];
  const [graph, timeline, recommendations] = await Promise.all(requests);
  if (!state.activeCollection || state.activeCollection.id !== collection.id) {
    return;
  }
  state.activeCollectionGraph = graph;
  state.activeCollectionTimeline = timeline;
  state.activeCollectionRecommendations = recommendations.results || [];
}

function resolveActiveCollectionId() {
  const existingIds = Object.keys(state.collectionDetails).map((id) => Number(id));
  if (!existingIds.length) {
    return null;
  }
  if (state.activeCollection?.id && existingIds.includes(state.activeCollection.id)) {
    return state.activeCollection.id;
  }
  return existingIds[0];
}

async function fetchWorkspace() {
  const [system, bootstrap, papersPayload] = await Promise.all([
    api("/api/system"),
    api("/api/bootstrap"),
    api("/api/papers"),
  ]);
  state.system = system;
  state.bootstrap = bootstrap;
  state.workspacePapers = papersPayload.papers || [];

  if (!bootstrap.me) {
    throw new Error("Sessione demo non disponibile.");
  }

  const collectionIds = (bootstrap.collections || []).map((collection) => collection.id);
  await fetchCollectionDetails(collectionIds);
  const activeCollectionId = resolveActiveCollectionId();
  state.activeCollection = activeCollectionId ? state.collectionDetails[activeCollectionId] : null;
  await loadActiveCollectionAncillaries();
  renderAll();
}

async function selectCollection(collectionId) {
  if (!collectionId) {
    state.activeCollection = null;
    state.activeCollectionGraph = null;
    state.activeCollectionTimeline = null;
    state.activeCollectionRecommendations = [];
    renderAll();
    return;
  }
  const payload = await api(`/api/collections/${collectionId}`);
  state.collectionDetails[payload.collection.id] = payload.collection;
  state.activeCollection = payload.collection;
  await loadActiveCollectionAncillaries();
  renderAll();
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
    `Refresh del grafo collezione completato: ${payload.stats.refreshed_papers} paper aggiornati.`,
    payload.degraded?.length ? "warning" : "success",
  );
}

async function duplicateActiveCollection() {
  if (!state.activeCollection?.id) {
    return;
  }
  const payload = await api("/api/collections/duplicate", {
    method: "POST",
    body: JSON.stringify({ collection_id: state.activeCollection.id }),
  });
  await fetchWorkspace();
  await selectCollection(payload.collection.id);
}

async function saveActiveCollectionSnapshot() {
  if (!state.activeCollection?.id) {
    return;
  }
  const snapshotName = `${state.activeCollection.name} · ${state.activeCollectionTab} · ${new Date().toLocaleString("it-IT")}`;
  await api("/api/snapshots", {
    method: "POST",
    body: JSON.stringify({
      collection_id: state.activeCollection.id,
      name: snapshotName,
      view_type: state.activeCollectionTab,
      state: {
        collection_id: state.activeCollection.id,
        tab: state.activeCollectionTab,
        paper_ids: (state.activeCollection.papers || []).map((paper) => paper.id),
        graph: state.activeCollectionGraph
          ? { nodes: state.activeCollectionGraph.nodes.length, edges: state.activeCollectionGraph.edges.length }
          : null,
      },
    }),
  });
  await selectCollection(state.activeCollection.id);
  setGraphFeedback("Snapshot della collezione salvato.", "success");
}

async function loadPaperRelations(paperId, { direction = "all", forceRefresh = false, page = 1 } = {}) {
  const params = new URLSearchParams();
  params.set("direction", direction);
  params.set("citation_page_size", String(CITATION_PAGE_SIZE));
  params.set("citation_page", String(page));
  if (forceRefresh) {
    params.set("refresh", "1");
  }
  const payload = await api(`/api/papers/${paperId}/relations?${params.toString()}`);
  if (!state.activePaper || state.activePaper.id !== paperId) {
    return payload;
  }
  const currentCitations = state.activeRelations?.citations?.items || [];
  const incomingCitations = payload.citations?.items || [];
  const mergedCitations =
    page > 1
      ? [
          ...currentCitations,
          ...incomingCitations.filter((item) => {
            const key = item.paper?.id || item.paper?.doi || item.paper?.title;
            return !currentCitations.some((current) => {
              const currentKey = current.paper?.id || current.paper?.doi || current.paper?.title;
              return currentKey === key;
            });
          }),
        ]
      : incomingCitations;

  state.activeRelations = {
    paper_id: payload.paper_id,
    cache_hit: payload.cache_hit,
    refreshed: payload.refreshed || [],
    degraded: payload.degraded || [],
    references: payload.references || state.activeRelations?.references || null,
    citations: payload.citations ? { ...payload.citations, items: mergedCitations } : state.activeRelations?.citations || null,
  };
  renderPaperDetail();
  return payload;
}

async function loadMoreCitations() {
  if (!state.activePaper?.id || state.activePaperMode !== "local") {
    return;
  }
  const currentPage = state.activeRelations?.citations?.pagination?.page || 1;
  await loadPaperRelations(state.activePaper.id, { direction: "citations", page: currentPage + 1 });
}

async function loadPaper(paperId) {
  const [payload, runsPayload] = await Promise.all([
    api(`/api/papers/${paperId}`),
    api(`/api/retrieval-runs?paper_id=${paperId}`),
  ]);
  state.activePaper = payload.paper;
  state.activePaperRuns = runsPayload.runs || [];
  state.activePaperMode = "local";
  state.activeRelations = null;
  renderPaperDetail();
  await loadPaperRelations(payload.paper.id);
}

function previewExternalPaper(index) {
  const paper = state.search.external[index];
  if (!paper) {
    return;
  }
  state.activePaper = paper;
  state.activePaperMode = "external";
  state.activePaperRuns = [];
  state.activeRelations = null;
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
    collectionId ? "Paper salvato in libreria e aggiunto alla collection attiva." : "Paper salvato in libreria.",
    "success",
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
    previewExternalPaper(0);
  } else {
    state.activePaper = null;
    state.activePaperRuns = [];
    state.activeRelations = null;
    state.activePaperMode = "empty";
  }
  renderSearchResults();
  renderPaperDetail();
}

async function handleCollectionCreate(event) {
  event.preventDefault();
  const values = formValues(event.target);
  const payload = await api("/api/collections", {
    method: "POST",
    body: JSON.stringify(values),
  });
  event.target.reset();
  await fetchWorkspace();
  await selectCollection(payload.collection.id);
}

async function refreshPaperGraph(mode) {
  if (!state.activePaper?.id || state.activePaperMode !== "local") {
    return;
  }
  const payload = await api("/api/papers/refresh", {
    method: "POST",
    body: JSON.stringify({
      paper_id: state.activePaper.id,
      mode,
      force_refresh: true,
      rebuild: true,
    }),
  });
  await fetchWorkspace();
  await loadPaper(state.activePaper.id);
  setGraphFeedback(`Refresh ${mode} completato per il paper #${state.activePaper.id}.`, payload.degraded?.length ? "warning" : "success");
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

async function handlePaperStateSubmit(event) {
  event.preventDefault();
  if (!state.activePaper?.id || state.activePaperMode !== "local") {
    return;
  }
  const values = formValues(event.target);
  await api("/api/papers/state", {
    method: "POST",
    body: JSON.stringify({
      paper_id: state.activePaper.id,
      status: values.status,
      tags: values.tags
        ? values.tags
            .split(",")
            .map((tag) => tag.trim())
            .filter(Boolean)
        : [],
      source: "frontend",
    }),
  });
  await fetchWorkspace();
  await loadPaper(state.activePaper.id);
}

async function handlePaperNoteSubmit(event) {
  event.preventDefault();
  if (!state.activePaper?.id || state.activePaperMode !== "local") {
    return;
  }
  const values = formValues(event.target);
  await api("/api/notes", {
    method: "POST",
    body: JSON.stringify({
      target_type: "paper",
      target_id: state.activePaper.id,
      visibility: values.visibility || "private",
      body: values.body,
    }),
  });
  event.target.reset();
  await loadPaper(state.activePaper.id);
}

async function handleActivity(kind) {
  state.activityKind = kind;
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
    const payload = await api(state.activeCollection?.id ? `/api/audit?collection_id=${state.activeCollection.id}` : "/api/audit");
    renderActivityList(payload.events || [], "Audit log vuoto.");
    setOutput(byId("ops-output"), payload);
    return;
  }
  if (kind === "runs") {
    if (!state.activePaper?.id || state.activePaperMode !== "local") {
      renderActivityList([], "Seleziona un paper locale per vedere i retrieval runs.");
      setOutput(byId("ops-output"), { runs: [] });
      return;
    }
    const payload = await api(`/api/retrieval-runs?paper_id=${state.activePaper.id}`);
    renderActivityList(payload.runs || [], "Nessun retrieval run disponibile per questo paper.");
    setOutput(byId("ops-output"), payload);
  }
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

function renderRuntimeChips() {
  const stores = state.system?.stores || {};
  const chips = [
    metaChip(`TX ${stores.transactional?.backend || "n/d"}`),
    metaChip(`Graph ${stores.graph?.backend || "n/d"}`, "secondary"),
    metaChip(`Read ${stores.read_models?.backend || "n/d"}`, "secondary"),
    metaChip("Backend-first"),
    metaChip("Collections + Graph"),
  ];
  byId("runtime-chips").innerHTML = chips.join("");
}

function renderStats() {
  const counts = state.system?.counts || {};
  const stats = [
    { label: "Utenti", value: counts.users ?? 0 },
    { label: "Collections", value: counts.collections ?? 0 },
    { label: "Paper salvati", value: counts.library_entries ?? 0 },
    { label: "Paper catalogo", value: counts.catalog_papers ?? 0 },
    { label: "Cache discovery", value: counts.discovery_cache ?? 0 },
    { label: "Notifiche", value: counts.notifications ?? 0 },
  ];
  byId("stats-grid").innerHTML = stats
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

function renderCollectionOverview() {
  const collections = Object.values(state.collectionDetails);
  renderCards(
    byId("collection-overview-grid"),
    collections,
    (collection) => `
      <article class="overview-card ${collection.id === state.activeCollection?.id ? "active" : ""}">
        <div class="overview-card-top">
          <div>
            <h3>${escapeHtml(collection.name)}</h3>
            <p class="card-copy">${escapeHtml(collection.description || "Nessuna descrizione")}</p>
          </div>
          ${metaChip(`#${collection.id}`)}
        </div>
        <div class="card-meta">
          ${metaChip(collection.visibility)}
          ${metaChip(collection.status)}
          ${countChip(`${collection.papers?.length || 0} paper`)}
          ${countChip(`${collection.members?.length || 0} membri`)}
        </div>
        <div class="card-meta">
          ${(collection.tags || []).map((tag) => metaChip(tag, "secondary")).join("")}
        </div>
      </article>
    `,
    "Nessuna collezione disponibile.",
  );
}

function renderCollectionsSidebar() {
  const collections = Object.values(state.collectionDetails);
  renderCards(
    byId("collections-sidebar-list"),
    collections,
    (collection) => `
      <article class="collection-card ${collection.id === state.activeCollection?.id ? "active" : ""}">
        <div class="collection-top">
          <div>
            <h3 class="collection-title">${escapeHtml(collection.name)}</h3>
            <p class="card-copy">${escapeHtml(truncate(collection.description || "Nessuna descrizione", 120))}</p>
          </div>
          ${metaChip(`${collection.papers?.length || 0} paper`)}
        </div>
        <div class="card-meta">
          ${metaChip(collection.visibility)}
          ${metaChip(collection.status)}
          ${metaChip(`${collection.members?.length || 0} membri`)}
        </div>
        <button class="action-button secondary" type="button" data-action="select-collection" data-collection-id="${collection.id}">
          Apri workspace
        </button>
      </article>
    `,
    "Crea la prima collection per iniziare.",
  );

  const select = byId("search-collection-id");
  select.innerHTML = `<option value="">Tutto il workspace</option>${collections
    .map((collection) => `<option value="${collection.id}">${escapeHtml(collection.name)}</option>`)
    .join("")}`;
  if (state.activeCollection?.id) {
    select.value = String(state.activeCollection.id);
  }
}

function renderCollectionTabs() {
  for (const tab of ["list", "graph", "insights"]) {
    byId(`collection-tab-${tab}`).classList.toggle("active", state.activeCollectionTab === tab);
    byId(`collection-${tab}-view`).classList.toggle("active", state.activeCollectionTab === tab);
  }
}

function renderActiveCollectionSummary() {
  const collection = state.activeCollection;
  if (!collection) {
    byId("active-collection-title").textContent = "Seleziona una collezione";
    byId("active-collection-copy").textContent = "Apri una collezione per vedere insieme lista paper, grafo e insight.";
    byId("active-collection-badges").innerHTML = "";
    byId("active-collection-members").textContent = "Nessun membro disponibile.";
    byId("active-collection-notes").textContent = "Nessuna nota disponibile.";
    return;
  }
  byId("active-collection-title").textContent = collection.name;
  byId("active-collection-copy").textContent = collection.description || "Collection pronta per browsing, graph exploration e insights.";
  byId("active-collection-badges").innerHTML = [
    metaChip(collection.visibility),
    metaChip(collection.status),
    countChip(`${collection.papers?.length || 0} paper`),
    countChip(`${collection.snapshots?.length || 0} snapshot`),
    ...(collection.tags || []).map((tag) => metaChip(tag, "secondary")),
  ].join("");
  byId("active-collection-members").innerHTML = (collection.members || []).length
    ? collection.members.map((member) => metaChip(`${member.display_name || member.email} · ${member.role}`, "secondary")).join("")
    : '<span class="muted-copy">Nessun collaboratore registrato.</span>';
  byId("active-collection-notes").innerHTML = `
    ${countChip(`${collection.notes?.length || 0} note`)}
    ${countChip(`${collection.snapshots?.length || 0} snapshot`)}
    ${collection.notes?.[0] ? `<p class="inline-copy">${escapeHtml(truncate(collection.notes[0].body, 140))}</p>` : '<p class="inline-copy">Nessuna nota sulla collection.</p>'}
  `;
}

function renderPaperCard(paper, { mode = "local", compact = false, index = null } = {}) {
  const abstract = paper.abstract || paper.metadata?.quality_note || "Metadati essenziali disponibili.";
  const actionMarkup =
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
          <p class="paper-copy">${escapeHtml(truncate(abstract, compact ? 140 : 190))}</p>
        </div>
        ${metaChip(mode === "external" ? providerName(paper) : `#${paper.id}`)}
      </div>
      <div class="card-meta">
        ${metaChip(paper.venue || "Venue n/d")}
        ${metaChip(paper.year || "Anno n/d")}
      </div>
      <div class="card-meta">
        ${metaChip(joinAuthors(paper))}
        ${paper.doi ? metaChip(`DOI ${paper.doi}`) : ""}
      </div>
      <div class="card-meta">
        ${paper.quality_state ? metaChip(paper.quality_state) : ""}
        ${paper.reliability_state ? metaChip(paper.reliability_state) : ""}
        ${userContextBadges(paper, { activeCollectionId: state.activeCollection?.id || null })}
      </div>
      ${actionMarkup}
    </article>
  `;
}

function renderCollectionListView() {
  const collection = state.activeCollection;
  const meta = byId("collection-list-meta");
  const target = byId("collection-paper-list");
  if (!collection) {
    meta.innerHTML = "";
    renderCards(target, [], () => "", "Nessuna collection attiva.");
    return;
  }
  meta.innerHTML = [
    countChip(`${collection.papers?.length || 0} paper`),
    countChip(`${collection.members?.length || 0} membri`),
    countChip(`${collection.notes?.length || 0} note`),
  ].join("");
  renderCards(
    target,
    collection.papers || [],
    (paper) => renderPaperCard(paper, { mode: "local", compact: true }),
    "Questa collection non contiene ancora paper.",
  );
}

function renderWorkspacePapers() {
  const papers = state.workspacePapers || [];
  const activeIds = new Set((state.activeCollection?.papers || []).map((paper) => paper.id));
  byId("workspace-paper-meta").innerHTML = [
    countChip(`${papers.length} paper salvati`),
    state.activeCollection ? countChip(`${[...activeIds].length} presenti nella collection attiva`) : metaChip("Nessuna collection selezionata"),
  ].join("");
  renderCards(
    byId("workspace-paper-list"),
    papers,
    (paper) => `
      <article class="paper-card ${activeIds.has(paper.id) ? "paper-card-highlight" : ""}">
        <div class="paper-top">
          <div>
            <h3 class="paper-title">${escapeHtml(paper.title)}</h3>
            <p class="paper-copy">${escapeHtml(truncate(paper.abstract || paper.metadata?.quality_note || "Metadati essenziali disponibili.", 180))}</p>
          </div>
          ${metaChip(`#${paper.id}`)}
        </div>
        <div class="card-meta">
          ${metaChip(paper.venue || "Venue n/d")}
          ${metaChip(paper.year || "Anno n/d")}
          ${metaChip(joinAuthors(paper))}
        </div>
        <div class="card-meta">
          ${paper.doi ? metaChip(`DOI ${paper.doi}`) : ""}
          ${userContextBadges(paper, { activeCollectionId: state.activeCollection?.id || null })}
        </div>
        <button class="action-button secondary" type="button" data-action="open-paper" data-paper-id="${paper.id}">
          Apri dettaglio
        </button>
      </article>
    `,
    "Nessun paper salvato in libreria.",
  );
}

function renderSearchResults() {
  byId("local-results-count").textContent = String(state.search.local.length);
  byId("external-results-count").textContent = String(state.search.external.length);
  renderCards(
    byId("search-results-local"),
    state.search.local,
    (paper) => renderPaperCard(paper, { mode: "local" }),
    "Nessun paper locale trovato.",
  );
  renderCards(
    byId("search-results-external"),
    state.search.external.map((paper, index) => ({ ...paper, _index: index })),
    (paper) => renderPaperCard(paper, { mode: "external", index: paper._index }),
    "Nessun risultato provider.",
  );
  const notes = [];
  if (state.search.query) {
    notes.push(`Query: "${state.search.query}"`);
  }
  if (state.search.degraded.length) {
    notes.push(`Provider notes: ${state.search.degraded.join(" · ")}`);
  }
  const feedback = byId("search-feedback");
  feedback.textContent = notes.join(" | ") || "Nessuna ricerca eseguita.";
  feedback.className = `feedback-area ${state.search.degraded.length ? "warning" : "success"}`;
}

function renderCoverageBadges(coverage) {
  if (!coverage?.length) {
    return '<p class="muted-copy">Copertura provider non disponibile.</p>';
  }
  return `
    <div class="detail-tags">
      ${coverage.map((item) => metaChip(`${item.provider} ${item.count || ""}`.trim(), item.status === "degraded" ? "warning" : "secondary")).join("")}
    </div>
  `;
}

function renderRelationItems(items, emptyMessage) {
  if (!items?.length) {
    return `<div class="empty-block">${escapeHtml(emptyMessage)}</div>`;
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
            ${metaChip(`evidenze ${item.edge.evidence_count || 1}`)}
            ${(item.edge.providers || []).map((provider) => metaChip(provider, "secondary")).join("")}
          </div>
          <p class="relation-copy">${escapeHtml(item.edge.explanation || "Relazione normalizzata dal backend.")}</p>
          <button class="action-button secondary" type="button" data-action="open-paper" data-paper-id="${item.paper.id}">
            Apri paper
          </button>
        </article>
      `,
    )
    .join("");
}

function renderPaperDetail() {
  const target = byId("paper-detail");
  if (!state.activePaper) {
    target.className = "detail-panel empty-state";
    target.textContent = "Seleziona un paper dalla libreria, da una collection, dal grafo o dai risultati discovery.";
    return;
  }

  const paper = state.activePaper;
  const isLocal = state.activePaperMode === "local";
  const userContext = paper.user_context || {};
  const notes = paper.notes || [];
  const sources = paper.sources || paper.raw_sources || [];
  const topics = paper.topics || paper.metadata?.topics || [];
  const keywords = paper.metadata?.keywords || [];
  const references = state.activeRelations?.references?.items || [];
  const citations = state.activeRelations?.citations?.items || [];
  const retrievalRuns = state.activePaperRuns || [];
  const relationNotes = [
    state.activeRelations?.references?.fetched_at ? `references @ ${state.activeRelations.references.fetched_at}` : null,
    state.activeRelations?.citations?.fetched_at ? `citations @ ${state.activeRelations.citations.fetched_at}` : null,
  ]
    .filter(Boolean)
    .join(" · ");

  target.className = "detail-panel";
  target.innerHTML = `
    <div class="detail-top">
      <div>
        <h3 class="detail-title">${escapeHtml(paper.title || "Titolo non disponibile")}</h3>
        <p class="detail-meta">${escapeHtml(joinAuthors(paper))}</p>
      </div>
      ${metaChip(isLocal ? `Paper #${paper.id}` : "Preview provider")}
    </div>

    <div class="detail-tags">
      ${paper.venue ? metaChip(paper.venue) : ""}
      ${paper.year ? metaChip(paper.year) : ""}
      ${paper.publication_type ? metaChip(paper.publication_type) : ""}
      ${paper.language ? metaChip(paper.language) : ""}
      ${paper.quality_state ? metaChip(paper.quality_state) : ""}
      ${paper.reliability_state ? metaChip(paper.reliability_state) : ""}
      ${userContextBadges(paper, { activeCollectionId: state.activeCollection?.id || null })}
    </div>

    <p class="detail-abstract">${escapeHtml(paper.abstract || paper.metadata?.quality_note || "Nessun abstract disponibile.")}</p>

    <div class="detail-grid-inner">
      <section class="detail-section">
        <h3>Metadati</h3>
        <p>DOI: ${escapeHtml(paper.doi || "n/d")}</p>
        <p>Provider principale: ${escapeHtml(providerName(paper))}</p>
        <p>Topics: ${escapeHtml(topics.map((topic) => topic.label || topic).join(", ") || "n/d")}</p>
        <p>Keywords: ${escapeHtml(keywords.join(", ") || "n/d")}</p>
        <div class="detail-links">
          ${paper.canonical_url ? `<a href="${escapeHtml(paper.canonical_url)}" target="_blank" rel="noreferrer">Apri record</a>` : ""}
          ${paper.pdf_url ? `<a href="${escapeHtml(paper.pdf_url)}" target="_blank" rel="noreferrer">Apri PDF</a>` : ""}
          ${paper.doi ? `<a href="https://doi.org/${encodeURIComponent(paper.doi)}" target="_blank" rel="noreferrer">Vai al DOI</a>` : ""}
        </div>
      </section>

      <section class="detail-section">
        <h3>Sources e runs</h3>
        <div class="detail-tags">
          ${sources.map((source) => metaChip(source.provider || "source", "secondary")).join("") || '<span class="muted-copy">Nessuna source.</span>'}
        </div>
        ${relationNotes ? `<p class="muted-copy">${escapeHtml(relationNotes)}</p>` : ""}
        ${state.activeRelations?.degraded?.length ? `<p class="muted-copy">${escapeHtml(state.activeRelations.degraded.join(" · "))}</p>` : ""}
        ${
          retrievalRuns.length
            ? `
              <ul class="inline-list">
                ${retrievalRuns
                  .slice(0, 4)
                  .map((run) => `<li>${escapeHtml(run.operation)} · ${escapeHtml(run.status)} · ${escapeHtml(run.started_at || "n/d")}</li>`)
                  .join("")}
              </ul>
            `
            : '<p class="muted-copy">Nessun retrieval run recente.</p>'
        }
      </section>
    </div>

    ${
      isLocal
        ? `
          <div class="detail-actions">
            <button class="ghost" type="button" data-action="refresh-paper-graph" data-mode="references">Refresh references</button>
            <button class="ghost" type="button" data-action="refresh-paper-graph" data-mode="citations">Refresh citations</button>
            <button class="ghost" type="button" data-action="expand-paper-graph">Espandi 1 hop</button>
          </div>

          <div class="detail-grid-inner">
            <section class="detail-section">
              <h3>Workflow personale</h3>
              <form id="paper-state-form" class="stack">
                <label>
                  Stato
                  <select name="status">
                    ${VALID_STATES.map((status) => `<option value="${status}">${escapeHtml(status)}</option>`).join("")}
                  </select>
                </label>
                <label>
                  Tag
                  <input name="tags" type="text" placeholder="backend, memory, da-rivedere">
                </label>
                <button type="submit">Aggiorna stato</button>
              </form>
            </section>

            <section class="detail-section">
              <h3>Note</h3>
              <form id="paper-note-form" class="stack">
                <label>
                  Visibilità
                  <select name="visibility">
                    <option value="private">Privata</option>
                    <option value="shared">Condivisa</option>
                  </select>
                </label>
                <label>
                  Contenuto
                  <textarea name="body" rows="4" required placeholder="Nota sul paper attivo"></textarea>
                </label>
                <button type="submit">Aggiungi nota</button>
              </form>
              <div class="note-list">
                ${
                  notes.length
                    ? notes
                        .map(
                          (note) => `
                            <article class="note-card">
                              <div class="card-meta">
                                ${metaChip(note.visibility)}
                                ${metaChip(note.updated_at || note.created_at || "n/d")}
                              </div>
                              <p>${escapeHtml(note.body)}</p>
                            </article>
                          `,
                        )
                        .join("")
                    : '<p class="muted-copy">Nessuna nota ancora salvata.</p>'
                }
              </div>
            </section>
          </div>
        `
        : `
          <div class="detail-actions">
            ${
              userContext.saved_by_user && paper.persisted_paper_id
                ? `<button class="ghost" type="button" data-action="open-paper" data-paper-id="${paper.persisted_paper_id}">Apri versione salvata</button>`
                : `<button class="ghost" type="button" data-action="save-discovery" data-discovery-id="${paper.discovery_id}">Salva in libreria</button>`
            }
            ${
              !userContext.saved_by_user && state.activeCollection?.id
                ? `<button class="ghost" type="button" data-action="save-discovery-to-collection" data-discovery-id="${paper.discovery_id}" data-collection-id="${state.activeCollection.id}">Salva nella collection attiva</button>`
                : ""
            }
          </div>
        `
    }

    ${
      isLocal
        ? `
          <div class="detail-section">
            <h3>References</h3>
            <p class="muted-copy">${escapeHtml((state.activeRelations?.references?.sources_used || []).join(", ") || "Provider non ancora interrogati.")}</p>
            ${renderCoverageBadges(state.activeRelations?.references?.coverage)}
            <div class="relation-list">
              ${renderRelationItems(references, "Nessuna reference disponibile per questo paper.")}
            </div>
          </div>

          <div class="detail-section">
            <h3>Citations</h3>
            <p class="muted-copy">${escapeHtml((state.activeRelations?.citations?.sources_used || []).join(", ") || "Provider non ancora interrogati.")}</p>
            ${renderCoverageBadges(state.activeRelations?.citations?.coverage)}
            <div class="relation-list">
              ${renderRelationItems(citations, "Nessuna citation disponibile per questo paper.")}
            </div>
            ${
              state.activeRelations?.citations?.pagination?.has_next
                ? `
                  <div class="actions-row">
                    <button class="ghost" type="button" data-action="load-more-citations">Carica altre citations</button>
                  </div>
                `
                : ""
            }
          </div>
        `
        : ""
    }
  `;

  if (isLocal) {
    const statusForm = byId("paper-state-form");
    const noteForm = byId("paper-note-form");
    const currentStatus = paper.status || "salvato";
    if (statusForm) {
      statusForm.elements.status.value = VALID_STATES.includes(currentStatus) ? currentStatus : "salvato";
      statusForm.addEventListener("submit", (event) => {
        handlePaperStateSubmit(event).catch((error) => alert(error.message));
      });
    }
    if (noteForm) {
      noteForm.addEventListener("submit", (event) => {
        handlePaperNoteSubmit(event).catch((error) => alert(error.message));
      });
    }
  }
}

function renderActivityList(items, emptyMessage) {
  renderCards(
    byId("activity-list"),
    items || [],
    (item) => `
      <article class="activity-card">
        <div class="activity-top">
          <h3 class="activity-title">${escapeHtml(item.title || item.kind || item.event_type || item.operation || "Evento")}</h3>
          ${metaChip(item.created_at || item.started_at || item.status || "live")}
        </div>
        <p class="activity-copy">${escapeHtml(item.message || item.summary || item.description || item.explanation || "Nessun dettaglio aggiuntivo.")}</p>
      </article>
    `,
    emptyMessage,
  );
}

function nodeBuckets(graph) {
  const buckets = { paperSeeds: [], paperRelated: [], author: [], topic: [], other: [] };
  const seedIds = new Set((state.activeCollection?.papers || []).map((paper) => `paper:${paper.id}`));
  for (const node of graph.nodes || []) {
    if (node.type === "paper" && seedIds.has(node.id)) {
      buckets.paperSeeds.push(node);
      continue;
    }
    if (node.type === "paper") {
      buckets.paperRelated.push(node);
      continue;
    }
    if (node.type === "author") {
      buckets.author.push(node);
      continue;
    }
    if (node.type === "topic") {
      buckets.topic.push(node);
      continue;
    }
    buckets.other.push(node);
  }
  return buckets;
}

function ringPositions(nodes, cx, cy, radiusX, radiusY, startAngle = -Math.PI / 2) {
  const positions = {};
  if (!nodes.length) {
    return positions;
  }
  if (nodes.length === 1) {
    positions[nodes[0].id] = { x: cx, y: cy };
    return positions;
  }
  nodes.forEach((node, index) => {
    const angle = startAngle + (Math.PI * 2 * index) / nodes.length;
    positions[node.id] = {
      x: cx + Math.cos(angle) * radiusX,
      y: cy + Math.sin(angle) * radiusY,
    };
  });
  return positions;
}

function graphNodeMarkup(node, position) {
  const palette = {
    paper: { radius: 26, className: "graph-paper" },
    author: { radius: 18, className: "graph-author" },
    topic: { radius: 16, className: "graph-topic" },
  };
  const config = palette[node.type] || { radius: 14, className: "graph-other" };
  const isPaper = node.type === "paper";
  return `
    <g class="graph-node ${config.className}" ${isPaper ? `data-action="open-paper" data-paper-id="${node.id.split(":")[1]}"` : ""} transform="translate(${position.x}, ${position.y})">
      <circle r="${config.radius}"></circle>
      <text y="${config.radius + 20}" text-anchor="middle">${escapeHtml(truncate(node.label || node.id, 28))}</text>
    </g>
  `;
}

function renderCollectionGraphView() {
  const target = byId("collection-graph-canvas");
  const meta = byId("collection-graph-meta");
  const graph = state.activeCollectionGraph;
  if (!state.activeCollection) {
    meta.innerHTML = "";
    target.className = "graph-canvas empty-state";
    target.textContent = "Seleziona una collection per visualizzarne il grafo.";
    return;
  }
  if (!graph?.nodes?.length) {
    meta.innerHTML = countChip("0 nodi");
    target.className = "graph-canvas empty-state";
    target.textContent = "Il backend non ha ancora nodi sufficienti per il grafo di questa collection.";
    return;
  }

  const width = 1100;
  const height = 680;
  const cx = width / 2;
  const cy = height / 2;
  const buckets = nodeBuckets(graph);
  const positions = {
    ...ringPositions(buckets.paperSeeds, cx, cy, 120, 95),
    ...ringPositions(buckets.paperRelated, cx, cy, 260, 185),
    ...ringPositions(buckets.author, cx, cy, 390, 250),
    ...ringPositions(buckets.topic, cx, cy, 500, 300),
    ...ringPositions(buckets.other, cx, cy, 560, 340),
  };
  const edgeMarkup = (graph.edges || [])
    .filter((edge) => positions[edge.source] && positions[edge.target])
    .map((edge) => {
      const source = positions[edge.source];
      const targetPosition = positions[edge.target];
      return `
        <line
          x1="${source.x}"
          y1="${source.y}"
          x2="${targetPosition.x}"
          y2="${targetPosition.y}"
          class="graph-edge edge-${escapeHtml(edge.type)}"
        ></line>
      `;
    })
    .join("");
  const nodeMarkup = (graph.nodes || [])
    .filter((node) => positions[node.id])
    .map((node) => graphNodeMarkup(node, positions[node.id]))
    .join("");

  meta.innerHTML = [
    countChip(`${graph.nodes.length} nodi`),
    countChip(`${graph.edges.length} archi`),
    ...(graph.degraded || []).map((item) => metaChip(item, "warning")),
  ].join("");
  target.className = "graph-canvas";
  target.innerHTML = `
    <div class="graph-legend">
      ${metaChip("Paper seed")}
      ${metaChip("Paper collegati", "secondary")}
      ${metaChip("Autori", "secondary")}
      ${metaChip("Topic", "secondary")}
    </div>
    <svg viewBox="0 0 ${width} ${height}" class="graph-svg" role="img" aria-label="Grafo collezione">
      <g class="graph-edges">${edgeMarkup}</g>
      <g class="graph-nodes">${nodeMarkup}</g>
    </svg>
  `;
}

function renderCollectionInsightsView() {
  const recommendations = state.activeCollectionRecommendations || [];
  const timeline = state.activeCollectionTimeline || { items: [], growth: [] };
  byId("recommendations-count").textContent = String(recommendations.length);
  byId("timeline-count").textContent = String((timeline.items || []).length);
  byId("collection-insights-meta").innerHTML = [
    countChip(`${recommendations.length} recommendation`),
    countChip(`${(timeline.items || []).length} paper in timeline`),
  ].join("");

  renderCards(
    byId("recommendations-list"),
    recommendations,
    (item) => `
      <article class="paper-card">
        <div class="paper-top">
          <div>
            <h3 class="paper-title">${escapeHtml(item.paper.title || "Titolo non disponibile")}</h3>
            <p class="paper-copy">${escapeHtml(truncate(item.explanation || "Suggerimento generato dal backend.", 180))}</p>
          </div>
          ${metaChip(`score ${item.score}`)}
        </div>
        <div class="card-meta">
          ${metaChip(item.paper.venue || "Venue n/d")}
          ${metaChip(item.paper.year || "Anno n/d")}
        </div>
        <button class="action-button secondary" type="button" data-action="open-paper" data-paper-id="${item.paper.id}">
          Apri paper
        </button>
      </article>
    `,
    "Nessuna recommendation disponibile per questa collection.",
  );

  byId("timeline-growth").innerHTML = (timeline.growth || []).length
    ? timeline.growth
        .map((item) => {
          const width = Math.min(100, item.count * 18);
          return `
            <div class="growth-row">
              <span>${escapeHtml(item.year)}</span>
              <div class="growth-bar"><div style="width:${width}%"></div></div>
              <strong>${escapeHtml(item.count)}</strong>
            </div>
          `;
        })
        .join("")
    : '<div class="empty-block">Nessuna crescita temporale disponibile.</div>';

  renderCards(
    byId("timeline-list"),
    timeline.items || [],
    (item) => `
      <article class="activity-card">
        <div class="activity-top">
          <h3 class="activity-title">${escapeHtml(item.title || "Titolo non disponibile")}</h3>
          ${metaChip(item.phase || item.year || "n/d")}
        </div>
        <p class="activity-copy">${escapeHtml(item.venue || "Venue n/d")} · ${escapeHtml(item.year || "Anno n/d")}</p>
        <button class="action-button secondary" type="button" data-action="open-paper" data-paper-id="${item.id}">
          Apri paper
        </button>
      </article>
    `,
    "Nessuna timeline disponibile.",
  );
}

function renderAll() {
  const me = state.bootstrap?.me;
  updateSessionStatus(
    me ? `Sessione demo attiva per ${me.display_name}` : "Sessione demo assente",
    me ? "success" : "warning",
    me ? "Il login reale è nascosto: il frontend riusa automaticamente gli account di test seedati." : "Verifica backend e cookie di sessione.",
  );
  renderDemoCredentials();
  renderRuntimeChips();
  renderStats();
  renderCollectionOverview();
  renderCollectionsSidebar();
  renderCollectionTabs();
  renderActiveCollectionSummary();
  renderCollectionListView();
  renderCollectionGraphView();
  renderCollectionInsightsView();
  renderWorkspacePapers();
  renderSearchResults();
  renderPaperDetail();
  if (state.activityKind === "feed") {
    renderActivityList(state.bootstrap?.feed || [], "Nessuna activity disponibile nel feed.");
    setOutput(byId("ops-output"), { items: state.bootstrap?.feed || [] });
  }
  setGraphFeedback(state.graphOpsMessage, state.graphOpsTone);
}

async function initialize(forceReset = false) {
  updateSessionStatus("Connessione al backend in corso.", "warning", "Sto inizializzando la sessione demo e caricando il workspace.");
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
  handleCollectionCreate(event).catch((error) => alert(error.message));
});

byId("search-form").addEventListener("submit", (event) => {
  handleSearch(event).catch((error) => alert(error.message));
});

byId("refresh-workspace").addEventListener("click", () => {
  initialize(false).catch((error) => alert(error.message));
});

byId("reset-demo").addEventListener("click", () => {
  initialize(true).catch((error) => alert(error.message));
});

byId("refresh-collection-graph").addEventListener("click", () => {
  refreshActiveCollectionGraph().catch((error) => alert(error.message));
});

byId("duplicate-collection").addEventListener("click", () => {
  duplicateActiveCollection().catch((error) => alert(error.message));
});

byId("save-collection-snapshot").addEventListener("click", () => {
  saveActiveCollectionSnapshot().catch((error) => alert(error.message));
});

byId("load-feed").addEventListener("click", () => {
  handleActivity("feed").catch((error) => alert(error.message));
});

byId("load-notifications").addEventListener("click", () => {
  handleActivity("notifications").catch((error) => alert(error.message));
});

byId("load-audit").addEventListener("click", () => {
  handleActivity("audit").catch((error) => alert(error.message));
});

byId("load-runs").addEventListener("click", () => {
  handleActivity("runs").catch((error) => alert(error.message));
});

document.addEventListener("click", (event) => {
  const actionTarget = event.target.closest("[data-action]");
  if (!actionTarget) {
    return;
  }
  const action = actionTarget.dataset.action;
  if (action === "switch-collection-tab") {
    state.activeCollectionTab = actionTarget.dataset.tab;
    renderCollectionTabs();
    return;
  }
  if (action === "select-collection") {
    selectCollection(Number(actionTarget.dataset.collectionId)).catch((error) => alert(error.message));
    return;
  }
  if (action === "open-paper") {
    loadPaper(Number(actionTarget.dataset.paperId)).catch((error) => alert(error.message));
    return;
  }
  if (action === "preview-external") {
    previewExternalPaper(Number(actionTarget.dataset.resultIndex));
    return;
  }
  if (action === "save-discovery") {
    saveDiscoveryPaper(actionTarget.dataset.discoveryId).catch((error) => alert(error.message));
    return;
  }
  if (action === "save-discovery-to-collection") {
    saveDiscoveryPaper(actionTarget.dataset.discoveryId, actionTarget.dataset.collectionId).catch((error) => alert(error.message));
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
  }
});

initialize(false);
