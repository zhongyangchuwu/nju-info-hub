# Architecture

## Scope

NJU Info Hub is a read-only aggregation layer for public Nanjing University information.

The public service is intentionally separated from any future private-message ingestion. Public website collectors may run on a server; personal QQ/WeChat collection, if implemented later, should run as a local sidecar and expose only user-controlled local data.

Approved public-channel enumeration through isolated dedicated service accounts is a separate central acquisition category, not private-message ingestion. The [credentialed-public acquisition ADR](adr-credentialed-public-acquisition.md) defines policy and authenticated metadata contracts; the [thirty-day benchmark](social-acquisition-benchmark.md) defines prospective admission evidence. `apps/qzone-acquire` remains excluded from normal releases and has no Hub DB/feed/runtime dependencies: its network acquisition creates restricted incomplete evidence, while offline shadow/review commands derive link metadata and bound declarations. Those declarations are not independently authenticated publication authority. The separate operator-only importer can apply independently signed metadata operations, but no real source/admission/public deployment or benchmark is established.

`apps/qzone-gateway` is a separate generic Node-only read-only capability gateway, excluded from Hub core/runtime and the public release. It has no internal workspace dependencies, login/session handling, writes, chat, LLM, plugin loader, or copied provider implementation. It accepts only the exact GET feed/detail routes and allowlisted UIN-scoped query shapes, replaces the downstream reader bearer with the gateway-only upstream token, and rejects invalid requests before upstream access. See the ADR for body/time bounds, fixed redacted failures, environment separation, and private deployment requirements. Its successful provider JSON is passed through—including comments—so it is not a sanitizer or rights approval. The gateway does not establish that a live private deployment is running.

Deploy provider/gateway and collector under separate operator OS users and environments. Only the gateway receives the broad AstrBot plugin-scope token. It also holds the reader capability for verification; the collector receives only that reader capability via unchanged `QZONE_ASTRBOT_URL` and `QZONE_ASTRBOT_TOKEN` settings. Keep the local gateway private, without built-in TLS or public exposure, and network-isolate the upstream dashboard from the reader process to prevent bypass. Its reader capability authorizes all UINs configured on that gateway. Credential/session state and login recovery remain external.

The acquisition tool makes one first-page profile feed request and serialized per-post detail requests only. Discovery is always reported incomplete, even for an empty feed or `has_more: false`; it has no scheduler, cursor/checkpoint, retries, login, status endpoint, write actions, or media downloads. Credentials/session state remain external, and its restricted output is not public-safe or eligible for Hub state/backups. See the ADR for operator configuration, evidence format, safe storage, and smoke instructions.

The offline QZone flow verifies completed acquisition manifests, feed/detail blob bytes and canonical candidate projections before selecting items. A current relay/sentinel review-only policy and explicit manual titles produce a metadata-only pending shadow; declared decisions cover every selected item and match its exact binding/complete current policy fingerprint. Source qualification, declared reviewer/private reasons and restricted body/media evidence stay separate from public-safe metadata. Approved declarations remain private and report publicationEligible=false/bundleEligible=false; changed policy or payload needs a fresh review. Public publication state is established only by a separate producer receipt plus independently signed operator authorization, never by the exported approved flag.

An additional offline manual-audit command compares independent operator public-profile declarations with verified completed acquisition runs and declared failure attempts. It uses the same canonical evidence verifier and private namespace guards as shadow creation, discards provider bodies/media after extracting compact identity/time summaries, and creates no public-safe bundle. Native-ID sightings are deduplicated; incomplete/uncertain/conflicting manual coverage cannot yield a fabricated complete denominator. Post capture and partial content are separate, failure declarations are not machine-authenticated evidence, and observation clocks are scoped to the supplied run set. These private ledgers do not establish event recall, source admission, publisher originality, public delivery or benchmark Day 1.

`apps/wechat-weread-acquire` is an operator-only offline WeRead latest qualification/shadow app. Its explicit shadow emits only reviewed-policy-gated link metadata with a review-required decision; it has no provider runtime, network collection, importer or scheduler. The separate authenticated importer can consume its current metadata projection after independent authorization; shadow generation alone does not authorize publication or start the prospective benchmark.

