# Social acquisition handoff — 2026-10-08

> Snapshot for a local coding Agent, **not** source admission, publication approval, or a live-operation instruction. Recheck Git and service state before acting. This file contains no credentials, session material, article bodies, or machine-private evidence.

## Start here

1. Read [AGENTS.md](../AGENTS.md), then the [credentialed-public acquisition ADR](adr-credentialed-public-acquisition.md) and [social benchmark protocol](social-acquisition-benchmark.md). The [architecture](architecture.md) separates operator tools, the Hub core, private data, and public Feed.
2. Read [#86](https://github.com/zhongyangchuwu/nju-info-hub/issues/86) for the campus-operations regression corpus, historical provenance and operator observations; [#46](https://github.com/zhongyangchuwu/nju-info-hub/issues/46) for external-public / WeChat discovery, and [#84](https://github.com/zhongyangchuwu/nju-info-hub/issues/84) only for optional P3 private EHall exploration.
3. Start from a **fresh worktree at `origin/main`**. Do not assume any existing local `main` or feature branch is current or clean. The workstation has additional operator-only state notes under `~/.local/state/nju-info-hub/handoffs/`; these are intentionally not committed.

## Merged GitHub changes (verified 2026-10-08)

| PR | Merge commit | Implemented boundary | Head CI / Container |
| --- | --- | --- | --- |
| [#87](https://github.com/zhongyangchuwu/nju-info-hub/pull/87) | `9565142` | Strict `SocialAcquisitionBundle v1`, source policy, native identity, publication time, blob/provenance validation; ADR + benchmark | success / success |
| [#89](https://github.com/zhongyangchuwu/nju-info-hub/pull/89) | `282720f` | Offline WeRead latest qualification and explicit review-required metadata-only shadow export; `--shadow` + pnpm `--` support | success / success |
| [#88](https://github.com/zhongyangchuwu/nju-info-hub/pull/88) | `faa0483` | Isolated QZone restricted acquisition app and GET-only publisher-allowlisted capability gateway; no Hub importer | success / success |

At this snapshot remote `main` was `faa048364eb65b0de54dc68bd5238d7efc3054ec`; it has both #88 and #89. The successful checks above are the GitHub **PR head** workflow runs, not newly executed tests in this handoff. They do not qualify a social source for public delivery.

### Code ownership map

- `packages/core/src/social-acquisition.ts`, `social-identity.ts`, `social-publication-time.ts`: schema, policy and canonical descriptors; avoid modifying existing website source IDs and ingestion semantics.
- `apps/qzone-gateway/`: private Node-only bearer capability boundary; GET `page/feed` and `page/detail` only, allowlisted publisher UIN, bounded response/time, fixed redacted errors. It is **not** a sanitizer: valid upstream detail JSON can still contain comments.
- `apps/qzone-acquire/`: one first-page QZone profile list (limit 10) plus serial per-item details. Positive extraction drops comments, viewer and session data and writes restricted evidence. Discovery is always **incomplete**. No scheduler, cursor, importer, bundle or publication.
- `apps/wechat-weread-acquire/`: **offline** parser of separately produced sanitized WeRead export. Native WeChat `__biz + mid + idx` and `ct` are validated. An explicit source-policy-gated `--shadow` creates a link/metadata-only public-safe bundle with decision `review-required / none / item-review`, while provider content stays restricted. No Web login, network collector or publication path.
- `instances/official.json` and `sources/nju/` remain the website baseline. The benchmark protocol records 30 selected sources versus 31 registered source files; this is **not** proof of an active public publisher.

## Verified operational and historical paths

### A. QZone relay / candidate discovery (manual, restricted)

```text
Dedicated QQ login (operator, NapCat)
  -> AstrBot QZone plugin (profile feed / known post detail)
  -> loopback read-only gateway + reader capability
  -> apps/qzone-acquire (reviewed publisher policy)
  -> restricted evidence/candidates only
  X no social source registration, public Feed or approval
```

- Login recovery and OneBot reconnect were observed on 2026-10-08. The allowed **NJU助手** public profile (`qzone-uin=492711989`) returned items; the 2026-09-29 power notice was recovered by exact `tid=35305e1ddb28bb6a97540500`, published **10:56:27 Asia/Shanghai**, with 499 characters and no images. A single target-only positive projection was stored as restricted local evidence (no comments/stats/viewer data).
- The provider's local list cache contained a 390-character prefix of that same detail, with `rt_con` and `extra_text` empty. The deployed parser did **not recognize a native QZone forward**. This does not establish who first published or wrote the notice; NJU助手 is a secondary **relay**, never an official issuer.
- Correct endpoint capability: gateway checks exactly GET `/api/v1/plugins/extensions/astrbot_plugin_qzone/page/feed?scope=profile&hostuin=<allowed-uin>&limit=1..10` and GET `.../page/detail?id=<allowed-uin>:<tid>`. No comment, friend, visitor, broad timeline, post or interaction API is approved. The detail response includes comments upstream; do **not** repeat detail requests just to inspect speculative fields.
- The proposed `NJU助手` source is `credentialed-public / relay / review-only`. Whether `南哪助手` is the same account remains unverified; do not merge aliases from nicknames.

### B. WeRSS / WeRead latest (separate operator provider)

```text
Isolated WeRSS + WeRead service-account authorization
  -> latest cover + article HTML for explicitly scoped official accounts
  -> sanitized operator export (not a Hub core API)
  -> offline apps/wechat-weread-acquire -- --shadow
  -> public-safe link-only SocialAcquisitionBundle v1, still review-required
  X no importer, Feed or automatic benchmark
```

- One-time live latest cover/content qualification succeeded for `南大后勤` and `南大就业`; the former's full page allowed validating native `__biz + mid + idx`, publication time and publisher match. One later fresh article-body request returned no content node and was treated as a provider reliability failure, **not** retried in a loop.
- A real local `南大后勤` shadow smoke created a schema-valid metadata-only bundle and verified restricted/public-safe separation, hash, and 0700/0600 permissions. **`publicationEligible=false`, `bundleEligible=false`**; a bundle file existing is not permission to publish.
- WeRSS WeChat backend list requests had returned `200013`. The operator vendor tree runs a reviewed local backport/fallback patch (`8f8fbb5`) and a separate image. This is **not** a repository-integrated WeChat history collector. Do not force refresh, switch fingerprints/accounts/proxies, or retry blocked endpoints to evade controls.
- WeRead cover returns only a latest item: multiple posts between polls may be missed. A blocked/error/zero-result run must not advance the incremental cursor. No 30-day prospective recall benchmark has started.

### C. 2026-09-29 campus power regression

- [NJU Logistics' 2026-09-30 first-party incident retrospective](https://hqjt.nju.edu.cn/e6/2a/c40086a845354/page.htm) confirms the external electricity fault and Water & Electricity Center response, **not** the first-publication URL of the exact notice.
- `NJU助手` QZone relay is verified as above. Its notice names `后勤服务集团水电中心`, but does not supply a WeChat URL, forwarding reference or original distribution route.
- Positive control: genuine `南大后勤` WeChat article **《2026年国庆南大后勤服务指南，请查收～》**, `wechat-biz=Mzg4NzIzODkzNA==`, `mid=2247520906`, `idx=1`, `ct=1790687551` (**2026-09-29 21:12:31 +08:00**). Its public article page was available, proving this account had at least some normally indexed same-day publications.
- Exact title, distinctive sentences and phone/keyword variants for the morning load-shedding notice were **not** found in public WeChat search, official Logistics lists, or public search. Absence from an index is **not proof of non-publication**.
- An operator-initiated, human-authenticated read-only EHall check returned `hasLogin=true`, **16 categories, 6 distinct retained messages, no matching notice, no truncation**. It did not mark messages read. Dedicated Chromium and its temporary profile were removed. This excludes only the account's **currently enumerable** EHall history, not historical/per-user delivery on 9/29.
- Strongest supported state: **first-party event/unit confirmed; secondary public QZone relay confirmed; indexed standard official-WeChat notice not found; current EHall history negative; exact first-publication channel unresolved**. Retain this as a regression, not as an invitation to use private/group data.

## Current GitHub Issue boundaries (open at snapshot)

| Issue | Next decision; do not prematurely close |
| --- | --- |
| [#86](https://github.com/zhongyangchuwu/nju-info-hub/issues/86) | Primary campus-operations regression and secondary QZone sentinel qualification; first-publication route remains unresolved. Detailed evidence comments live here. |
| [#46](https://github.com/zhongyangchuwu/nju-info-hub/issues/46) | Replaceable external-public/WeChat acquisition; known official list links are different from account-level history discovery. |
| [#84](https://github.com/zhongyangchuwu/nju-info-hub/issues/84) | Optional P3, per-user **private local** EHall pilot, not a central source. Targeted negative check alone does not satisfy idempotency/storage acceptance. |
| [#51](https://github.com/zhongyangchuwu/nju-info-hub/issues/51) | Deployment/private-data ownership; public shared Feed remains central, private user data stays local. |
| [#21](https://github.com/zhongyangchuwu/nju-info-hub/issues/21) | Source coverage/access/authority audit; count useful event coverage rather than merely registered sites. |

## Immediate next-Agent priorities / stop conditions

1. **Inspect existing uncommitted local QZone media URL changes separately** before modifying them. A pending synthetic fixture/tests/ADR change handles tightly qualified `photo.store.qq.com` HTTP→HTTPS candidate URLs while retaining exact upstream URL bytes in restricted evidence. It is **not** included in #88/main and was not verified or approved by this handoff. Never silently discard, rebase or commit another worktree's WIP.
2. Independently test/assess QZone candidate media URL behavior and whether a safe restricted-to-public-safe projection is needed; keep rights and image-byte validation distinct from URL syntax. Tests must cover hostile URLs, redirects, path/query preservation, canonical IDs and schema strictness.
3. Design an auditable **manual/reviewed** relay sentinel qualification and acquisition-completeness measurement. Do not enable indefinite polling or announce Day 1 until reviewed publisher/rights policy, correction/suppression, missed-post audit, item review and unauthenticated reader validation are actually implemented.
4. Investigate safe WeRead latest polling/dedup/cursor semantics and provider gaps. A latest-only cover is not historical backfill or lossless enumeration. Do not issue more WeChat backend list requests when rate-limited.
5. Future public integration is separate work: trusted producer/importer, blob & policy-version verification, publication decisions, corrections/takedowns, and real public Feed/reader tests. Never copy provider sessions, restricted HTML or comments into Hub state.

## Safe first commands (do not execute live acquisition by default)

```bash
git fetch origin
git worktree list
git status --short --branch
mise run verify
mise --env node24 run verify
# Targeted tests after assessing the intended branch:
mise exec -- pnpm --filter @nju-info/qzone-acquire test
mise exec -- pnpm --filter @nju-info/wechat-weread-acquire test
mise exec -- pnpm --filter @nju-info/qzone-gateway test
```

If touching production/real provider state: reread the ADR and operator-only local handoff first; explicitly confirm the publisher, reviewed policy validity, scope, credentials separation, output root, rate-limit state, and human approval. The repository is not a credential store. Unknown Desktop Commander sessions, Docker resources, live processes, caches and worktree modifications belong to other owners until verified otherwise.


## Verification of this documentation handoff

On 2026-10-08, this dedicated docs worktree passed `mise run verify` (Node 26) and `mise --env node24 run verify` after `pnpm install --frozen-lockfile`; both included checks, tests, build, and packaged release smoke. The operator-only local handoff remains separate, and no live collection was initiated for documentation validation.
