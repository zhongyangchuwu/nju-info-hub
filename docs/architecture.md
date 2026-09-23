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
    +--> raw document + provenance + content hash
    |
    v
parser / normalizer
    |
    v
canonical record + revisions
    |
    +--> search
    +--> REST / JSON
    +--> standard syndication (JSON Feed / Atom / RSS; OPML catalog)
    +--> MCP
```

The registry, WebPlus/Sudy adapter, raw-document and notice persistence, read-only REST/standard syndication output, and local stdio MCP adapter are implemented. Output processes read existing canonical records through `@nju-info/db`; collection remains a separate process.

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
notice_revisions
attachments
```

A source item is one publication identity at one source. A notice revision is a parsed snapshot linked to the raw document that produced it. The revision content hash covers the parsed URL, title, raw publication text, body, and attachment metadata; the deterministic derived date is not part of revision identity. Re-ingesting identical parsed content is idempotent; changed parsed content creates the next revision for that source item.

There is no separate canonical `notices` table yet. Cross-source semantic deduplication is deferred until real consumers require it. Detailed schema and transaction semantics are documented in [`database.md`](database.md).

Direct `fetch` remains sufficient for the current public WebPlus sources; persistence does not introduce a requirement for Crawlee or browser orchestration.

## Read-only HTTP delivery

`apps/api` uses Node's HTTP server and only the `@nju-info/db` reader. It serves health, persisted source and organization summaries, current recent notice revisions, and per-source JSON Feed 1.1, Atom 1.0, and RSS 2.0. The server cannot ingest, create, or migrate a database and does not load the source registry. Its local feeds omit self URLs because a reliable public origin is unknown. The server defaults to a local bind; see the README for commands and routes.

## Standard syndication output layer

The read-only output layer projects current canonical SQLite notice revisions into a small format-neutral feed model before serialization. Stable source-item IDs, organization/source identity, original item and source URLs, day transport value, current-revision fetch time, content, and inferred attachment MIME types share one mapping. JSON Feed retains structured `_nju` provenance and all attachments; Atom uses standard enclosure links; RSS uses item-description attachment links, not `<enclosure>` without reliable byte length. No format triggers upstream crawling, changes database precision, or introduces a new collector. Publication days remain `YYYY-MM-DD` in the database and `/v1` API; transport uses start-of-day Asia/Shanghai (`YYYY-MM-DDT00:00:00+08:00`), not an exact source time. Atom `updated` is observed current-revision fetch time and feed `updated` is its maximum (explicit generation time for empty feeds). RSS `lastBuildDate` is likewise hub observation/build metadata, not upstream modification time. The Atom and RSS XML deliberately omit content hashes and custom namespaces.

The static exporter reads the same persisted current revisions and writes `.json`, `.atom`, `.rss` for each selected source; it owns/replaces only the `feeds` directory and optionally writes an OPML subscription catalog under the output directory. A validated public base URL supplies JSON/Atom canonical self URLs and absolute RSS subscriptions in OPML. The catalog is selected-source metadata, not a personalized feed or user state. Pages currently selects only the three public CS sources, refreshes the shared SQLite cache on its two-hour schedule, and publishes `subscriptions/cs.opml` along with their feeds. The best-effort cache can be rebuilt after eviction; readers of static files do not run a collector. The standards-feed CS Pages deployment has succeeded publicly for JSON, Atom, RSS, and the CS OPML catalog; this still does not establish durable storage or extend the pilot beyond these three sources.

## Read-only local MCP delivery

`apps/mcp` serves stdio tools over the same `InfoHubDatabaseReader` queries: source summaries, organization summaries, and current recent notices with optional source/organization filters and limit. It opens an existing current-schema database read-only, never imports collectors or the source registry, and does not own query ordering, revisions, or provenance semantics. stdout carries MCP messages only; diagnostics use stderr.

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
- combined personalized feeds and source selection;
- web frontend.

They should be introduced only when a concrete requirement appears.

