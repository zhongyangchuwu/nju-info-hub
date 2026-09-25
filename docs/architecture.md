# Architecture

## Scope

NJU Info Hub is a read-only aggregation layer for public Nanjing University information.

The public service is intentionally separated from any future private-message ingestion. Public website collectors may run on a server; personal QQ/WeChat collection, if implemented later, should run as a local sidecar and expose only user-controlled local data.

## Data flow

```text
source registry
    |
    v
source adapter
    |
    +--> official list raw + provenance
    |         |
    |         +--> considered source-item observation --> link-only syndication
    |
    +--> public detail raw + provenance (when available)
              |
              v
         parsed full notice revision --> full syndication / REST notices / MCP

published-source catalog / curated sets --> select syndication membership
```

The registry, WebPlus/Sudy adapter, raw-document/list-observation/full-notice persistence, read-only REST/standard syndication output, and local stdio MCP adapter are implemented. Output processes read existing persisted entries through `@nju-info/db`; collection remains a separate process.

## Source registry

Source metadata lives in `sources/nju/*.yaml` and is validated with Zod before use.

Most new WebPlus/Sudy sources should require configuration only. Source-specific selectors are supported as escape hatches, but generic defaults should be preferred when they are reliable.

## Adapter boundary

An adapter is responsible for source-specific acquisition and parsing. It must not depend on a web UI, MCP, or downstream storage.

The first adapter targets common WebPlus/Sudy conventions observed on multiple NJU sites:

- list pages commonly contain `.news_list`, `.wp_article_list`, or `.listcon`;
- detail links commonly end in `/page.htm` or `/pagem.htm`;
- titles commonly use `.arti_title`;
- publication metadata commonly uses `.arti_update`;
- article content commonly uses `.wp_articlecontent`;
- uploaded files commonly live under `/_upload/article/files/`;
- embedded PDFs may be referenced only through `pdfsrc`.

The parser keeps heuristics narrow so that navigation links are not mistaken for notices.

List discovery preserves source/DOM order, including pinned or featured items. Publication-recency ordering is a separate operation: parseable dates are ordered newest-first, equal dates retain source order, and missing or unparseable dates follow dated items while retaining their source order. The development CLI applies that ordering only to limited `fetch` and `ingest` operations. It reads one additional page after first collecting enough candidates, bounded by the command's page cap, so first-page pinned items do not displace newer dated notices on the next page. Full `discover-pages` results remain in source order and retain pinned items.

Discovery labels each list item `webplus-detail`, `public-wechat`, or `external-public` without fetching the detail; explicitly configured list selectors may include external links, while default discovery remains limited to WebPlus-shaped article URLs. Limited `fetch` and `ingest` preflight each candidate: unsupported acquisition is skipped without a detail request, and recognized campus-network warnings or observable NJU unified-identity redirects are skipped after an ordinary public request. During ingest, the worker persists the official list observation immediately before attempting each candidate; recency-lookahead rows never considered are not persisted as observations. The worker reports source, item URL, and skip class, then continues through later candidates within the 100-page cap; ordinary malformed details remain errors. Neither restricted nor unsupported details become parsed full notices or persisted detail raw bodies, but the observed list item remains link-only for feeds.

## Raw and canonical data

`RawDocument` preserves:

- source id;
- final URL after redirects;
- fetch timestamp;
- content type;
- raw body;
- SHA-256 content hash.

The raw/canonical split is deliberate. A future database should retain raw payloads so parser improvements can be replayed without fetching historical pages again.

`ParsedNotice` contains the source item identity, title, original publication text, nullable normalized calendar date (`publishedOn`), normalized text/HTML content, attachments, and provenance. The date is not a timestamp or inferred timezone. Deadline extraction, audience classification, cross-source deduplication, and canonical notice identity are intentionally deferred.

## Persistence

`packages/db` uses Node.js 24's built-in `node:sqlite` API. The current schema keeps the v0.1 identity model deliberately small:

```text
sources
raw_documents
source_items
source_item_observations
notice_revisions
attachments
```

A source item is one publication identity at one source. An observation is a versioned official-list fact (title, day, acquisition kind, list-raw provenance) recorded before detail acquisition; a notice revision is a separate full parsed snapshot linked to detail raw. The shared URL-derived item ID joins them without changing existing identities. Consecutive identical observations are idempotent; changed metadata (including a return to an earlier value) creates a new observation revision. The notice-revision content hash covers the parsed URL, title, raw publication text, body, and attachment metadata; the deterministic derived date is not part of revision identity. Re-ingesting identical parsed content is idempotent; changed parsed content creates the next notice revision. A later unavailable detail never erases a known full notice.

