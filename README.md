# NJU Info Hub

An unofficial, read-only information aggregation layer for Nanjing University.

> This is a community project and is not affiliated with or endorsed by Nanjing University.

NJU Info Hub aims to turn fragmented public campus information into normalized, traceable standard feeds for readers such as Folo and Zotero, backed by a canonical local data store.

## Status

The public ingestion foundation and two read-only delivery adapters are in place:

- the generic WebPlus/Sudy collector has multi-site fixture coverage, pagination, resilient fetching, and parser hardening;
- raw documents, considered source-item observations, full notice revisions, and attachments are persisted in SQLite;
- a local-facing REST/JSON API serves persisted sources, organizations, and recent **full** notices without collecting or modifying data;
- per-source JSON Feed 1.1, Atom 1.0, and RSS 2.0 publish both full notices and explicit link-only official-list events without contacting upstreams;
- static publication can expose a machine-readable published-source catalog plus reusable source sets as OPML or combined JSON/Atom/RSS timelines;
- Node.js 26 is the default repository runtime and Node.js 24 remains the compatibility floor.

The official instance policy selects twelve sources for collection and independent per-source publication. Unsupported public-WeChat and external-public details require no direct article request and remain `link-only`; recognized campus-network and authentication restrictions also remain visible through their official-list observations. Full public WebPlus details attach as notice revisions, and `fetch` writes no database state.

Public-reader acceptance remains a post-deployment check. Local JSON/XML parsing and packaged CLI smoke establish format and artifact correctness but cannot establish third-party reader admission.

Use GitHub Issues for the current work queue. AI/MCP integration is deferred until a concrete consumer requires it.

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
parsed full notice revision --> full feed entry / optional REST notices
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

`GET /feeds/{sourceId}.{json,atom,rss}` publishes the shared producer recent window (currently up to 100 current source entries) per persisted source in database recency order: a known full notice, or an observed official-list link with no acquired full text. JSON is JSON Feed 1.1 (`application/feed+json`), Atom is Atom 1.0 (`application/atom+xml`), and RSS is RSS 2.0 (`application/rss+xml`); all responses are UTF-8. HTTP Feed responses include a content-derived `ETag`, observation-derived `Last-Modified`, and `Cache-Control: public, max-age=0, must-revalidate`; `If-None-Match` and `If-Modified-Since` are honored with `304`. Unknown sources return a JSON `404`; feed query parameters are rejected with `400`, and non-GET methods return `405`. All formats use the organization — source title, link to the original source list/home page, original item links, and stable IDs formed from percent-encoded source ID and source item ID separated by a colon. A later full acquisition upgrades the **same** feed ID. Local HTTP feeds omit self URLs because a reliable public origin is unknown. `/v1/notices/recent` remains full-notice-only.

The JSON `_nju` extension retains feed-level `source_id` and `organization: { id, name }`; item-level `source_id`, `source_name`, `organization`, `content_status` (`full` or `link-only`), known `acquisition_kind`, optional `observation_revision_number`, and full-only `revision_number` preserve identity and revision status. `fetched_at` and `content_sha256` describe the **detail raw** for full entries, or the **official list raw** for link-only entries; these are response hashes, not revision hashes. Legacy full notices without an observation have no acquisition kind. A link-only item's required feed content is a short, hub-generated unavailability note, **not** an article excerpt or evidence of restricted access; it has no attachments. Once full content exists, a later failed acquisition does not downgrade it. When the source supplies only a calendar day, JSON keeps `published_on` and `date_precision: "day"` under `_nju`; Atom and RSS expose the same information as `nju:published_on` and `nju:date_precision`. For consumer compatibility, a known day is also transported through the standard publication-time fields using a fixed **UTC-noon anchor** (`YYYY-MM-DDT12:00:00Z`). This anchor is not an upstream-authored time; `_nju.date_precision = "day"` / `nju:date_precision` remains authoritative about precision. Unknown days still omit the standard publication-time fields and the day metadata. The canonical database and `/v1` API retain the original day-only value without the transport anchor. Atom entry `updated` is the emitted raw fetch time, **not** an upstream-authored modification time. Atom feed `updated` is the latest emitted entry fetch time, or generation time for an empty feed; RSS channel `lastBuildDate` has the same hub observation/generation meaning.

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

## Static publication policy and curated CS set

`instances/official.json` defines a twelve-source collection and publication policy. The original six sources and Student Affairs use `recentLimit: 10`; Undergraduate School, Youth League, Security Office, Psychology Center, and Logistics use `recentLimit: 5`. The policy keeps one independent JSON/Atom/RSS feed per source. Official-list rows whose detail acquisition is unavailable remain explicit link-only entries. The curated `cs` set remains exactly the three CS sources; only those members belong in its OPML and combined `bundles/cs.{json,atom,rss}` timeline. The current test publisher is the localhost Docker/Compose instance. `.github/workflows/publish-cs-feeds.yml` has `state=disabled_manually` and must remain disabled: Pages is not the current publisher, no schedule or `main` push is publishing these feeds, and deployment acceptance remains pending.

Intended public URL patterns, if a public static publisher is enabled later:

