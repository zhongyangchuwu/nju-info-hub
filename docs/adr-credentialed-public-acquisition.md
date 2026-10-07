# ADR: central credentialed-public acquisition

Status: accepted architecture; implementation limited to the offline contract and operator-only WeRead qualification/shadow export.

## Decision and scope

NJU Info Hub remains a centrally operated shared service with Feed as the unified downstream. A platform login needed to enumerate a generally public publisher stream does not, by itself, make that stream private. Dedicated WeChat/QQ service identities may acquire explicitly approved public channels through isolated providers. This is not a per-user account connection or private-source sidecar.

The implemented boundary includes policy, the [benchmark protocol](social-acquisition-benchmark.md), the versioned contract in `packages/core/src/social-acquisition.ts`, and an offline WeRead latest qualification/shadow app. It adds no accounts, provider integration, network collection, importer, database migration, feed publication, or live source policies. Existing website `SourceConfig`, adapters, and URL-derived IDs remain unchanged. Private chats, groups, friend timelines, relationship-restricted posts, personal eHall/SSO data, and per-user information are prohibited. Normal authentication is permitted; bypassing authentication, challenges, access controls, or rate limits is not.

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

Providers own login, session renewal, platform requests, discovery, and platform error interpretation. A thin exporter emits the contract. Hub owns structural validation, native identity, policy lookup, blob verification, normalization, persistence, and public output. Hub must never invoke account actions, open provider databases, or inherit platform credentials.

For a pilot, deploy providers and a thin exporter separately from Hub, with separate OS identities/containers, secret mounts, browser profiles, and storage. A thin exporter may live in a separately deployable monorepo app; it must not depend on Hub database/feed/runtime packages or enter the normal Hub release artifact. Do not vendor provider implementations. A same-host atomic completed-bundle directory is sufficient: provider/exporter writes; Hub reads; Hub writes its own acknowledgment state. No webhook, queue, or dynamic plugin loader is needed. Repository separation alone is not credential isolation.

Allow only publisher-targeted post listing, detail/media retrieval, and necessary session health operations. Deny posting, messaging, likes, comments, reposting, uploads, deletion, privacy changes, friend enumeration, and broad timelines. Enforce operation and target allowlists, not just HTTP methods. Reads can still create platform view/visitor records; strip these from content.

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

### WeRead latest qualification boundary

`apps/wechat-weread-acquire` is an operator-only qualification/shadow tool for sanitized exports from an isolated WeRSS `weread_mp` provider. Provider cookies, WeRead credentials, VID, tokens, and WeRSS state remain outside Hub and are rejected as unexpected export fields. Restricted evidence is written outside the repository, Hub state/backups, and provider state with operator-only permissions.

WeRead `/api/mp/cover` is latest-only and by itself exposes only the provider `reviewId`, title, and cover. The provider-side positive exporter therefore fetches the corresponding `/web/mp/content` page and extracts only approved metadata from the complete article HTML before it crosses the isolation boundary: canonical `__biz`, `mid`, `idx`, public `sn`, and source `ct`, plus the article body. It requires the content-page `__biz` to equal the WeRSS `fakerId`, the `reviewId` to belong to the configured feed, and the content-page title to agree with the cover title. Hub then validates the canonical `wechat-biz` and `wechat-mid-idx` descriptors, derives the normal `socialSourceItemId`, and parses `ct` as the original Unix-second publication representation. The stable `wechat-weread-review-v1` hash remains only a provider-specific shadow deduplication key.

Native identity qualification is complete: restricted qualification passed independently for 南大后勤 and 南大就业. This does not approve audience, article originality, redistribution rights, or public publication. The article HTML and complete provider export remain restricted and unsanitized for public use. Each restricted candidate still records `publicationEligible: false`, `bundleIdentityEligible: true`, `bundleEligible: false`, and incomplete latest-only discovery.

