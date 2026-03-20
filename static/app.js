const byId = (id) => document.getElementById(id);

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

function renderCardList(target, items, mapItem) {
  target.innerHTML = "";
  if (!items || !items.length) {
    target.innerHTML = `<div class="card"><p>No items.</p></div>`;
    return;
  }
  for (const item of items) {
    const card = document.createElement("article");
    card.className = "card";
    card.innerHTML = mapItem(item);
    target.appendChild(card);
  }
}

function setOutput(target, payload) {
  target.textContent = JSON.stringify(payload, null, 2);
}

async function refreshBootstrap() {
  const bootstrap = await api("/api/bootstrap");
  byId("session-status").textContent = bootstrap.me
    ? `Authenticated as ${bootstrap.me.display_name} (${bootstrap.me.email})`
    : "Not authenticated.";
  renderCardList(byId("collections-list"), bootstrap.collections || [], (collection) => `
    <h3>${collection.name}</h3>
    <p>${collection.description || "No description"}</p>
    <p>Visibility: ${collection.visibility} · Status: ${collection.status}</p>
    <p>ID: ${collection.id}</p>
  `);
}

function collectForm(form) {
  return Object.fromEntries(new FormData(form).entries());
}

byId("refresh-bootstrap").addEventListener("click", refreshBootstrap);

byId("register-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    await api("/api/register", {
      method: "POST",
      body: JSON.stringify(collectForm(event.target)),
    });
    await refreshBootstrap();
  } catch (error) {
    alert(error.message);
  }
});

byId("login-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    await api("/api/login", {
      method: "POST",
      body: JSON.stringify(collectForm(event.target)),
    });
    await refreshBootstrap();
  } catch (error) {
    alert(error.message);
  }
});

byId("logout-button").addEventListener("click", async () => {
  await api("/api/logout", { method: "POST", body: "{}" });
  await refreshBootstrap();
});

byId("collection-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const payload = collectForm(event.target);
  try {
    await api("/api/collections", {
      method: "POST",
      body: JSON.stringify(payload),
    });
    event.target.reset();
    await refreshBootstrap();
  } catch (error) {
    alert(error.message);
  }
});

byId("paper-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const raw = collectForm(event.target);
  const payload = {
    identifier_type: raw.identifier_type,
    value: raw.value || null,
    collection_id: raw.collection_id ? Number(raw.collection_id) : null,
  };
  if (raw.identifier_type === "manual") {
    payload.metadata = {
      title: raw.title,
      authors: raw.authors ? raw.authors.split(";").map((value) => value.trim()).filter(Boolean) : [],
      year: raw.year ? Number(raw.year) : null,
      abstract: raw.abstract,
      manual: true,
    };
  }
  try {
    const result = await api("/api/papers/add", {
      method: "POST",
      body: JSON.stringify(payload),
    });
    setOutput(byId("paper-result"), result);
  } catch (error) {
    alert(error.message);
  }
});

byId("search-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const payload = collectForm(event.target);
  try {
    const result = await api(`/api/search?q=${encodeURIComponent(payload.q)}`);
    renderCardList(byId("search-results"), result.results || [], (paper) => `
      <h3>${paper.title}</h3>
      <p>${paper.venue || "Unknown venue"} · ${paper.year || "Unknown year"}</p>
      <p>${paper.quality_state} · ${paper.reliability_state}</p>
      <p>ID: ${paper.id}</p>
    `);
  } catch (error) {
    alert(error.message);
  }
});

byId("recommend-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const payload = collectForm(event.target);
  const params = new URLSearchParams();
  if (payload.collection_id) params.set("collection_id", payload.collection_id);
  if (payload.seed) {
    payload.seed
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean)
      .forEach((value) => params.append("seed", value));
  }
  try {
    const result = await api(`/api/recommendations?${params.toString()}`);
    renderCardList(byId("recommendations-list"), result.results || [], (item) => `
      <h3>${item.paper.title}</h3>
      <p>Score: ${item.score}</p>
      <p>${item.explanation}</p>
    `);
  } catch (error) {
    alert(error.message);
  }
});

byId("timeline-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const payload = collectForm(event.target);
  const params = new URLSearchParams();
  for (const key of ["collection_id", "topic", "seed_paper_id"]) {
    if (payload[key]) params.set(key, payload[key]);
  }
  try {
    const result = await api(`/api/timeline?${params.toString()}`);
    setOutput(byId("timeline-output"), result);
  } catch (error) {
    alert(error.message);
  }
});

byId("graph-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const payload = collectForm(event.target);
  const params = new URLSearchParams();
  params.set("depth", payload.depth || "1");
  payload.seed
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
    .forEach((value) => params.append("seed", value));
  try {
    const result = await api(`/api/graph?${params.toString()}`);
    setOutput(byId("graph-output"), result);
  } catch (error) {
    alert(error.message);
  }
});

byId("import-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const payload = collectForm(event.target);
  try {
    const result = await api("/api/import", {
      method: "POST",
      body: JSON.stringify({
        source_type: payload.source_type,
        content: payload.content,
        collection_id: payload.collection_id ? Number(payload.collection_id) : null,
      }),
    });
    setOutput(byId("import-export-output"), result);
  } catch (error) {
    alert(error.message);
  }
});

byId("export-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const payload = collectForm(event.target);
  try {
    const result = await api("/api/export", {
      method: "POST",
      body: JSON.stringify({
        collection_id: Number(payload.collection_id),
        format: payload.format,
      }),
    });
    setOutput(byId("import-export-output"), result);
  } catch (error) {
    alert(error.message);
  }
});

byId("load-feed").addEventListener("click", async () => {
  setOutput(byId("ops-output"), await api("/api/feed"));
});
byId("load-notifications").addEventListener("click", async () => {
  setOutput(byId("ops-output"), await api("/api/notifications"));
});
byId("load-audit").addEventListener("click", async () => {
  setOutput(byId("ops-output"), await api("/api/audit"));
});

refreshBootstrap().catch(() => {
  byId("session-status").textContent = "Backend reachable. Authenticate to load workspace.";
});

