# NJU Info Hub

An unofficial, read-only information aggregation layer for Nanjing University.

> This is a community project and is not affiliated with or endorsed by Nanjing University.

NJU Info Hub aims to turn fragmented public campus information into normalized, traceable standard feeds for readers such as Folo and Zotero, backed by a canonical local data store.

## Status

The public ingestion foundation and two read-only delivery adapters are in place:

- configuration-driven source adapters cover WebPlus/Sudy, Boshan/NJDX, and public employment information/recruitment APIs with fixture coverage, bounded pagination, resilient fetching, and parser hardening;
- raw documents, considered source-item observations, full notice revisions, and attachments are persisted in SQLite;
- a local-facing REST/JSON API serves persisted sources, organizations, and recent **full** notices without collecting or modifying data;
- per-source JSON Feed 1.1, Atom 1.0, and RSS 2.0 publish both full notices and explicit link-only official-list events without contacting upstreams;
- static publication can expose a machine-readable published-source catalog plus reusable source sets as OPML or combined JSON/Atom/RSS timelines;
- Node.js 26 is the default repository runtime and Node.js 24 remains the compatibility floor.

The official instance policy selects thirty sources for collection and independent per-source publication. Unsupported public-WeChat and external-public details require no direct article request and remain `link-only`; recognized campus-network and authentication restrictions also remain visible through their official-list observations. Full supported public WebPlus, Boshan, and employment-portal details attach as notice revisions, and `fetch` writes no database state.

Public-reader acceptance remains a post-deployment check. Local JSON/XML parsing and packaged CLI smoke establish format and artifact correctness but cannot establish third-party reader admission.

### Restricted QZone acquisition, review and manual audit

`apps/qzone-acquire` is an operator-only restricted acquisition, offline item-review and manual observation-audit tool, not a Hub release or live source integration. Its `acquire` command still writes incomplete evidence/candidates only. Explicit `shadow`/`review` commands derive link metadata and bound decisions; `audit` compares separately prepared manual public-profile observations with verified completed runs and declared failures. None imports, admits sources, publishes feeds, or starts a benchmark. Production read access is provided by the isolated generic Node-only `apps/qzone-gateway`, excluded from the public release and separate from Hub core/runtime. The gateway has no internal workspace dependencies, login/session handling, writes, chat/LLM behavior, or copied provider implementation.

Operate the gateway and collector under separate OS users and environments. Set only the gateway environment's six required variables: `QZONE_GATEWAY_UPSTREAM_URL`, `QZONE_GATEWAY_UPSTREAM_TOKEN`, `QZONE_GATEWAY_READER_TOKEN`, `QZONE_GATEWAY_PUBLISHER_UINS`, `QZONE_GATEWAY_HOST`, and `QZONE_GATEWAY_PORT`. No defaults or checked-in credentials, UINs, or operator paths are provided. The upstream is HTTPS remote or HTTP loopback, origin-only; the listener requires an explicit IP literal or `localhost` and port 0–65535 (0 selects an ephemeral port). Upstream and reader tokens must differ. The gateway accepts only GET on the exact v1 feed/detail routes with the required profile/UIN/limit or UIN:tid parameters, rejects other paths, methods, and malformed/duplicate/unknown parameters before upstream access, denies redirects, retries none, enforces 2 MiB actual response and 30-second timeout bounds, and returns only validated JSON with fixed redacted errors. It does not sanitize provider JSON or grant redistribution rights.

Production uses a private local gateway listener with no TLS and no public exposure. Network-isolate the upstream dashboard from the reader process to prevent bypass; the application boundary alone cannot do that. Keep the broad AstrBot plugin-scope key only in the gateway environment. The collector receives only the reader capability, which authorizes every UIN configured on that gateway. Token rotation is external and requires process restart. A short-lived direct plugin-scope key revoked immediately after smoke remains a qualification option, not least privilege for production. No live gateway deployment or gateway run is established by these repository instructions.

Set gateway-only environment configuration and start it:

```bash
mise exec -- pnpm --filter @nju-info/qzone-gateway serve
```