An explicit `--shadow` invocation can now derive a schema-valid `SocialAcquisitionBundle v1` from that candidate and a **separately supplied reviewed source policy**. The strict JSON policy has `schemaVersion: 1`, the core `source` fields, and a `qualification` object with `owner`, `publicAudienceEvidence`, `allowedContentScope`, `redistributionBasis`, `reviewedAt`, and `reviewUntil`. This app accepts only `platform: wechat`, canonical `publisherIdentity.scheme: wechat-biz`, `access: credentialed-public`, `audience: public`, `role: official`, and `redistributionMode: review-only`. Its publisher identity must match the candidate exactly. Unknown fields at every tier, blank qualification/policy-version fields, invalid timestamps, future reviews, and expired reviews are rejected. Review validity is `reviewedAt <= now < reviewUntil`, with explicit offsets and at most millisecond precision. Whole-source `full`, `summary`, `link-only`, and `denied` policies are outside this app's conservative scope and are rejected. Qualification strings record operator declarations; parsing does not authenticate their evidence or interpret their scope/rights text.

The shadow payload preserves title, safe original/canonical URLs, native identity, `sourceItemId`, and original publication time. It has `text: ''`, `html: ''`, `completeness: link-only`, and no media or attachments. `source.role: official` comes from the reviewed source policy; article attribution remains `relationship: unknown`, `verification: unknown`, `origin: null`, and no evidence. An official publisher classification is not proof that an article is original.

Its sole public-safe raw blob is newly constructed metadata, never the article HTML or complete provider export. Sanitization version **`wechat-weread-link-metadata-v1`** defines UTF-8 compact JSON with one trailing LF, in fixed outer-key order: `schemaVersion: 1`, `sanitizationVersion`, `platform`, `publisherIdentity`, `item`, `publicationTime`, `content`. Nested fields use core schema order; `item.aliases` is empty. Restricted content hashes/lengths, provider feed/review IDs, cover URLs, and qualification evidence are omitted. The descriptor hashes these exact sanitized bytes, declares `application/json; charset=utf-8`, and uses `evidenceTier: public-safe`, `evidenceKind: provider-export` to identify a derived sanitized export, not a lossless upstream response.

The envelope uses `credentialed-public-export` provenance and the candidate's provider/exporter names and versions. Its fixed decision is **`review-required` / `none` / `item-review`**, with the reviewed `policyVersion` and `socialPublicationBinding` of the exact payload. It is schema-valid but **not publication-authorized**, even for links. Title/link sensitivity still needs item review; the `public-safe` label describes the bounded projection, not publication approval.

Operator commands (all configured paths must be absolute, outside the repository and protected provider state; output must also remain outside Hub state/backups):

```bash
# Existing restricted qualification only; WECHAT_WEREAD_SOURCE_POLICY must be unset.
# Requires WECHAT_WEREAD_INPUT, WECHAT_WEREAD_OUTPUT_ROOT, WECHAT_WEREAD_PROTECTED_ROOT.
mise exec -- pnpm --filter @nju-info/wechat-weread-acquire acquire

# Explicit shadow export; additionally requires WECHAT_WEREAD_SOURCE_POLICY.
mise exec -- pnpm --filter @nju-info/wechat-weread-acquire acquire -- --shadow
```

The atomically completed run keeps restricted `candidate.json`, `run.json`, and `blobs/<provider-export-sha256>` separate from `public-safe/bundle.json` and `public-safe/blobs/<sanitized-metadata-sha256>`. A validated `source-policy.json` snapshot, including operator qualification evidence, stays on the restricted side. Directories are 0700 and files are 0600; public-safe artifacts remain operator-only pending review. Restricted `rawEvidence` descriptors are not reused by the bundle. CLI output separately reports `shadowBundleCreated`; it retains `publicationEligible: false` and the restricted candidate's `bundleEligible: false`. The [synthetic policy fixture](../apps/wechat-weread-acquire/src/fixtures/source-policy.json) is a schema example, not a live source approval.

This hook may qualify provider reliability and detect latest-item changes at low frequency without rotating endpoints to evade WeChat backend rate limits. Historical/backfill qualification, including the 2026-09-29 cases, remains a separate path because current `weread_mp` cover discovery does not enumerate history.

Publication times are also representation-specific. Supported machine originals are ISO dates, explicit-offset ISO timestamps at minute/second/exactly-three-digit millisecond precision, and canonical nonnegative integer Unix seconds/milliseconds whose instants fall in years 1970–9999. Precision must agree with the machine representation; invalid values, implicit-offset timestamps, unsupported fractional precision, and mismatched normalized instants are rejected. `normalizedAt` must preserve the original instant without submillisecond truncation. Known source timezones accept IANA names, UTC/Z, or explicit numeric offsets; `publishedOn`, when supplied, must match the determinate source calendar day. ISO originals without a separate timezone retain their explicit-offset calendar day; Unix originals without a known source timezone cannot assert a calendar day. Opaque text retains `unknown` precision and no inferred instant/day; recognized textual calendar dates may use `day` precision without manufacturing an exact time.