There is no separate canonical `notices` table yet. Cross-source semantic deduplication is deferred until real consumers require it. Detailed schema and transaction semantics are documented in [`database.md`](database.md).

Direct `fetch` remains sufficient for the current public WebPlus sources; persistence does not introduce a requirement for Crawlee or browser orchestration.

## Read-only HTTP delivery

`apps/api` uses Node's HTTP server and only the `@nju-info/db` reader. It serves health, persisted source and organization summaries, current recent **full** notice revisions at `/v1/notices/recent`, and mixed full/link-only source entries in per-source JSON Feed 1.1, Atom 1.0, and RSS 2.0. The server cannot ingest, create, or migrate a database and does not load the source registry. Its local feeds omit self URLs because a reliable public origin is unknown. The server defaults to a local bind; see the README for commands and routes.

## Standard syndication output layer

The read-only output layer projects persisted source entries (latest official list observation with optional latest full notice, or legacy full notice alone) into one format-neutral feed model before serialization. Stable source-item IDs, organization/source identity, original item and source URLs, day transport value, and selected raw provenance share one mapping. Full entries retain detail title/date/body/attachments and detail-raw provenance; link-only entries use list title/date/list-raw provenance, no article body or attachments, and a short hub-generated availability note. JSON Feed marks `_nju.content_status` as `full` or `link-only` and exposes known acquisition kind; Atom/RSS carry the same availability note and a namespaced link-only status, acquisition kind, and list-raw fetch time/hash. JSON Feed retains structured provenance and full attachments; Atom uses standard enclosure links; RSS uses item-description attachment links, not `<enclosure>` without reliable byte length. No format triggers crawling or changes database precision. Publication days remain `YYYY-MM-DD` in the database and `/v1` API; transport uses start-of-day Asia/Shanghai (`YYYY-MM-DDT00:00:00+08:00`), not an exact source time. Atom `updated` uses the emitted entry's raw fetch time (detail for full, list for link-only), with maximum across entries or generation time when empty. RSS `lastBuildDate` is likewise hub observation/build metadata, not upstream modification time. Full-only XML feeds remain unchanged.

The static exporter takes a publication allow-list and writes `.json`, `.atom`, and `.rss` for each selected source. With a validated public base URL it writes `catalog/sources.json` for that complete publication selection, with absolute feed URLs. A named curated set is explicit and separate: its required source IDs are resolved against the published selection, and only those members appear in the set's OPML and combined feeds. The versioned `catalog/sets.json` records the resolved membership and absolute OPML (defaulting to `subscriptions/<setId>.opml`) and combined JSON/Atom/RSS bundle URLs. Without a named set, OPML uses the publication selection. The exporter owns and replaces the generated catalog directory; Pages copies static `index.html`, JavaScript, and CSS there only after export. The pilot selector reads these static catalogs; it does not generate server-side arbitrary combined feeds or expand the central publication allow-list.

The Pages workflow publishes ITSC, Library, and Graduate School alongside the three CS sources; the six-source deployment is live. Its `cs` set still contains only those three CS IDs. The registered Undergraduate School announcements source remains unpublished pending Issue #39's restricted-detail acceptance and limited-ingest smoke.

## Read-only local MCP delivery

`apps/mcp` serves stdio tools over `InfoHubDatabaseReader`: source summaries, organization summaries, and current recent **full** notices with optional source/organization filters and limit. It opens an existing current-schema database read-only, never imports collectors or the source registry, and does not own query ordering, revisions, or provenance semantics. MCP notice output remains full-only; it never returns link-only observations. stdout carries MCP messages only; diagnostics use stderr.

## Future adapters

Potential public adapters:

- RSSHub feeds;
- generic HTML;
- public WeChat-account feeds through replaceable upstream services.

Potential private/local adapters:

- QQ via a local OneBot/NapCat sidecar;
- desktop WeChat local-only extraction.

Private adapters must not be required by the public core and must not upload personal chat histories by default.

## Deferred work

The following are deliberately not part of the current milestone:

- dynamic plugin loading;
- Crawlee/Playwright orchestration;
- distributed queues;
- PostgreSQL;
- vector databases;
- LLM extraction;
- saved personal source sets / read state;

They should be introduced only when a concrete requirement appears.

