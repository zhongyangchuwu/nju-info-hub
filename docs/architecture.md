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

The current proof of concept implements only the registry, WebPlus/Sudy adapter, raw-document representation, and parsed notice representation.

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

## Raw and canonical data

`RawDocument` preserves:

- source id;
- final URL after redirects;
- fetch timestamp;
- content type;
- raw body;
- SHA-256 content hash.

The raw/canonical split is deliberate. A future database should retain raw payloads so parser improvements can be replayed without fetching historical pages again.

`ParsedNotice` currently contains the source item identity, title, publication text, normalized text/HTML content, attachments, and provenance. Deadline extraction, audience classification, cross-source deduplication, and canonical notice identity are intentionally deferred.

## Persistence plan

SQLite is the intended first persistence layer. Drizzle is a candidate ORM, but it is not added until real parser samples settle the schema.

Expected logical tables:

```text
sources
fetches
raw_documents
source_items
notices
notice_revisions
attachments
```

Cross-source deduplication should distinguish:

- source item: one publication at one source;
- canonical notice: the underlying information item;
- revision: a changed version of one publication.

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
- REST API;
- MCP server;
- web frontend.

They should be introduced only when a concrete requirement appears.

