# ADR: central credentialed-public acquisition

Status: accepted architecture; the core contract remains offline, with a separate restricted QZone/AstrBot acquisition app that is not a Hub release or publication integration.

## Decision and scope

NJU Info Hub remains a centrally operated shared service with Feed as the unified downstream. A platform login needed to enumerate a generally public publisher stream does not, by itself, make that stream private. Dedicated WeChat/QQ service identities may acquire explicitly approved public channels through isolated providers. This is not a per-user account connection or private-source sidecar.

This architecture keeps the versioned contract in `packages/core/src/social-acquisition.ts` and adds the isolated `apps/qzone-acquire` operator tool described below. It does not add accounts, a Hub importer, database migration, feed publication, automatic approval, or live source registration. Existing website `SourceConfig`, adapters, and URL-derived IDs remain unchanged. Private chats, groups, friend timelines, relationship-restricted posts, personal eHall/SSO data, and per-user information are prohibited. Normal authentication is permitted; bypassing authentication, challenges, access controls, or rate limits is not.

## Three separate policy dimensions

| Dimension | Policy |
| --- | --- |
| Acquisition access | `anonymous` or `credentialed-public`: how an isolated provider obtains a publisher's posts. |
| Content audience | `public` only: available to a general audience, not because of friendships, group membership, invitation, institutional entitlement, or personalization. |
| Redistribution eligibility | `full`, `summary`, `link-only`, `review-only`, or `denied`: what the operator has approved for shared publication. |

Public-content eligibility is not permission to redistribute full text, screenshots, or images. Establish an acceptable redistribution basis separately, record it, and choose an explicit mode. `full` permits narrower summary/link-only publication; `summary` permits summary/link-only; `link-only` permits metadata and a safe original link, without article bodies or media. `review-only` requires an item-level decision; `denied` cannot produce an approved decision. Policy cannot be inferred from a provider's claims.

Sentinel source policies are restricted to `review-only` or `denied`. Every approved sentinel item requires `method: item-review` independently of the declared redistribution mode; whole-stream `full`, `summary`, or `link-only` sentinel policies are rejected structurally. A reviewed item may receive a specific full/summary/link-only decision only within the operator's approved content/rights scope.

Allowlist a stable platform publisher ID, not a display name or collector identity. Record evidence of general-public availability, verification of any official role, an operator owner, allowed content scope, redistribution basis, policy version, and review/revocation date. An openly subscribable account is acceptable; establishing a friendship to obtain restricted posts is not. Resolve the NJU助手/南哪助手 alias question before treating them as one publisher. Official, relay, and sentinel roles describe the publisher stream, not proof that every post is correct.

## Central trust boundary

```text
Dedicated service identities
    -> isolated replaceable providers
    -> allowlisted positive extraction / sanitation / approval
    -> immutable credential-free public-safe bundle
    -> future Hub importer
    -> existing canonical persistence and public Feed
```

Providers own login, session renewal, platform requests, discovery, and platform error interpretation. Hub owns structural validation, native identity, trusted policy lookup, blob verification, normalization, persistence, and public output. Hub must never invoke account actions, open provider databases, or inherit platform credentials.

Deploy providers and the acquisition app separately from Hub, with separate OS identities/containers, secret mounts, browser profiles, and storage. Do not vendor provider implementations. A same-host atomic completed-bundle directory remains sufficient for a future approved importer: provider/exporter writes; Hub reads; Hub writes its own acknowledgment state. No webhook, queue, or dynamic plugin loader is needed.

Allow only publisher-targeted post listing, detail/media retrieval, and necessary session health operations. Deny posting, messaging, likes, comments, reposting, uploads, deletion, privacy changes, friend enumeration, and broad timelines. Enforce operation and target allowlists, not just HTTP methods. Reads can still create platform view/visitor records; strip these from content.