Separately set collector `QZONE_ASTRBOT_URL` to the private gateway origin and `QZONE_ASTRBOT_TOKEN` to the reader capability, plus `QZONE_ASTRBOT_VERSION`, `QZONE_PLUGIN_VERSION`, and `QZONE_PROTECTED_ROOT`. Collector settings and protected-root rules are unchanged. Keep tokens and operator paths out of tracked configuration; the reviewed source policy still records the stable publisher UIN. Set `POLICY_JSON` to that policy and `RESTRICTED_OUTPUT_ROOT` to the operator-owned restricted evidence directory, then run:

```bash
mise exec -- pnpm --filter @nju-info/qzone-acquire acquire -- "$POLICY_JSON" "$RESTRICTED_OUTPUT_ROOT"
```

The collector calls only the AstrBot v1 feed/detail routes through that bearer capability and always reports discovery incomplete. The gateway passes successful provider JSON, including comments, to the collector; positive extraction still discards prohibited fields, and output remains restricted, not public-safe. Keep evidence outside the repository, Hub state/backups/public directories, and platform session paths. Never publish without separate content/privacy/audience/redistribution review and public-safe bundle approval. See the [credentialed-public acquisition ADR](docs/adr-credentialed-public-acquisition.md) for exact protocol, failure and deployment boundaries, and the [prospective benchmark](docs/social-acquisition-benchmark.md) for what remains unmeasured.