URL validation is purpose-specific: publication/canonical URLs permit stable article and routing keys such as `type=NEWS`; asset URLs permit media-format/size keys such as `wx_fmt=png`; attribution URLs permit public origin routing. Every purpose requires HTTPS and rejects userinfo, fragments, whitespace/control characters, and obvious auth/session/tracking query keys (including encoded or case-varied keys). Unrecognized parameters remain rejected until deliberately reviewed; a public permalink's `sn` is not treated as a collector-session token. These rules do not authorize network fetching or prove audience/redistribution eligibility.

Every non-null attribution `blobSha256` must resolve to a complete public-safe raw blob descriptor or a captured media/attachment descriptor in the same payload. Dangling evidence hashes are rejected. This verifies manifest referential integrity, not the actual bytes or truth of a screenshot; those checks remain the future importer's responsibility.

`socialPublicationBinding` parses the payload into schema-defined key order, then hashes its deterministic UTF-8 JSON representation; arrays retain order. The decision carries that payload hash and the ordered captured media/attachment hashes, plus its policy version, mode, method, time, and reason. This binds the decision to the source policy, attribution, raw references, and exact approved content/media manifest. Edits require a new decision. `parseSocialAcquisitionBundle` checks identity, declaration consistency, and decision bindings. Provider/provenance or bundle transport changes do not change item identity.

Parsing is **not** sanitation, authorization, blob verification, or permission to publish. Free-form text/HTML/images can contain sensitive information even when their schema is valid. The future importer must compare the declared publisher/policy with trusted configuration, verify actual blob bytes and lengths, authenticate the producer, and validate approval evidence. An exporter-generated `approved` flag alone is not authority. Even link-only metadata requires review when it reveals sensitive information. Purpose-specific URL checks do not prove a URL's audience, prevent every possible embedded secret, or authorize fetching arbitrary hosts.

Official 南大后勤 is the first candidate after identity and redistribution review. NJU助手 remains a relay with visible original-source and verification status; unknown origin stays unknown. 南哪表白墙 is a sentinel: no whole-stream syndication, only individually reviewed campus-relevant items. Do not relabel relay reports as official guidance. Preserve corrections and material updates separately from duplicate reposts.

## Replacement, failure, and withdrawal

WeRSS/onebot-qzone are candidate external implementations, not core dependencies. Pin reviewed versions and qualify replacements with shared safe fixtures: native identity, publication precision, ordered images, attribution, incomplete content, raw evidence, and failure behavior. A provider offering only filtered RSS exports cannot claim original-response evidence. Reject implementations whose unwanted writes, broad polling, or limit-avoidance behavior cannot be disabled.

Session expiry/challenges pause the account and require human recovery. Rate limits pause the account request stream and honor retry guidance; no account rotation or endpoint fallback to evade limits. Bounded transient retries cannot turn a failed poll into an empty successful one. Discovery caps/gaps must be visible; do not advance past unaccounted items. Preserve previously accepted Hub content on acquisition failures and report staleness separately.

Record last attempted/successful poll, last new item, discovery completeness, retries/rate limits, session downtime, rejected/partial items, media failures, import/export lag, and operator recovery/review cost without exposing secrets. Source revocation or content corrections must support suppression across all future public output paths and assets. Previously downloaded reader copies cannot be recalled.

## Consequences and next implementation boundary

The offline schema prevents accidental metadata expansion and stale decision declarations; it cannot certify content safety or legal rights. Dedicated accounts may still face platform restrictions or sanctions. Image review, origin ambiguity, and relay/sentinel review effort are admission risks.

Remaining gates: approve live source policies and item publication decisions; establish trusted-producer and actual-blob verification; add a credential-free importer with raw-before-normalization preservation; add only necessary persistence/publication support; exercise correction/suppression and an unauthenticated reader; then explicitly admit sources and declare the benchmark window. Native identity qualification and shadow bundle generation do not start Day 1. None of those runtime integrations is implemented here.