An isolated provider and thin exporter may live in a separately deployable monorepo app, but must not depend on Hub database/feed/runtime packages or enter the normal Hub release artifact. The `apps/qzone-acquire` tool is a restricted-evidence qualification hook only: it depends on `@nju-info/core` and `zod`, has no Hub DB/feed/runtime dependency, and emits neither `SocialAcquisitionBundle` nor public-safe data. It does not import, approve, register, or publish sources. Repository separation alone is not credential isolation.

Platform credentials and session state stay entirely external. The QZone app requires `QZONE_ASTRBOT_URL`, `QZONE_ASTRBOT_TOKEN`, `QZONE_ASTRBOT_VERSION`, `QZONE_PLUGIN_VERSION`, and `QZONE_PROTECTED_ROOT`; there are no defaults. The origin must be HTTPS remotely or HTTP on loopback, without path, query, or userinfo. Versions identify the reviewed installed provider/plugin revisions. `QZONE_PROTECTED_ROOT` declares the absolute canonical root containing protected platform state/session storage, not a symlink alias. The operator supplies that path; the collector does not inspect, resolve, read, or create the protected root and does not record it in evidence. Output equal to, inside, or containing that root is rejected before writes/network calls. Existing output ancestors are checked from the filesystem root down; symlinked output paths are rejected before following an alias or creating directories. Supply canonical paths in an operator-controlled filesystem namespace; this check cannot detect a misdeclared protected root, bind-mount aliases, or hostile concurrent filesystem changes.

