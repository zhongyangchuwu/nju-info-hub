import { buildOpml, parseSourceSelection, serializeSourceSelection } from "./catalog-helpers.js";

const sourceList = document.querySelector("#sources");
const setsList = document.querySelector("#sets");
const count = document.querySelector("#selection-count");
const status = document.querySelector("#status");
const selectAllButton = document.querySelector("#select-all");
const clearButton = document.querySelector("#clear-selection");
const downloadButton = document.querySelector("#download-opml");
const copyButtons = new Map([
  ["rss", document.querySelector("#copy-rss")],
  ["atom", document.querySelector("#copy-atom")],
  ["json", document.querySelector("#copy-json")],
]);

let sources = [];
let selectedIds = new Set();

function makeLink(label, href, { external = false, className = "" } = {}) {
  const link = document.createElement("a");
  link.textContent = label;
  try {
    const url = new URL(href);
    if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("Unsupported link protocol");
    link.href = url.href;
    if (external) {
      link.target = "_blank";
      link.rel = "noopener noreferrer";
    }
  } catch {
    link.setAttribute("aria-disabled", "true");
  }
  if (className) link.className = className;
  return link;
}

function showStatus(message, kind = "info") {
  status.textContent = message;
  status.dataset.kind = kind;
}

function orderedSelection() {
  return sources.filter((source) => selectedIds.has(source.id));
}

function updateSelection({ updateUrl = false } = {}) {
  const selected = orderedSelection();
  count.textContent = `${selected.length} of ${sources.length} sources selected`;
  downloadButton.disabled = selected.length === 0;
  for (const button of copyButtons.values()) button.disabled = selected.length === 0;
  for (const input of sourceList.querySelectorAll("input[type=checkbox]")) {
    input.checked = selectedIds.has(input.value);
  }
  if (updateUrl) {
    const url = new URL(window.location.href);
    url.searchParams.set("sources", serializeSourceSelection(selected.map((source) => source.id)));
    window.history.replaceState(null, "", url);
  }
}

function renderSources() {
  const groups = new Map();
  for (const source of sources) {
    const organization = source.organization.name;
    let group = groups.get(source.organization.id);
    if (!group) {
      group = document.createElement("section");
      group.className = "source-group";
      const heading = document.createElement("h3");
      heading.textContent = organization;
      group.append(heading);
      groups.set(source.organization.id, group);
    }

    const item = document.createElement("article");
    item.className = "source-item";
    const label = document.createElement("label");
    label.className = "source-label";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.value = source.id;
    checkbox.addEventListener("change", () => {
      if (checkbox.checked) selectedIds.add(source.id);
      else selectedIds.delete(source.id);
      updateSelection({ updateUrl: true });
    });
    const sourceName = document.createElement("span");
    sourceName.textContent = source.name;
    label.append(checkbox, sourceName);

    const organizationLine = document.createElement("p");
    organizationLine.className = "source-organization";
    organizationLine.textContent = `${organization} · `;
    organizationLine.append(makeLink("Original NJU source", source.home_page_url, { external: true, className: "source-origin" }));

    const feeds = document.createElement("p");
    feeds.className = "source-links";
    feeds.append(
      makeLink("JSON Feed", source.feeds.json, { external: true }),
      makeLink("Atom", source.feeds.atom, { external: true }),
      makeLink("RSS", source.feeds.rss, { external: true }),
    );
    item.append(label, organizationLine, feeds);
    groups.get(source.organization.id).append(item);
  }

  sourceList.replaceChildren(...groups.values());
  selectAllButton.disabled = sources.length === 0;
  clearButton.disabled = sources.length === 0;
}

function renderSets(sets) {
  const cards = sets.map((set) => {
    const card = document.createElement("article");
    card.className = "set-card";
    const heading = document.createElement("h3");
    heading.textContent = set.title;
    const setSources = set.source_ids.map((id) => sources.find((source) => source.id === id)).filter(Boolean);
    const sourceNames = document.createElement("p");
    sourceNames.className = "set-count";
    sourceNames.textContent = `${set.source_ids.length} sources: ${setSources.map((source) => source.name).join(", ")}`;
    const links = document.createElement("p");
    links.className = "set-links";
    links.append(
      makeLink("OPML", set.subscriptions.opml, { external: true }),
      makeLink("JSON Feed bundle", set.bundles.json, { external: true }),
      makeLink("Atom bundle", set.bundles.atom, { external: true }),
      makeLink("RSS bundle", set.bundles.rss, { external: true }),
    );
    card.append(heading, sourceNames, links);
    return card;
  });
  setsList.replaceChildren(...cards);
  if (sets.length === 0) {
    const empty = document.createElement("p");
    empty.textContent = "No curated sets are currently published.";
    setsList.append(empty);
  }
}

async function copyUrls(format) {
  const urls = orderedSelection().map((source) => source.feeds[format]);
  try {
    if (!navigator.clipboard?.writeText) throw new Error("Clipboard access is unavailable");
    await navigator.clipboard.writeText(urls.join("\n"));
    showStatus(`Copied ${urls.length} ${format.toUpperCase()} feed URL${urls.length === 1 ? "" : "s"}.`);
  } catch {
    showStatus("Could not copy URLs. Allow clipboard access in your browser, or open each selected feed link and copy its address.", "error");
  }
}

selectAllButton.addEventListener("click", () => {
  selectedIds = new Set(sources.map((source) => source.id));
  updateSelection({ updateUrl: true });
  showStatus("All sources selected.");
});
clearButton.addEventListener("click", () => {
  selectedIds.clear();
  updateSelection({ updateUrl: true });
  showStatus("Selection cleared.");
});
downloadButton.addEventListener("click", () => {
  const blob = new Blob([buildOpml(orderedSelection())], { type: "text/x-opml;charset=utf-8" });
  const objectUrl = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = objectUrl;
  link.download = "nju-info-hub-subscriptions.opml";
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
  showStatus(`Downloaded OPML for ${selectedIds.size} selected source${selectedIds.size === 1 ? "" : "s"}.`);
});
for (const [format, button] of copyButtons) button.addEventListener("click", () => copyUrls(format));

async function loadCatalog() {
  try {
    const [sourceResponse, setsResponse] = await Promise.all([
      fetch("./sources.json"),
      fetch("./sets.json"),
    ]);
    if (!sourceResponse.ok || !setsResponse.ok) throw new Error("Catalog request failed");
    const [sourceCatalog, setCatalog] = await Promise.all([sourceResponse.json(), setsResponse.json()]);
    if (!Array.isArray(sourceCatalog.sources) || !Array.isArray(setCatalog.sets)) {
      throw new Error("Catalog data is invalid");
    }
    sources = sourceCatalog.sources;
    const query = new URLSearchParams(window.location.search);
    selectedIds = new Set(parseSourceSelection(query.get("sources"), sources.map((source) => source.id)));
    renderSources();
    renderSets(setCatalog.sets);
    updateSelection();
    showStatus(`Loaded ${sources.length} sources and ${setCatalog.sets.length} curated sets.`);
  } catch {
    sourceList.replaceChildren();
    setsList.replaceChildren();
    count.textContent = "Sources unavailable";
    showStatus("Could not load the source catalog. Please try again later.", "error");
  }
}

void loadCatalog();