The offline [QZone shadow/item-review flow](docs/adr-credentialed-public-acquisition.md#qzone-offline-shadow-and-item-review) accepts only current public relay/sentinel `review-only` policies. Supply only `QZONE_PROTECTED_ROOT` in the offline environment; no provider URL or token is required. All arguments are absolute private paths outside repository/protected storage. Select native item IDs and safe titles explicitly, then submit decisions bound to the generated review request:

```bash
mise exec -- pnpm --filter @nju-info/qzone-acquire shadow -- "$ACQUISITION_RUN" "$SELECTION_JSON" "$POLICY_JSON" "$SHADOW_OUTPUT_ROOT"
mise exec -- pnpm --filter @nju-info/qzone-acquire review -- "$SHADOW_RUN" "$DECISIONS_JSON" "$POLICY_JSON" "$REVIEW_OUTPUT_ROOT"
```

Shadow decisions start `review-required`; an explicit review can record `approved / link-only`, `rejected / none`, or `review-required / none`. Reviewer/private reasons remain restricted. Even approved declarations retain **`publicationEligible=false`, `bundleEligible=false`**: these flags confer no importer authorization, real source admission or benchmark eligibility. Publication requires the separate independent signed operation below; title/link privacy and rights remain human responsibilities.

The [manual source-observation audit](docs/adr-credentialed-public-acquisition.md#qzone-manual-source-observation-audit) uses a separately prepared public-profile post list, capture cutoff, verified successful run directories and explicitly declared failed attempts. It deduplicates native identities, distinguishes missing/partial/unknown/conflicting observations, and returns N/A rates when the manual denominator is incomplete or inconsistent. It requires only `QZONE_PROTECTED_ROOT` and writes private immutable ledgers:

```bash
mise exec -- pnpm --filter @nju-info/qzone-acquire run audit -- "$MANUAL_AUDIT_JSON" "$OBSERVATIONS_JSON" "$POLICY_JSON" "$AUDIT_OUTPUT_ROOT"
```

Use explicit `run audit`: bare `pnpm audit` is the package manager's dependency-audit command, not this script. Audited post-capture ratios are scoped operator declarations, not campus/event/public-feed recall or image usability. All outputs retain publicationEligible=false, bundleEligible=false and benchmarkStarted=false; empty provider discovery never proves an empty publisher timeline.

### WeRead latest qualification, shadow and observations

The separate operator-only [WeRead latest qualification/shadow app](docs/adr-credentialed-public-acquisition.md#weread-latest-qualification-boundary) validates complete native identity and can explicitly derive a link-only `SocialAcquisitionBundle v1` using a separately reviewed official `review-only` policy. Its decision remains `review-required`, never publication approval. The acquisition app itself neither imports nor publishes; the independent authenticated metadata boundary below does not start the thirty-day benchmark.

The offline `observe` command compares supplied completed qualification runs and operator-declared blocked/error/empty attempts. It deduplicates canonical `__biz + mid + idx`, not provider review IDs, and records scoped sightings, content-hash variants and new-native-item clocks. Stale export reprocessing does not imply fresh upstream success; failures and empty results never advance progress. Publication conflicts suppress the newest-known-publication pointer. `cursor` and `coveredThrough` remain null: latest-only observations cannot establish a lossless historical checkpoint or benchmark recall.

```bash
# Only WECHAT_WEREAD_PROTECTED_ROOT is required; declarations and outputs stay private.
mise exec -- pnpm --filter @nju-info/wechat-weread-acquire run observe -- "$WEREAD_OBSERVATIONS_JSON" "$WEREAD_OBSERVATION_OUTPUT_ROOT"
```

### Authenticated metadata import, correction and withdrawal

`apps/social-import` is a separate private offline operator tool, excluded from normal releases. It authenticates distinct Ed25519 producer receipts and operator authorization against explicit external trust, checks the complete current source registration and exact supported metadata bytes, then commits immutable evidence and native-item revisions atomically. Empty trust denies all; full/media packets are rejected, never clipped. No real source or official-instance selection is changed.

Set canonical `SOCIAL_IMPORT_PROTECTED_ROOT`; use absolute owner-private paths outside repository/provider storage and a separately selected private database parent. After independent audience/privacy/redistribution/item review:

```bash
mise exec -- pnpm --filter @nju-info/social-import run producer-sign -- "$PUBLIC_SAFE_DIR" "$PRODUCER_ID" "$PRODUCER_PRIVATE_KEY" "$RECEIPT_JSON"
mise exec -- pnpm --filter @nju-info/social-import run authorize -- "$TRUST_JSON" "$OPERATION_DRAFT_JSON" "$APPROVER_PRIVATE_KEY" "$SIGNED_OPERATION_JSON"
mise exec -- pnpm --filter @nju-info/social-import run import -- "$TRUST_JSON" "$SIGNED_OPERATION_JSON" "$PUBLIC_SAFE_DIR" "$DATABASE"
# Signed suppress/revoke-source operations use no producer bundle:
mise exec -- pnpm --filter @nju-info/social-import run import -- "$TRUST_JSON" "$SIGNED_CONTROL_JSON" - "$DATABASE"
```

Use a completed producer run's `public-safe` subtree, never its restricted run root. [The ADR](docs/adr-credentialed-public-acquisition.md#authenticated-metadata-import-and-lifecycle) owns strict trust/draft schemas, signing preimages, storage/byte limits and lifecycle rules. Signed corrections keep native feed IDs stable; exact replay cannot undo newer state; publish cannot clear suppression, explicit restore can, and source revocation is terminal. Public queries/JSON/Atom/RSS preserve native precision and unknown-origin/relay status without exposing operator audit data. Social HTTP feeds use ETags rather than IMS-only caching; static withdrawals require re-export. Keep DB/sidecars/backups/signing records private. Synthetic local CLI/HTTP/static verification is not real source admission, public deployment, third-party reader acceptance or benchmark Day 1.


The [2026-10-08 social acquisition Agent handoff](docs/social-acquisition-handoff-2026-10-08.md) records merged PRs, open Issues, verified paths, admission blockers, and next-Agent verification steps. The machine-specific operator snapshot is stored outside Git and should never be committed.

Use GitHub Issues for the current work queue. AI/MCP integration is deferred until a concrete consumer requires it.

GitHub is the source of truth for implementation status:

- [Project roadmap](docs/roadmap.md) — long-term phases and architectural boundaries;
- [Issues](https://github.com/zhongyangchuwu/nju-info-hub/issues) — active/planned work;
- [Pull requests](https://github.com/zhongyangchuwu/nju-info-hub/pulls) — implementation and review history.

Current collection targets public NJU sources through explicit, tested adapters rather than one crawler shape. WebPlus/Sudy, Boshan/NJDX, and public employment information/recruitment streams are supported; future providers, including public WeChat article discovery, should be added only behind the same replaceable adapter boundary. Optional local sidecars for private QQ/WeChat groups remain a later phase.

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

The QZone/AstrBot acquisition and offline review paths remain outside Hub core/runtime and the public release. `apps/qzone-gateway` remains a separate private read capability. The independent operator-only `apps/social-import` connects authenticated public-safe link metadata to common DB/feed/API output and signed correction/withdrawal state; it does not activate real collectors, live sources, publication deployment or automatic scheduling. Private/local sidecars remain separate.

## Repository layout

```text
apps/
  nju-info/      product CLI and runtime orchestration
  qzone-acquire/ restricted acquisition, offline shadow/item-review and manual audit ledger
  qzone-gateway/ private Node-only read-only capability gateway
  api/           optional read-only HTTP adapter
  wechat-weread-acquire/  offline qualification, review-required shadow and scoped observation ledger
  social-import/ private offline producer/operator signing and authenticated metadata lifecycle
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

`instances/official.json` defines a thirty-source collection and publication policy. The original six sources and Student Affairs use `recentLimit: 10`; Academic Calendar uses `recentLimit: 1`; every other official source uses `recentLimit: 5`. The policy keeps one independent JSON/Atom/RSS feed per source. Official-list rows whose detail acquisition is unavailable remain explicit link-only entries. The curated `cs` set remains exactly the three CS sources; only those members belong in its OPML and combined `bundles/cs.{json,atom,rss}` timeline. The current test publisher is the localhost Docker/Compose instance. `.github/workflows/publish-cs-feeds.yml` has `state=disabled_manually` and must remain disabled: Pages is not the current publisher, no schedule or `main` push is publishing these feeds, and deployment acceptance remains pending.

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

A source-only publication may omit `catalog/sets.json`. The selector treats that file's HTTP 404 as no curated sets while retaining source selection and subscription links. Source-catalog failures, other set-catalog HTTP failures, and malformed available catalog data remain errors; missing optional sets must not hide a failed source publication.

To collect and export the same feeds locally, run from the repository root (package scripts use their own working directories):

```bash
ROOT="$PWD"
mkdir -p "$ROOT/.cache/nju-info" "$ROOT/_site"
pnpm nju-info -- collect instances/official.json sources/nju "$ROOT/.cache/nju-info/feeds.sqlite"
pnpm nju-info -- export instances/official.json sources/nju "$ROOT/.cache/nju-info/feeds.sqlite" "$ROOT/_site"
```
The GitHub Pages reference workflow has `state=disabled_manually`; it contains optional cache/WebDAV snapshot handling but is not the current publisher and must remain disabled while public deployment acceptance is pending. Runtime SQLite remains local to the active localhost Docker host. Snapshot format, restore/fallback behavior, WebDAV secrets, and generic self-host rclone usage are documented in [`docs/state-storage.md`](docs/state-storage.md).

WebPlus discovery preserves list-page source/DOM order. Limited `fetch` and `ingest` commands instead rank parseable publication dates newest-first, with stable source-order fallback for equal, missing, or unparseable dates. Limited `fetch` and first-run `ingest` inspect one page beyond the point where enough candidates were found; incremental `ingest` uses known-item overlap plus lookahead. `discover-pages` keeps full source order and pinned items.

On an empty database, `ingest` bootstraps only the configured recent window plus one lookahead page. Once a source has history, it scans until the first non-empty page containing any known source item, then scans one more observation-only lookahead page if available (within the 100-page hard cap). Every item on those pages is observed; unseen items through the overlap page are eligible for enrichment, while `recentLimit` also refreshes up to that many of the newest known items so edits can produce new revisions. If no known overlap appears within 10 search pages, the source fails before observing items or requesting details, rather than treating old history as a new frontier. Unsupported public-WeChat/external items are kept as link-only observations without requesting their details; recognized campus-IP warning pages and NJU unified-identity redirects remain link-only after the ordinary public detail request. Link-only entries do not trigger refill from older history. Unrelated parse/fetch errors still fail. `discover` and `discover-pages` show public list metadata and acquisition classification without fetching details. Ingest persists official-list observations for every unique row discovered on fetched list pages before detail enrichment. Ingest summaries count those persisted list rows as `itemsObserved` and successfully persisted full notices as `noticesIngested`. Direct `fetch` never writes the database.

## Initial sources

The public-source registry and fixtures cover NJU WebPlus/Sudy, Boshan/NJDX, and public employment information/recruitment streams. The official instance now contains thirty sources, including the employment streams, Student Exchange, Science and Technology Office notices, the low-frequency Academic Calendar feed, and nine representative college feeds spanning AI, Software, Mathematics, Physics, Business, Chemistry/Chemical Engineering, Environment, Earth Sciences/Engineering, and Modern Engineering/Applied Sciences. The localhost Docker/Compose instance remains the current test publisher, while public deployment acceptance is still pending.

More sources should preferably be added by contributing YAML under `sources/nju/` rather than adding a new crawler.

## License

License selection is still pending. Until a license is added, normal copyright rules apply.