Its separate offline `observe` flow verifies only restricted qualification evidence from supplied completed runs and combines compact native identity/time/hash summaries with declared blocked/error/empty attempts. Provider aliases never reset deduplication; upstream export observation clocks, not later processing clocks, determine freshness. Failures cannot advance progress; conflicts suppress publication progress. Immutable private ledgers keep an explicit supplied-run scope and null cursor/covered-through fields, not a historical completeness claim. They neither verify optional public-safe shadow artifacts nor authorize publication or source admission.

`apps/social-import` is a separate private offline operator workspace excluded from normal releases, depending only on Core/DB and Node built-ins. Strict external trust binds stable native publishers, full current qualification, distinct Ed25519 producer/approver public keys and allowlists. Exact signed bundle bytes and positive metadata blobs are checked under shared count/byte limits, with duplicate JSON members, bodies/assets and unsupported projection versions rejected. Explicit canonical private paths exclude repository/provider storage before inspection; no network, provider credentials, default DB, automatic signing/review or real source registration is supplied.

Schema v6 adds immutable signed operation/exact raw evidence, native material revisions, current per-item authorization, source state and suppression tombstones. Admission/replay expiry is separate from qualification-based serving expiry. Source-scoped monotonic operations implement correction, cold suppression, explicit restore and terminal revocation; ownership checks prevent website/social namespace overwrite. Common writer/read-only queries hide withdrawn/expired/old-policy items; API/feed outputs preserve native precision/role and distinguish upstream acquisition from operation modification clocks. ETags are authoritative for social conditional requests, combined XML includes source lifecycle clocks, and static exports replace owned directories so revoked sources/sets become empty with explicit catalog status. DB audit records/backups stay private; only public-safe item projections reach readers.


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
         parsed full notice revision --> full syndication / optional REST notices