AstrBot **4.28.2** exposes the verified v1 extension routes below. Direct authentication uses `Authorization: Bearer` with an API key carrying **`plugin` scope**. That scope is broader than read-only: the collector's GET-only implementation does not reduce the key's authority, and a long-lived direct plugin-scope key is not least privilege. For an operator-controlled qualification smoke, a short-lived plugin-scope key is acceptable; revoke it immediately after use, including failed runs, and never discover dashboard passwords, cookies, or session files. Production should use a **local method/path-limited read-only capability proxy** (GET feed/detail only) or an equivalent dedicated read-only capability. Keep the broad upstream key at the proxy/provider boundary, supply only the limited capability to the collector, and restrict publisher query parameters as well. No proxy is implemented by this app; there is no auth fallback. See [AstrBot OpenAPI documentation](https://docs.astrbot.app/en/dev/openapi.html) for API-key authentication; the route/scope qualification here is specific to the verified 4.28.2 interface.

## Restricted QZone/AstrBot qualification hook

Run one operator-controlled acquisition from the repository root. Export the five `QZONE_*` variables above in the isolated collector environment; set `POLICY_JSON` to the reviewed policy file and `RESTRICTED_OUTPUT_ROOT` to an absolute operator-owned `0700` directory outside Hub/protected storage with no symlinked ancestors (a missing root is created with that mode):

```bash
mise exec -- pnpm --filter @nju-info/qzone-acquire acquire -- "$POLICY_JSON" "$RESTRICTED_OUTPUT_ROOT"
```

Configuration is strict JSON: `{ "schemaVersion": 1, "source": <existing SocialEnvelopePayload source policy with qzone-uin>, "qualification": { "owner": "…", "publicAudienceEvidence": "…", "allowedContentScope": "…", "redistributionBasis": "…", "reviewedAt": "<ISO instant>", "reviewUntil": "<ISO instant>" } }`. The source policy must use `platform: qzone`, `access: credentialed-public`, and `audience: public`, and must not be denied; a sentinel is review-only. Policy expiry stops acquisition. Metadata role and rights require explicit operator approval. Do not auto-register/admit UIN `492711989`, or invent display-name or alias evidence.

The app calls only `GET /api/v1/plugins/extensions/astrbot_plugin_qzone/page/feed?scope=profile&hostuin=<canonical UIN>&limit=10`, expecting `{ok:true,data:{items:[post],cursor:'',has_more:false}}`, followed by serialized `GET /api/v1/plugins/extensions/astrbot_plugin_qzone/page/detail?id=<uin:tid>` for every target item, expecting `{ok:true,data:{post}}`. Every response must be successful and each post ID/author must agree with the expected publisher; detail ID must exactly match the requested ID. A numeric UIN is canonicalized only if it is a positive safe integer, to canonical decimal; `tid` remains the exact case-sensitive native ID and whitespace/control characters are rejected by core identity validation. Only the first page is used; `cursor` is ignored upstream, so discovery is always incomplete, including empty feeds and `has_more: false`. No broad timelines, comments route, actions, status endpoint, checkpoint/cursor, retries, scheduler, login, or media downloads are allowed. Detail responses contain comments, which are discarded immediately; extraction positively projects permitted fields and excludes comments, stats, avatar, collector/viewer data, and session material. Media links must pass the existing asset-URL policy or the post is rejected; no stripping session parameters to make a URL acceptable. Media is partial, and unknown origin/attribution stays unknown rather than being inferred original or official.

Selected, restricted, credential-free provider-export JSON is stored under SHA-256 blobs before normalization—not as lossless origin responses. Whole provider responses and free-form errors are never archived or logged. The atomic output contains a `run.json` completion manifest, `candidates.json`, and `blobs/<sha256>`, with raw-record fetched time/hash/length and source publication URL, run ID, source policy, provider/exporter versions, feed/detail records, and normalized candidates. Directories are mode `0700`, files `0600`. Failures fail the run without a completed marker and leave prior artifacts untouched; a successful empty run is still incomplete. Stdout reports only safe counts and run ID.

Positive extraction removes account/session metadata; it cannot certify arbitrary publisher text or linked media for privacy, embedded secrets, audience, or redistribution rights. Treat every candidate as unreviewed restricted evidence and discard irrelevant personal submissions during operator review. No media bytes are fetched, and no candidate is declared public-safe.

Keep the restricted output outside the repository, Hub public directories/state/backups, and all platform credential/session paths. Never publish it or copy it into Hub state. Publication requires separate content, privacy, audience, and redistribution review plus approval of a public-safe bundle. For a supervisor smoke, use the exact environment variables and reviewed policy, with UIN `492711989` only if qualified, and an output root outside repository and Hub public directories. Do not claim a smoke unless actually performed.

The app reads the public [Zhalslar QZone plugin route implementation](https://github.com/Zhalslar/astrbot_plugin_qzone/blob/main/main.py): profile feed and per-post detail only. Authentication/session-expiry failures can be indistinguishable from plugin HTTP 400 errors; report a generic provider failure, retain no error text, and never relogin automatically.

## Positive extraction and evidence tiers

Construct envelopes from explicitly permitted fields. Never forward whole account responses and merely remove a few known secret keys. Do not collect comments, reactions, visitor traces, friend/group context, personalized recommendations, or unrelated records. Remove collector/viewer identity, sessionized URLs, tracking, active HTML, and unnecessary image metadata. A public publisher ID is permitted attribution; a collector ID is not.

Use safe original/canonical links or approved captured media instead of links carrying session access. Discard irrelevant personal submissions. Potentially useful items containing personal contacts, student IDs, faces, precise residences, sensitive allegations, private-conversation screenshots, or ambiguous QR codes require restricted review or rejection. Reviewed institutional service contacts may be necessary content. Apply the same review to image-heavy posts, not only extracted text. No OCR/LLM is introduced here.

Keep two evidence tiers:

1. **Restricted acquisition evidence:** only necessary publisher-post evidence after secret removal, outside Hub/public state with operator-only access and limited retention. Never archive unrelated private records or credentials as evidence.
2. **Public-safe parser input:** approved sanitized payload/media, immutable and hashed before normalization. This is the only evidence tier allowed in the core bundle contract.

The contract labels `origin-response`, `provider-export`, and `screenshot` evidence honestly. If sanitation changes bytes, hash the stored sanitized bytes and record the sanitation version; do not claim lossless upstream preservation. Restricted storage paths and account state must not cross into the public bundle. Public backups may retain approved sanitized social records, never provider state or restricted evidence.

## Contract and publication eligibility

`SocialAcquisitionBundle` version 1 contains strict envelopes. Every nested object rejects unexpected fields. The payload records source policy, native item identity, safe URLs, original publication representation/precision/timezone, nullable calendar day and normalized timestamp, content completeness, ordered media/attachments, origin attribution, and public-safe raw blob references. Provenance records acquisition time, provider/exporter versions, acquisition method, and run ID, without collector identity. Blobs are referenced by SHA-256, content type, and byte length, not arbitrary filesystem paths.

Blob hashes name a **shared namespace across the entire bundle**, not envelope-local storage. Every descriptor for the same SHA-256 in raw evidence, captured media, and captured attachments must agree exactly on `byteLength` and `contentType`, within and across envelopes. Multiple references and roles are allowed; conflicting metadata is not. `contentType` is the blob's one approved parser/serving MIME declaration, including parameters, rather than a per-reference reinterpretation. Although identical bytes can sometimes be interpreted under different MIME types, this public-safe contract deliberately disallows that ambiguity; exporters must choose a consistent approved declaration before binding decisions. No implicit MIME case/parameter normalization is performed. The future importer must still verify actual bytes/hash/length and consistency with any existing shared storage across separate bundles; this offline schema only checks manifest declarations.

Canonical identity descriptors make provider replacement independent of opaque provider strings. The source carries `publisherIdentity`; the item carries `nativeIdentity`. Each descriptor has an explicit `scheme` and `version: 1`. `socialSourceItemId` hashes deterministic JSON of `['social-native', 1, platform, publisherIdentity, nativeIdentity]` after strict canonical validation; existing website IDs are untouched.

- **WeChat publisher:** `wechat-biz`, with `value` equal to the stable publisher `__biz` value, URL-decoded and represented as canonical padded base64. Do not substitute display names, account handles, provider `fakeid`/database IDs, or a permalink URL. An exporter must establish the stable publisher mapping before emitting a bundle.
- **WeChat article:** `wechat-mid-idx`, with canonical positive decimal-string `mid` and a positive integer `idx`. `idx` is required even for a single-article publication; article positions in the same message must remain distinct. Prefer the native publication `mid`. `wechatArticleIdentity` accepts an `appmsgid` fallback only when the exporter has established that it denotes the same publication/message ID as `mid`, not an unrelated draft/backend ID. If both fields are present they must agree; conflicting IDs, missing IDs, or missing article position are not importable. The helper emits only canonical `mid`/`idx`, so equivalent verified aliases yield the same identity.
- **QZone publisher/post:** `qzone-uin` with canonical positive decimal-string publisher UIN, plus `qzone-tid` with the exact case-sensitive native post `tid`. Do not substitute collector UIN, a provider row key, feed position, or URL.

All scheme versions are checked and included in identity. Decimal IDs reject leading zeros and numeric coercion; native IDs cannot contain whitespace/control characters. Missing/ambiguous native fields stay upstream as not importable, not as unstable fallback records. Attribution origin metadata may remain incomplete; it is not a substitute for the publishing item's canonical identity.

Publication times are also representation-specific. Supported machine originals are ISO dates, explicit-offset ISO timestamps at minute/second/exactly-three-digit millisecond precision, and canonical nonnegative integer Unix seconds/milliseconds whose instants fall in years 1970–9999. Precision must agree with the machine representation; invalid values, implicit-offset timestamps, unsupported fractional precision, and mismatched normalized instants are rejected. `normalizedAt` must preserve the original instant without submillisecond truncation. Known source timezones accept IANA names, UTC/Z, or explicit numeric offsets; `publishedOn`, when supplied, must match the determinate source calendar day. ISO originals without a separate timezone retain their explicit-offset calendar day; Unix originals without a known source timezone cannot assert a calendar day. Opaque text retains `unknown` precision and no inferred instant/day; recognized textual calendar dates may use `day` precision without manufacturing an exact time.

URL validation is purpose-specific: publication/canonical URLs permit stable article and routing keys such as `type=NEWS`; asset URLs permit media-format/size keys such as `wx_fmt=png`; attribution URLs permit public origin routing. Every purpose requires HTTPS and rejects userinfo, fragments, whitespace/control characters, and obvious auth/session/tracking query keys (including encoded or case-varied keys). Unrecognized parameters remain rejected until deliberately reviewed; a public permalink's `sn` is not treated as a collector-session token. These rules do not authorize network fetching or prove audience/redistribution eligibility.

Every non-null attribution `blobSha256` must resolve to a complete public-safe raw blob descriptor or a captured media/attachment descriptor in the same payload. Dangling evidence hashes are rejected. This verifies manifest referential integrity, not the actual bytes or truth of a screenshot; those checks remain the future importer's responsibility.

`socialPublicationBinding` parses the payload into schema-defined key order, then hashes its deterministic UTF-8 JSON representation; arrays retain order. The decision carries that payload hash and the ordered captured media/attachment hashes, plus its policy version, mode, method, time, and reason. This binds the decision to the source policy, attribution, raw references, and exact approved content/media manifest. Edits require a new decision. `parseSocialAcquisitionBundle` checks identity, declaration consistency, and decision bindings. Provider/provenance or bundle transport changes do not change item identity.

Parsing is **not** sanitation, authorization, blob verification, or permission to publish. Free-form text/HTML/images can contain sensitive information even when their schema is valid. The future importer must compare the declared publisher/policy with trusted configuration, verify actual blob bytes and lengths, authenticate the producer, and validate approval evidence. An exporter-generated `approved` flag alone is not authority. Even link-only metadata requires review when it reveals sensitive information. Purpose-specific URL checks do not prove a URL's audience, prevent every possible embedded secret, or authorize fetching arbitrary hosts.

Official 南大后勤 is the first candidate after identity and redistribution review. NJU助手 remains a relay with visible original-source and verification status; unknown origin stays unknown. 南哪表白墙 is a sentinel: no whole-stream syndication, only individually reviewed campus-relevant items. Do not relabel relay reports as official guidance. Preserve corrections and material updates separately from duplicate reposts.

## Replacement, failure, and withdrawal

WeRSS/onebot-qzone are candidate external implementations, not core dependencies. Pin reviewed versions and qualify replacements with shared safe fixtures: native identity, publication precision, ordered images, attribution, incomplete content, raw evidence, and failure behavior. A provider offering only filtered RSS exports cannot claim original-response evidence. Reject implementations whose unwanted writes, broad polling, or limit-avoidance behavior cannot be disabled.

Session expiry/challenges pause the account and require human recovery. Rate limits pause the account request stream and honor retry guidance; no account rotation or endpoint fallback to evade limits. This QZone qualification app performs no retries or automatic relogin: failures fail the run. Other future providers must bound transient retries so a failed poll cannot become an empty successful one. Discovery caps/gaps must be visible; do not advance past unaccounted items. Preserve previously accepted Hub content on acquisition failures and report staleness separately.

Record last attempted/successful poll, last new item, discovery completeness, retries/rate limits, session downtime, rejected/partial items, media failures, import/export lag, and operator recovery/review cost without exposing secrets. Source revocation or content corrections must support suppression across all future public output paths and assets. Previously downloaded reader copies cannot be recalled.

## Consequences and next implementation boundary

The offline schema prevents accidental metadata expansion and stale decision declarations; it cannot certify content safety or legal rights. Dedicated accounts may still face platform restrictions or sanctions. Image review, origin ambiguity, and relay/sentinel review effort are admission risks.

The QZone/AstrBot qualification app is implemented as a restricted, incomplete-evidence path only; it does not admit a source or integrate with Hub publication. Remaining work after account and policy qualification includes any separately approved importer, content review/approval, persistence/publication support, unauthenticated reader proof, and the prospective benchmark. Those integrations are not performed by this app.
