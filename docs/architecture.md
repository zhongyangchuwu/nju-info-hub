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
    +--> RSS / Atom
    +--> MCP
```

The registry, WebPlus/Sudy adapter, raw-document and notice persistence, and read-only REST/JSON and local stdio MCP output adapters are implemented. Both output processes read existing canonical records through `@nju-info/db`; collection remains a separate process.

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

`apps/api` uses Node's HTTP server and only the `@nju-info/db` reader. It serves health, persisted source and organization summaries, and current recent notice revisions. It cannot ingest, create, or migrate a database and does not load the source registry. The server defaults to a local bind; see the README for its command and routes. RSS/Atom and search remain separate future output/query capabilities.

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
- RSS/Atom and search interfaces;
- web frontend.

They should be introduced only when a concrete requirement appears.