published-source catalog / curated sets --> select syndication membership
```

The registry, WebPlus/Sudy adapter, raw-document/list-observation/full-notice persistence, standard syndication output, and optional read-only REST adapter are implemented. `packages/feed` is the primary output engine over persisted entries from `@nju-info/db`; collection remains separate from output rendering.

## Source registry

Source metadata lives in `sources/nju/*.yaml` and is validated with Zod before use.

Most new WebPlus/Sudy sources should require configuration only. Source-specific selectors are supported as escape hatches, but generic defaults should be preferred when they are reliable.

Current registered coverage and live adapter-fit findings are tracked in [`source-inventory.md`](source-inventory.md).

### Optional source classification metadata

Source schema version 1 accepts a small optional metadata extension; existing source files remain valid without it:

```yaml
organization:
  id: nju-cs
  name: 计算机学院
  kind: academic-unit
classification:
  audiences:
    - graduate-students
  topics:
    - academics
    - research
```

`organization.kind` is one of `university`, `academic-unit`, `administrative-unit`, `service-unit`, `student-organization`, or `other`. The broad values classify the organization, not its legal or internal administrative hierarchy.

`classification.audiences` and `classification.topics` are optional non-empty arrays of unique lowercase kebab-case identifiers. At least one of the two arrays must be present when `classification` is provided. The identifiers are source-level discovery hints: they describe the stream as a whole and must not be treated as claims about every notice. A controlled audience/topic vocabulary can be introduced when real selection requirements are defined; the schema intentionally does not guess one now.

This metadata does not add persistence columns, query/filter behavior, selectors, bundles, or aggregation. Each registry source still produces its own independent feed; instance publication policy remains separate.

## Instance configuration

Instance publication policy is separate from both the source registry and the runtime. Checked-in instance files under `instances/` select already-registered sources without choosing whether the same instance runs under Docker, GitHub-hosted automation, or another runner.

`instances/official.json` is the reviewed source of truth for the official instance policy, not evidence that a public deployment is active. It defines:

- instance identity;
- collected source IDs and per-run recent-ingest limits;
- published source IDs;
- the single curated source set and its OPML path;
- publication base URL;
- runtime-neutral collection cron and IANA timezone.

Instance schema v4 separates collection policy from publication policy. `collection.sources[].recentLimit` caps first-run bootstrap history and controls how many recent known items are refreshed for revision detection; after history exists, discovery scans through the first page with any known item plus one observation-only lookahead page, then enriches unseen items only through the overlap page. No overlap within 10 search pages fails that source before item observation or detail acquisition, subject to the 100-page hard cap. Full-detail acquisition remains best-effort and link-only entries do not trigger refill from older items. `publication.sources` controls feed membership. SQLite keeps the complete persisted history, while the producer exposes a shared recent window (currently 100 entries per source) through RSS, Atom, and JSON Feed so polling clients do not repeatedly transfer the full archive. Published sources must also be collected by the same instance. The schema does not encode deployment or storage transport choices; older pre-release shapes are intentionally unsupported before a stable release rather than carrying permanent normalization layers.

`@nju-info/instance-config` owns the declarative instance contract; `apps/nju-info` loads and validates it before collection/export/scheduling. Unknown source IDs, duplicate collection/publication membership, published-but-uncollected sources, invalid or duplicate set membership, and invalid cron/timezone values fail before collection starts. The current schema intentionally permits at most one curated set because the static exporter accepts one named set per invocation.

Secrets are not instance configuration. WebDAV URL/user/password remain runtime secrets, and runtime SQLite/storage transport stays outside the collector/source registry. Runtime choice is deliberately not encoded as an instance mode. Docker/Compose is the canonical product shape and the localhost Docker instance is the current test publisher. The GitHub Pages workflow has `state=disabled_manually`, is not the current publisher, and must remain disabled while deployment acceptance is pending.

The localhost Compose instance runs the unified `nju-info` runtime as a resident scheduler alongside the read-only API. The scheduler validates the same instance config, performs one collection at startup, then follows `collection.schedule` in `collection.timeZone`. It prevents overlapping in-process runs and isolates transient failures by source: later sources continue collecting, successful sources refresh normally, and a failed source keeps its previously persisted feed state until a later run succeeds. A collection run is considered usable when at least one configured source succeeds; only an all-source failure fails the run. Readiness is written after the first usable run so the API can serve the available database state. Manual one-shot collection remains available for refresh/debugging, not as the normal scheduling mechanism.

Schema v7 adds instance collection run/source-attempt history without changing canonical website or authenticated social identities. `collect` and `schedule` retain structured outcomes, independent success/activity clocks, and safe bounded stage/cause diagnostics; direct source debugging is outside this ledger. Unfinished attempts remain explicit after interruption rather than being called healthy or recovered. API health remains reader liveness; operational status and `nju-info status` are separate read-only views. The current writer migrates v6 before current readers open it; rollback to an old image requires its verified pre-upgrade state, not a reader-version shim.

## Adapter boundary

An adapter is responsible for source-specific acquisition and parsing. It must not depend on a web UI, output protocol, or downstream storage.

The first adapter targets common WebPlus/Sudy conventions observed on multiple NJU sites:

- list pages commonly contain `.news_list`, `.wp_article_list`, or `.listcon`;
- detail links commonly end in `/page.htm` or `/pagem.htm`;
- titles commonly use `.arti_title`;
- publication metadata commonly uses `.arti_update`;
- article content commonly uses `.wp_articlecontent`;
- uploaded files commonly live under `/_upload/article/files/`;
- embedded PDFs may be referenced only through `pdfsrc`.

The parser keeps heuristics narrow so that navigation links are not mistaken for notices.

A second adapter covers the Boshan/NJDX site family used by sources such as University Hospital and Asset Management. Its source YAML supplies a numeric `channelId`, bounded `pageSize`, and detail `content` selector. Discovery reads the public `/njdx/openapi/t/info/list.do` JSON endpoint, uses the returned `iid` as stable source-item identity, normalizes same-host links to the configured HTTPS source origin, and labels first-party details as `boshan-detail`. Boshan and WebPlus share the downstream HTML-detail normalization, raw provenance, persistence, frontier, and feed paths; no browser automation or source-specific branch is required. Boshan detail normalization also recognizes editor-embedded PDFs exposed through either `pdfsrc` or `data-pdf`, preserving them as PDF attachments.

A third adapter covers public information streams from the NJU employment portal. Source YAML selects one public content type (`NEWS`, `COLLEGE`, or `GUIDE`) and a bounded page size. Discovery reads `/api/career/content/informations`, uses the portal record `id` as stable identity, preserves `/career/info/<id>?type=...` as the human-facing feed URL, and fetches detail JSON from `/api/career/content/informations/<id>`. Published records must remain public (`loginRequired=false`); explicit `externalLink` records become `external-public` link-only items instead of being re-fetched as portal detail. The API provides full HTML and attachment URLs, so no browser execution is required.

A fourth adapter covers employment recruitment batches. Discovery reads `/api/career/job/recruitments`, uses the recruitment `id` as stable identity, and publishes `/career/jobs-v2?recruitmentId=<id>` as the human-facing URL while detail provenance comes from `/api/career/job/recruitments/<id>`. A recruitment batch remains one source item even when it contains multiple positions; normalization appends structured position summaries (education, major, salary, location, conditions, welfare) to the upstream recruitment introduction. Missing introduction or position arrays are allowed because the public API still supplies stable identity, theme, application time, and other summary fields.

List discovery preserves source/DOM order, including pinned or featured items. Publication-recency ordering is a separate operation: parseable dates are ordered newest-first, equal dates retain source order, and missing or unparseable dates follow dated items while retaining their source order. The `nju-info source` developer commands apply that ordering only to limited `fetch` and `ingest` operations. Limited `fetch` and first-run `ingest` read one additional page after first collecting enough candidates, bounded by the command's page cap, so first-page pinned items do not displace newer dated notices on the next page. Incremental `ingest` instead uses known-item overlap plus lookahead. Full `discover-pages` results remain in source order and retain pinned items.

Discovery labels each list item `webplus-detail`, `boshan-detail`, `job-portal-information`, `job-portal-recruitment`, `public-wechat`, or `external-public` without fetching the detail. Explicitly configured WebPlus list selectors may include external links, Boshan discovery classifies same-host API records as first-party `boshan-detail` items, employment information records use `job-portal-information` unless the portal explicitly supplies an external public destination, and recruitment batches use `job-portal-recruitment`. Limited `fetch` and `ingest` preflight each candidate: unsupported acquisition is skipped without a detail request, and recognized campus-network warnings or observable NJU unified-identity redirects are skipped after an ordinary public request. During ingest, every unique item on successfully scanned list pages is observed before candidate enrichment, including lookahead rows. A failed overlap search makes no item observations or detail requests. The collection runtime emits bounded JSON skip events containing the trusted source ID and skip class, not item URLs or response bodies, then continues through later candidates within the 100-page cap; ordinary malformed details remain errors. Neither restricted nor unsupported details become parsed full notices or persisted detail raw bodies, but the observed list item remains link-only for feeds.

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

A source item is one publication identity at one source. An observation is a versioned official-list fact (title, day, acquisition kind, list-raw provenance) recorded before detail acquisition. Acquisition kinds are validated by the application type/ingestion boundary rather than a SQLite enum CHECK, so adding a future adapter does not require rebuilding the observations table; a notice revision is a separate full parsed snapshot linked to detail raw. The shared URL-derived item ID joins them without changing existing identities. Consecutive identical observations are idempotent; changed metadata (including a return to an earlier value) creates a new observation revision. The notice-revision content hash covers the parsed URL, title, raw publication text, body, and attachment metadata; the deterministic derived date is not part of revision identity. Re-ingesting identical parsed content is idempotent; changed parsed content creates the next notice revision. A later unavailable detail never erases a known full notice.

There is no separate canonical `notices` table yet. Cross-source semantic deduplication is deferred until real consumers require it. Detailed schema and transaction semantics are documented in [`database.md`](database.md).

Direct HTTP `fetch` remains sufficient for the current public WebPlus, Boshan, and employment-information sources; persistence does not introduce a requirement for Crawlee or browser orchestration.

Runtime database files remain local to the active host. The current localhost Docker test publisher uses its local SQLite state. The GitHub Pages reference workflow has `state=disabled_manually`; it contains optional cache/WebDAV snapshot handling but is not scheduled, is not triggered by `main`, and must remain disabled. Snapshot creation uses SQLite's backup API rather than copying live WAL/SHM files; remote transport is handled outside the collector/database layer through rclone. See [`state-storage.md`](state-storage.md).

## Read-only HTTP delivery

`apps/api` is an optional read-only HTTP adapter over `@nju-info/db` and `@nju-info/feed`. It serves health, persisted source and organization summaries, current recent **full** notice revisions at `/v1/notices/recent`, collection status/history at `/v1/collection/status` and `/v1/collection/runs`, and mixed full/link-only source entries in per-source JSON Feed 1.1, Atom 1.0, and RSS 2.0. Feed responses use the same producer recent window as static publication and support conditional GET with a content-derived strong `ETag`, the latest emitted observation as `Last-Modified`, and `Cache-Control: public, max-age=0, must-revalidate`. The server cannot ingest, create, or migrate a database and does not load the source registry. Its local feeds omit self URLs because a reliable public origin is unknown. The server defaults to a local bind; see the README for commands and routes.

## Feed publication core

`packages/feed` projects persisted source entries (latest official list observation with optional latest full notice, or legacy full notice alone) into one format-neutral feed model before serialization. Stable source-item IDs, organization/source identity, original item and source URLs, day-precision publication metadata, and selected raw provenance share one mapping. Full entries retain detail title/date/body/attachments and detail-raw provenance; link-only entries use list title/date/list-raw provenance, no article body or attachments, and a short hub-generated availability note. JSON Feed marks `_nju.content_status` as `full` or `link-only` and exposes known acquisition kind; Atom/RSS carry the same availability note and a namespaced link-only status, acquisition kind, and list-raw fetch time/hash. JSON Feed retains structured provenance and full attachments; Atom uses standard enclosure links; RSS uses item-description attachment links, not `<enclosure>` without reliable byte length. No format triggers crawling or changes database precision. Publication days remain `YYYY-MM-DD` in the database and `/v1` API. Because the current sources provide day precision rather than an instant, the canonical model remains `YYYY-MM-DD`. For reader compatibility, the feed serializers additionally transport a known day as UTC noon (`YYYY-MM-DDT12:00:00Z`) through JSON `date_published`, Atom `published`, and RSS `pubDate`. This is an explicit compatibility anchor, not an exact upstream publication time; JSON `_nju.published_on` / `date_precision: "day"` and Atom/RSS `nju:published_on` / `nju:date_precision` remain the precision source of truth. Atom `updated` uses the emitted entry's raw fetch time (detail for full, list for link-only), with maximum across entries or generation time when empty. RSS `lastBuildDate` is likewise hub observation/build metadata, not upstream modification time.

The static exporter takes a publication allow-list and writes `.json`, `.atom`, and `.rss` for each selected source. SQLite retains the full persisted history, while the producer publishes the latest 100 entries per source; combined source-set feeds are sorted across their members and capped to the same 100-entry window. With a validated public base URL it writes `catalog/sources.json` for that complete publication selection, with absolute feed URLs. A named curated set is explicit and separate: its required source IDs are resolved against the published selection, and only those members appear in the set's OPML and combined feeds. The versioned `catalog/sets.json` records the resolved membership and absolute OPML (under `subscriptions/`, defaulting to `subscriptions/<setId>.opml`) and combined JSON/Atom/RSS bundle URLs.

Publication is generation-based: the exporter renders the complete next generation in a sibling staging directory before touching the existing output, then transactionally replaces its owned `feeds/`, `catalog/`, `bundles/`, and `subscriptions/` directories with rollback on commit failure. Unrelated files at the publication root are preserved. This prevents a failed render from leaving mixed old/new feed generations. A static publisher can copy `index.html`, JavaScript, and CSS into `catalog/` only after export. The pilot selector reads these static catalogs; it does not generate server-side arbitrary combined feeds or expand the central publication allow-list.

The official instance policy selects thirty independent per-source feeds. Most later admissions use `recentLimit: 5`; M2L adds Student Exchange and Science and Technology Office at 5 while the low-frequency Academic Calendar uses `recentLimit: 1`, and M2N adds five more college feeds at 5; mixed public-WeChat and external-public rows remain explicit link-only entries when no supported detail acquisition exists. The `cs` curated set still contains only the three CS IDs, with no new set or bundle. The localhost Docker/Compose instance is the current test publisher. `.github/workflows/publish-cs-feeds.yml` has `state=disabled_manually` and must remain disabled; Pages is not scheduled or triggered by pushes to `main`, and public deployment acceptance remains pending.

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

