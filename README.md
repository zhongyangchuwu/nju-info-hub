# NJU Info Hub

An unofficial, read-only information aggregation layer for Nanjing University.

> This is a community project and is not affiliated with or endorsed by Nanjing University.

NJU Info Hub aims to turn fragmented public campus information into a normalized, traceable dataset that can be consumed by search tools, feeds, agents, and MCP clients.

## Status

The public ingestion foundation and two read-only delivery adapters are in place:

- the generic WebPlus/Sudy collector has multi-site fixture coverage, pagination, resilient fetching, and parser hardening;
- raw documents, source items, notice revisions, and attachments are persisted in SQLite;
- a local-facing REST/JSON API serves persisted sources, organizations, and recent notices without collecting or modifying data;
- per-source JSON Feed 1.1, Atom 1.0, and RSS 2.0 publishers serve the same current persisted notices without contacting upstreams;
- a local stdio MCP adapter exposes three read-only tools over the same persisted queries;
- Node.js 26 is the default repository runtime and Node.js 24 remains the compatibility floor.

Use GitHub Issues for the current work queue; Issue #18 tracks the local MCP adapter.

GitHub is the source of truth for implementation status:

- [Project roadmap](docs/roadmap.md) — long-term phases and architectural boundaries;
- [Issues](https://github.com/zhongyangchuwu/nju-info-hub/issues) — active/planned work;
- [Pull requests](https://github.com/zhongyangchuwu/nju-info-hub/pulls) — implementation and review history.

Planned source families include:

- public NJU websites and existing RSSHub routes where useful;
- public WeChat-account articles through replaceable adapters;
- optional local sidecars for private QQ/WeChat groups in a later phase.

The public core will not log into NJU SSO, personal QQ accounts, or personal WeChat accounts.

## Architecture

```text
source registry (YAML)
        |
        v
source adapters
  - webplus
  - rsshub       [planned]
  - generic html [planned]
        |
        v
raw documents + provenance
        |
        v
normalize / enrich
        |
        v
canonical records + revisions
        |
        +--> REST / JSON   [implemented]
        +--> JSON Feed / Atom / RSS [implemented]
        +--> MCP (local stdio) [implemented]
```

The source adapter boundary is intentionally independent of MCP. Future WeChat/QQ support should add new adapters or a local sidecar without changing the canonical data model.

## Repository layout

```text
apps/
  worker/        development CLI for discovery, parsing, and ingestion
  api/           read-only HTTP adapter over persisted queries
  mcp/           read-only local stdio MCP adapter over persisted queries
packages/
  core/          shared schemas and canonical types
  collector/     source registry loader and source adapters
  db/            SQLite schema, migrations, and read/write database APIs
sources/
  nju/           declarative source definitions
```

SQLite persistence is implemented with Node.js 24's built-in `node:sqlite` API. See [`docs/database.md`](docs/database.md) for schema and revision semantics.

## Development

The repository-local mise configuration provides Node.js 26 and pnpm 12.5.1 without changing global tool defaults. Node.js 24 remains the minimum supported runtime and has an explicit compatibility environment.

Requirements:

- mise (configuration verified with mise 2026.9.9)

```bash
# install the default Node 26 toolchain and project dependencies
mise install
mise exec -- node --version
mise exec -- pnpm install

# install and inspect the Node 24 compatibility environment
mise --env node24 install
mise --env node24 exec -- node --version

# run the full check/test/build suite under either environment
mise run verify
mise --env node24 run verify

# with mise shell integration active, project commands are available directly
# list configured sources
pnpm worker -- sources

# discover notices from a live WebPlus list page
pnpm worker -- discover nju-cs-graduate

# fetch and parse the most recent dated detail page
pnpm worker -- fetch nju-cs-graduate 1

# ingest the most recent dated notices and raw documents into SQLite
pnpm worker -- ingest nju-cs-graduate /tmp/nju-info.sqlite 10

# serve an existing current-schema database on 127.0.0.1:3000
pnpm api -- /tmp/nju-info.sqlite

# choose an explicit host and port if local defaults do not fit
pnpm api -- /tmp/nju-info.sqlite --host 127.0.0.1 --port 3001

# serve an existing current-schema database to a local MCP host over stdio
pnpm mcp -- /tmp/nju-info.sqlite
```

Worker fetch and ingest commands access public NJU websites. Unit tests use local fixtures instead.

The API requires an existing current-schema SQLite database; it does not create or migrate one. It binds only to localhost by default. Stop it with SIGINT or SIGTERM; active requests finish before the reader closes. Live WAL reads require the database and SQLite sidecar files to be accessible (see [`docs/database.md`](docs/database.md)).

The `/v1` success responses are JSON with a `data` field. For example:

```bash
curl http://127.0.0.1:3000/v1/health
curl http://127.0.0.1:3000/v1/sources
curl http://127.0.0.1:3000/v1/organizations
curl 'http://127.0.0.1:3000/v1/notices/recent?sourceId=nju-cs-graduate&limit=10'
curl http://127.0.0.1:3000/feeds/nju-cs-graduate.json
curl http://127.0.0.1:3000/feeds/nju-cs-graduate.atom
curl http://127.0.0.1:3000/feeds/nju-cs-graduate.rss
```

Only the recent-notices route accepts `sourceId`, `organizationId`, and `limit`; filters combine, and the default limit is 50 (maximum 100). Unknown IDs return an empty `data` array. Invalid queries return `400`, unknown paths `404`, non-GET methods on known paths `405` (`Allow: GET`), and internal failures `500`, each as `{"error":{"code":"…","message":"…"}}`. Dates and provenance follow the persisted query contract; health is liveness only.

`GET /feeds/{sourceId}.{json,atom,rss}` publishes up to 100 current notices per persisted source in database recency order. JSON is JSON Feed 1.1 (`application/feed+json`), Atom is Atom 1.0 (`application/atom+xml`), and RSS is RSS 2.0 (`application/rss+xml`); all responses are UTF-8. Unknown sources return a JSON `404`; feed query parameters are rejected with `400`, and non-GET methods return `405`. All formats use the organization — source title, link to the original source list/home page, original NJU item links, and stable IDs formed from percent-encoded source ID and source item ID separated by a colon. Refetches and revisions do not change IDs. Local HTTP feeds omit self URLs because a reliable public origin is unknown.

The JSON `_nju` extension retains feed-level `source_id` and `organization: { id, name }`; item-level `source_id`, `source_name`, `organization`, `revision_number`, `fetched_at`, and `content_sha256` preserve provenance. When the source supplies a calendar day, JSON also includes `published_on` and `date_precision: "day"`. Across formats, that source **day** is encoded for transport as `YYYY-MM-DDT00:00:00+08:00` (Asia/Shanghai); it is **not** an exact upstream publication time. JSON `date_published` and Atom `published` use the timestamp directly; RSS `pubDate` carries the equivalent instant in RFC 822/1123 GMT notation. Unknown source days omit these publication dates. The canonical database and `/v1` API retain day-only precision. Atom entry `updated` is the hub's observed current revision fetch time, **not** an upstream-authored modification time. Atom feed `updated` is the latest current entry revision fetch time, or generation time for an empty feed. RSS channel `lastBuildDate` has the same hub observation/generation meaning. JSON `fetched_at` is the raw-document fetch time and `content_sha256` is the linked raw response hash, not revision identity.

JSON preserves original HTML/text and every ordered attachment with inferred MIME type. Atom uses HTML content when available (otherwise text) and one standard `rel="enclosure"` link per attachment. RSS embeds all absolute attachment links in its item description. It **does not** emit RSS `<enclosure>`: RSS 2.0 requires a reliable byte length, which the canonical attachment model does not store. XML does not expose raw content hashes or a custom provenance namespace.

| Publication | Paths | Readers |
| --- | --- | --- |
| JSON Feed 1.1 | `feeds/<sourceId>.json` | Folo, Miniflux, NetNewsWire |
| Atom 1.0 | `feeds/<sourceId>.atom` | Zotero, Miniflux, NetNewsWire, general readers |
| RSS 2.0 | `feeds/<sourceId>.rss` | Zotero, Miniflux, NetNewsWire, general readers |
| OPML 2.0 catalog | `subscriptions/cs.opml` | Bulk import into Zotero and general readers |

## Static CS feeds

The `CS feed pilot` workflow runs every two hours or by manual dispatch. It centrally collects the latest 10 items from exactly `nju-cs-graduate`, `nju-cs-internal-notices`, and `nju-cs-seminars` into one SQLite database, then exports all three formats for each source and `subscriptions/cs.opml` as a GitHub Pages artifact. Readers never trigger a crawl. GitHub Pages is configured at https://zhongyangchuwu.github.io/nju-info-hub/; [the standards-feed deployment](https://github.com/zhongyangchuwu/nju-info-hub/actions/runs/35905071208) succeeded. All nine public JSON/Atom/RSS URLs and the CS OPML catalog are live; Folo's production feed parser accepted all nine per-source feed URLs with `code=0` and `errorMessage=null`.

Public per-source URL patterns (substitute each of the three IDs above):

- `https://zhongyangchuwu.github.io/nju-info-hub/feeds/<sourceId>.json`
- `https://zhongyangchuwu.github.io/nju-info-hub/feeds/<sourceId>.atom`
- `https://zhongyangchuwu.github.io/nju-info-hub/feeds/<sourceId>.rss`
- CS OPML: `https://zhongyangchuwu.github.io/nju-info-hub/subscriptions/cs.opml`

OPML contains exactly the selected source subscriptions, each pointing to its absolute RSS feed and original NJU source page. These direct per-source URLs and CS OPML are pilot interfaces; a future Source Catalog/source selection will generate appropriate sets. Static export accepts an optional `--base-url` for canonical JSON/Atom self URLs, and requires it when `--opml` is supplied; RSS does not add a nonstandard self extension. The original invocation without flags still works.

To collect and export the same feeds locally, run from the repository root (package scripts use their own working directories):

```bash
ROOT="$PWD"
mkdir -p "$ROOT/.cache/nju-info" "$ROOT/_site"
pnpm worker -- ingest nju-cs-graduate "$ROOT/.cache/nju-info/feeds.sqlite" 10
pnpm worker -- ingest nju-cs-internal-notices "$ROOT/.cache/nju-info/feeds.sqlite" 10
pnpm worker -- ingest nju-cs-seminars "$ROOT/.cache/nju-info/feeds.sqlite" 10
pnpm --filter @nju-info/api export-feeds -- "$ROOT/.cache/nju-info/feeds.sqlite" "$ROOT/_site" nju-cs-graduate nju-cs-internal-notices nju-cs-seminars --base-url https://zhongyangchuwu.github.io/nju-info-hub/ --opml subscriptions/cs.opml
```

The GitHub Actions SQLite cache includes the database and SQLite sidecars, but is best-effort and may be evicted. It is not durable storage: collection must be able to rebuild the database from public sources after a cache miss, and older local cache history is not guaranteed to survive.

The MCP command requires an existing current-schema SQLite database. It exposes only `list_sources`, `list_organizations`, and `list_recent_notices` over stdio; the first two take `{}`, and the third accepts optional `sourceId`, `organizationId`, and `limit` (1–100). Results include matching JSON text and structured content. Configure an MCP host to launch the command as a subprocess; stdout is reserved for protocol messages and startup diagnostics go to stderr. Closing the connection releases the read-only database reader.

WebPlus discovery preserves list-page source/DOM order. Limited `fetch` and `ingest` commands instead rank parseable publication dates newest-first, with stable source-order fallback for equal, missing, or unparseable dates. They inspect one page beyond the point where enough candidates were found; `discover-pages` keeps full source order and pinned items.

## Initial sources

The current public-source registry and fixtures cover multiple NJU WebPlus/Sudy sites, including Computer Science, Graduate School, ITSC, Science & Technology, Student Affairs, and student exchange notices. Additional high-value public sources are tracked through the project roadmap and GitHub Issues.

More sources should preferably be added by contributing YAML under `sources/nju/` rather than adding a new crawler.

## License

License selection is still pending. Until a license is added, normal copyright rules apply.