- `https://zhongyangchuwu.github.io/nju-info-hub/feeds/<sourceId>.json`
- `https://zhongyangchuwu.github.io/nju-info-hub/feeds/<sourceId>.atom`
- `https://zhongyangchuwu.github.io/nju-info-hub/feeds/<sourceId>.rss`
- CS OPML: `https://zhongyangchuwu.github.io/nju-info-hub/subscriptions/cs.opml`
- published-source catalog: `https://zhongyangchuwu.github.io/nju-info-hub/catalog/sources.json`
- combined CS timeline: `https://zhongyangchuwu.github.io/nju-info-hub/bundles/cs.{json,atom,rss}`
- curated-set catalog: `https://zhongyangchuwu.github.io/nju-info-hub/catalog/sets.json`
- pilot selector: `https://zhongyangchuwu.github.io/nju-info-hub/catalog/`

When generated, the source catalog lists only the sources selected by the active instance policy, with their original NJU home pages and absolute JSON/Atom/RSS URLs. It is not the complete audited NJU source map from Issue #21 and does not invent channel/authority metadata that is not persisted. The pilot selector reads only static `sources.json` and `sets.json`. It defaults to all published sources when `sources` is absent; `?sources=id1,id2` selects known IDs only, in catalog order. Select all and Clear update the URL without reloading. Arbitrary selections download client-generated OPML (one independent RSS subscription per source) or copy per-source feed URLs; they do **not** acquire a stable combined-feed URL. Only the named `cs` set can have a generated OPML and combined JSON/Atom/RSS timeline, linked through `sets.json`. The page has no account, read state, notification settings, or collector/backend role; this is an engineering pilot, not a polished product.

Static publication is driven by the reviewed instance configuration rather than a second set of export CLI flags. The instance selects the published source allow-list, optional curated set, OPML path under `subscriptions/`, and public base URL; the exporter consumes that contract directly. SQLite retains the complete persisted history, while each RSS/Atom/JSON Feed exposes the producer recent window (currently the latest 100 entries per source) for efficient polling by readers. Each export renders a complete next generation before replacing the publication-owned `feeds/`, `catalog/`, `bundles/`, and `subscriptions/` directories, so a render failure leaves the previous generation intact while unrelated files at the output root are preserved.

To collect and export the same feeds locally, run from the repository root (package scripts use their own working directories):

```bash
ROOT="$PWD"
mkdir -p "$ROOT/.cache/nju-info" "$ROOT/_site"
pnpm nju-info -- collect instances/official.json sources/nju "$ROOT/.cache/nju-info/feeds.sqlite"
pnpm nju-info -- export instances/official.json sources/nju "$ROOT/.cache/nju-info/feeds.sqlite" "$ROOT/_site"
```
The GitHub Pages reference workflow has `state=disabled_manually`; it contains optional cache/WebDAV snapshot handling but is not the current publisher and must not be enabled as part of M2B. Runtime SQLite remains local to the active localhost Docker host. Snapshot format, restore/fallback behavior, WebDAV secrets, and generic self-host rclone usage are documented in [`docs/state-storage.md`](docs/state-storage.md).

WebPlus discovery preserves list-page source/DOM order. Limited `fetch` and `ingest` commands instead rank parseable publication dates newest-first, with stable source-order fallback for equal, missing, or unparseable dates. Limited `fetch` and first-run `ingest` inspect one page beyond the point where enough candidates were found; incremental `ingest` uses known-item overlap plus lookahead. `discover-pages` keeps full source order and pinned items.

On an empty database, `ingest` bootstraps only the configured recent window plus one lookahead page. Once a source has history, it scans until the first non-empty page containing any known source item, then scans one more observation-only lookahead page if available (within the 100-page hard cap). Every item on those pages is observed; unseen items through the overlap page are eligible for enrichment, while `recentLimit` also refreshes up to that many of the newest known items so edits can produce new revisions. If no known overlap appears within 10 search pages, the source fails before observing items or requesting details, rather than treating old history as a new frontier. Unsupported public-WeChat/external items are kept as link-only observations without requesting their details; recognized campus-IP warning pages and NJU unified-identity redirects remain link-only after the ordinary public detail request. Link-only entries do not trigger refill from older history. Unrelated parse/fetch errors still fail. `discover` and `discover-pages` show public list metadata and acquisition classification without fetching details. Ingest persists official-list observations for every unique row discovered on fetched list pages before detail enrichment. Ingest summaries count those persisted list rows as `itemsObserved` and successfully persisted full notices as `noticesIngested`. Direct `fetch` never writes the database.

## Initial sources

The public-source registry and fixtures cover several NJU WebPlus/Sudy sites. The twelve-source official instance policy includes Undergraduate School announcements, Youth League announcements, Student Affairs, Security Office, Psychology Center, and Logistics alongside the original six sources. The localhost Docker/Compose instance is the current test publisher; the GitHub Pages workflow has `state=disabled_manually`, and public deployment acceptance is pending. Restricted, authenticated, public-WeChat, and external-public official-list rows remain visible as link-only entries when full detail cannot be acquired. Student Exchange remains deferred for now. Its older 99-candidate/8-page admission result was measured under the retired full-notice refill behavior and is retained only as historical evidence; it should be re-evaluated separately under the current overlap-frontier semantics before admission.

More sources should preferably be added by contributing YAML under `sources/nju/` rather than adding a new crawler.

## License

License selection is still pending. Until a license is added, normal copyright rules apply.
