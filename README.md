# NJU Info Hub

An unofficial, read-only information aggregation layer for Nanjing University.

> This is a community project and is not affiliated with or endorsed by Nanjing University.

NJU Info Hub aims to turn fragmented public campus information into a normalized, traceable dataset that can be consumed by search tools, feeds, agents, and MCP clients.

## Status

The public ingestion foundation and two read-only delivery adapters are in place:

- the generic WebPlus/Sudy collector has multi-site fixture coverage, pagination, resilient fetching, and parser hardening;
- raw documents, considered source-item observations, full notice revisions, and attachments are persisted in SQLite;
- a local-facing REST/JSON API serves persisted sources, organizations, and recent **full** notices without collecting or modifying data;
- per-source JSON Feed 1.1, Atom 1.0, and RSS 2.0 publish both full notices and explicit link-only official-list events without contacting upstreams;
- static publication can expose a machine-readable published-source catalog plus reusable source sets as OPML or combined JSON/Atom/RSS timelines;
- a local stdio MCP adapter exposes three read-only tools, with recent notices remaining full-only;
- Node.js 26 is the default repository runtime and Node.js 24 remains the compatibility floor.

Limited ingest records each Student Affairs official-list candidate it actually considers, including unsupported public-WeChat links, as a source-item observation before detail acquisition. Unsupported details require no WeChat request and remain `link-only` in local feeds; full public WebPlus details attach as notice revisions. `fetch` writes no database state. The six-source Pages publication allow-list is unchanged; these new sources are **not** publicly deployed. See [#46](https://github.com/zhongyangchuwu/nju-info-hub/issues/46), [#39](https://github.com/zhongyangchuwu/nju-info-hub/issues/39), and [#49](https://github.com/zhongyangchuwu/nju-info-hub/issues/49).

Mixed-feed acceptance in this milestone is local JSON/XML parsing, not a public Folo check: Folo cannot fetch a local URL. Public Folo admission and any new-source Pages publication remain deferred to the subsequent #40 publication expansion; no temporary public feed endpoint is introduced.

Use GitHub Issues for the current work queue; Issue #18 tracks the local MCP adapter.

GitHub is the source of truth for implementation status:

- [Project roadmap](docs/roadmap.md) — long-term phases and architectural boundaries;
- [Issues](https://github.com/zhongyangchuwu/nju-info-hub/issues) — active/planned work;
- [Pull requests](https://github.com/zhongyangchuwu/nju-info-hub/pulls) — implementation and review history.

Current collection targets public NJU WebPlus/Sudy sites. Future public acquisition providers, including public WeChat article sources, should be added only when they have a concrete consumer and tested adapter boundary. Optional local sidecars for private QQ/WeChat groups remain a later phase.

The public core will not log into NJU SSO, personal QQ accounts, or personal WeChat accounts.

## Architecture

```text
source registry (YAML)
        |
        v
source adapters
  - webplus
        |
        v
official list raw + provenance
        |
        +--> considered source-item observation --> link-only feed entry
        |
        v
public detail raw + provenance (when available)
        |
        v
parsed full notice revision --> full feed entry / REST notices / MCP
```

The source adapter boundary is intentionally independent of output protocols. Future WeChat/QQ support should add new adapters or a local sidecar without changing the canonical data model.

## Repository layout

```text
apps/
  nju-info/      product CLI and runtime orchestration
  worker/        collection and ingestion application logic
  api/           optional read-only HTTP adapter
packages/
  core/          shared schemas and canonical types
  collector/     source registry loader and source adapters
  db/            SQLite schema, migrations, and read/write database APIs
  feed/          JSON Feed / Atom / RSS / OPML publication engine
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
pnpm nju-info -- source sources

# discover notices from a live WebPlus list page
pnpm nju-info -- source discover nju-cs-graduate

# fetch and parse the most recent dated detail page
pnpm nju-info -- source fetch nju-cs-graduate 1

# ingest one source into SQLite for source-level debugging
pnpm nju-info -- source ingest nju-cs-graduate /tmp/nju-info.sqlite 10

# serve an existing current-schema database
pnpm nju-info -- serve /tmp/nju-info.sqlite --host 127.0.0.1 --port 3001
```

Source-level fetch and ingest commands access public NJU websites. Unit tests use local fixtures instead.

### Release artifacts

`pnpm build` creates the actual product artifact under `dist/release`: one compiled JavaScript CLI bundle, embedded default source/instance resources, and a minimal package manifest containing only third-party runtime dependencies. `pnpm test:release` packs that directory, installs the tarball into a fresh temporary prefix, and runs the packaged CLI; both Node 24 and Node 26 CI execute this smoke. `pnpm pack:release` produces an installable `.tgz` under `dist/`. The artifact is currently marked `private` so registry publication remains disabled until package naming/version policy is decided. The Docker image is built from the same compiled artifact rather than from workspace TypeScript source.

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

`GET /feeds/{sourceId}.{json,atom,rss}` publishes up to 100 current source entries per persisted source in database recency order: a known full notice, or an observed official-list link with no acquired full text. JSON is JSON Feed 1.1 (`application/feed+json`), Atom is Atom 1.0 (`application/atom+xml`), and RSS is RSS 2.0 (`application/rss+xml`); all responses are UTF-8. Unknown sources return a JSON `404`; feed query parameters are rejected with `400`, and non-GET methods return `405`. All formats use the organization — source title, link to the original source list/home page, original item links, and stable IDs formed from percent-encoded source ID and source item ID separated by a colon. A later full acquisition upgrades the **same** feed ID. Local HTTP feeds omit self URLs because a reliable public origin is unknown. `/v1/notices/recent` remains full-notice-only.

The JSON `_nju` extension retains feed-level `source_id` and `organization: { id, name }`; item-level `source_id`, `source_name`, `organization`, `content_status` (`full` or `link-only`), known `acquisition_kind`, optional `observation_revision_number`, and full-only `revision_number` preserve identity and revision status. `fetched_at` and `content_sha256` describe the **detail raw** for full entries, or the **official list raw** for link-only entries; these are response hashes, not revision hashes. Legacy full notices without an observation have no acquisition kind. A link-only item's required feed content is a short, hub-generated unavailability note, **not** an article excerpt or evidence of restricted access; it has no attachments. Once full content exists, a later failed acquisition does not downgrade it. When the source supplies only a calendar day, JSON keeps `published_on` and `date_precision: "day"` under `_nju`; Atom and RSS expose the same information as `nju:published_on` and `nju:date_precision`. The hub does **not** synthesize a publication time, so JSON `date_published`, Atom `published`, and RSS `pubDate` are omitted until the source provides real timestamp precision. Unknown days omit the extension metadata as well. The canonical database and `/v1` API retain the same day-only precision. Atom entry `updated` is the emitted raw fetch time, **not** an upstream-authored modification time. Atom feed `updated` is the latest emitted entry fetch time, or generation time for an empty feed; RSS channel `lastBuildDate` has the same hub observation/generation meaning.

Full entries preserve original HTML/text and every ordered attachment with inferred MIME type. Atom uses HTML content when available (otherwise text) and one standard `rel="enclosure"` link per full attachment. RSS embeds full attachment links in its item description. Link-only Atom/RSS content carries the same hub-generated availability note, never fabricated article text. Atom and RSS always declare `xmlns:nju="https://zhongyangchuwu.github.io/nju-info-hub/ns/feed"` so day-only `nju:published_on` / `nju:date_precision` metadata is available on dated entries. Link-only entries additionally expose `nju:content_status`, `nju:acquisition_kind` (when known), `nju:fetched_at`, and `nju:content_sha256`. RSS **does not** emit `<enclosure>`: RSS 2.0 requires a reliable byte length, which the canonical attachment model does not store.

| Publication | Paths | Readers |
| --- | --- | --- |
| JSON Feed 1.1 | `feeds/<sourceId>.json` | Folo, Miniflux, NetNewsWire |
| Atom 1.0 | `feeds/<sourceId>.atom` | Zotero, Miniflux, NetNewsWire, general readers |
| RSS 2.0 | `feeds/<sourceId>.rss` | Zotero, Miniflux, NetNewsWire, general readers |
| OPML 2.0 catalog | `subscriptions/<setId>.opml` | Keep selected sources as separate subscriptions in Zotero/general readers |
| Combined source-set feeds | `bundles/<setId>.{json,atom,rss}` | One merged timeline for the selected sources |
| Published-source catalog | `catalog/sources.json` | Machine-readable discovery of the sources included in this publication |
| Curated source-set catalog | `catalog/sets.json` | Versioned metadata for server-published named sets and their absolute OPML/bundle URLs |
| Static source selector | `catalog/` | Pilot browser client of the published catalogs; no account or dynamic feed generation |

## Static published feeds and curated CS set

The `CS feed pilot` workflow runs every two hours or by manual dispatch. The current workflow collects nine explicit sources into one SQLite database. The existing six sources keep their current 10-full-item targets, while `nju-undergraduate-notices` and `nju-youth-league-announcements` target 5 full notices and `nju-student-affairs-notices` targets 10. All nine are exported to the published catalog, selector, and per-source JSON/Atom/RSS feeds. Official-list rows whose detail acquisition is unavailable remain visible as explicit link-only feed entries. The curated `cs` set remains exactly the three CS sources; only those members appear in its OPML and combined `bundles/cs.{json,atom,rss}` timeline. After export, the workflow stages static selector assets in `catalog/`. Readers never trigger collection. Pages is configured at https://zhongyangchuwu.github.io/nju-info-hub/; this nine-source workflow requires post-merge public acceptance before the three newly admitted sources are considered live.

Public per-source URL patterns (for the nine IDs above):

- `https://zhongyangchuwu.github.io/nju-info-hub/feeds/<sourceId>.json`
- `https://zhongyangchuwu.github.io/nju-info-hub/feeds/<sourceId>.atom`
- `https://zhongyangchuwu.github.io/nju-info-hub/feeds/<sourceId>.rss`
- CS OPML: `https://zhongyangchuwu.github.io/nju-info-hub/subscriptions/cs.opml`
- published-source catalog: `https://zhongyangchuwu.github.io/nju-info-hub/catalog/sources.json` (live)
- combined CS timeline: `https://zhongyangchuwu.github.io/nju-info-hub/bundles/cs.{json,atom,rss}`
- curated-set catalog: `https://zhongyangchuwu.github.io/nju-info-hub/catalog/sets.json`
- pilot selector: `https://zhongyangchuwu.github.io/nju-info-hub/catalog/`

The published-source catalog lists only the sources included in the current publication, with their original NJU home pages and absolute JSON/Atom/RSS URLs. It is not the complete audited NJU source map from Issue #21 and does not invent channel/authority metadata that is not persisted. The pilot selector reads only static `sources.json` and `sets.json`. It defaults to all published sources when `sources` is absent; `?sources=id1,id2` selects known IDs only, in catalog order. Select all and Clear update the URL without reloading. Arbitrary selections download client-generated OPML (one independent RSS subscription per source) or copy per-source feed URLs; they do **not** acquire a stable combined-feed URL. Only the named `cs` set has a server-published OPML and combined JSON/Atom/RSS timeline, linked through `sets.json`. The page has no account, read state, notification settings, or collector/backend role; this is an engineering pilot, not a polished product.

Static publication is driven by the reviewed instance configuration rather than a second set of export CLI flags. The instance selects the published source allow-list, per-source feed item limit, optional curated set, OPML path under `subscriptions/`, and public base URL; the exporter consumes that contract directly. Each export renders a complete next generation before replacing the publication-owned `feeds/`, `catalog/`, `bundles/`, and `subscriptions/` directories, so a render failure leaves the previous generation intact while unrelated files at the output root are preserved.

To collect and export the same feeds locally, run from the repository root (package scripts use their own working directories):

```bash
ROOT="$PWD"
mkdir -p "$ROOT/.cache/nju-info" "$ROOT/_site"
pnpm nju-info -- collect instances/official.json sources/nju "$ROOT/.cache/nju-info/feeds.sqlite"
pnpm nju-info -- export instances/official.json sources/nju "$ROOT/.cache/nju-info/feeds.sqlite" "$ROOT/_site"
```
The GitHub Actions SQLite cache remains a best-effort warm-start layer and may be evicted. The Pages workflow can optionally restore and persist a verified durable state snapshot through a WebDAV-backed rclone remote; runtime SQLite still stays on the local runner filesystem. Snapshot format, restore/fallback behavior, WebDAV secrets, and generic self-host rclone usage are documented in [`docs/state-storage.md`](docs/state-storage.md).

The MCP command requires an existing current-schema SQLite database. It exposes only `list_sources`, `list_organizations`, and `list_recent_notices` over stdio; the first two take `{}`, and the third accepts optional `sourceId`, `organizationId`, and `limit` (1–100). Results include matching JSON text and structured content. Configure an MCP host to launch the command as a subprocess; stdout is reserved for protocol messages and startup diagnostics go to stderr. Closing the connection releases the read-only database reader.

WebPlus discovery preserves list-page source/DOM order. Limited `fetch` and `ingest` commands instead rank parseable publication dates newest-first, with stable source-order fallback for equal, missing, or unparseable dates. They inspect one page beyond the point where enough candidates were found; `discover-pages` keeps full source order and pinned items.

Limited `fetch` and `ingest` skip unsupported public-WeChat/external candidates without requesting their details, and skip recognized campus-IP warning pages and NJU unified-identity redirects after a normal public detail request. Each diagnostic reports source ID, item URL, and class on stderr. They continue through later candidates for the requested number of usable public notices, within the existing 100-page discovery cap; unrelated parse/fetch errors still fail. `discover` and `discover-pages` show public list metadata and acquisition classification without fetching details. Ingest persists an official-list observation **immediately before** each considered candidate's acquisition attempt, including skipped and later malformed details; it does not observe every list row fetched for recency lookahead. Ingest summaries count candidates considered as `itemsDiscovered` and usable persisted **full** notices as `noticesIngested`. Direct `fetch` never writes the database.

## Initial sources

The public-source registry and fixtures cover several NJU WebPlus/Sudy sites. The current Pages workflow admits Undergraduate School announcements, Youth League announcements, and Student Affairs alongside the original six published sources. Their restricted/authenticated/public-WeChat official-list rows remain visible as link-only entries when full detail cannot be acquired. Student Exchange remains deferred for now: the latest admission smoke needed 99 candidate checks across 8 pages to obtain 5 full notices, with 94 campus-network-restricted rows, which is too expensive for the current scheduled refill algorithm.

More sources should preferably be added by contributing YAML under `sources/nju/` rather than adding a new crawler.

## License

License selection is still pending. Until a license is added, normal copyright rules apply.
