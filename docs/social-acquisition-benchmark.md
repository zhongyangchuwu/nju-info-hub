# Thirty-day central social-acquisition benchmark

This is a prospective protocol, not a claim of an active benchmark, admitted source, or public deployment. The [credentialed-public acquisition ADR](adr-credentialed-public-acquisition.md) defines admission policy and the offline contract. The isolated `apps/qzone-acquire` tool adds a restricted QZone/AstrBot qualification hook; it is not a benchmark collector or public integration. No private/per-user sources or account credentials belong in benchmark artifacts.

## Setup and prospective window

Start Day 1 only after dedicated accounts, publisher identity/public-audience qualification, isolated read-only provider operation, and source redistribution policies are ready. Observe 30 consecutive Asia/Shanghai calendar days: `[start 00:00, start + 30 days 00:00)`. Record exact dates before starting; do not select a favorable period afterward. Classify events by first eligible publication in the window; track later corrections and deliveries separately. Allow a fixed seven-day follow-up for late baseline matches; label unmatched leads as censored rather than infinite.

**Restricted QZone qualification hook.**

The operator-controlled `apps/qzone-acquire` invocation is a one-run qualification step, not the proposed 30-day collector: it reads one profile-feed page (limit 10) and serially requests detail for targeted posts. It always marks discovery incomplete, even when the response is empty or reports `has_more: false`; it has no cursor/checkpoint, retry, or scheduler. Its output is restricted operator-only evidence/candidates, not a `SocialAcquisitionBundle`, public-safe payload, import, approval, or live source registration. It does not establish completeness, benchmark recall, admission, or public-feed delivery. Use only an unexpired reviewed source policy and separate approved qualification metadata as specified in the ADR; never auto-admit UIN `492711989` or infer display/alias evidence.

AstrBot auth is a supervisor-provided verified bearer token or verified read-only reverse-proxy capability, not dashboard password/cookie discovery or an assumption that `/api/v1` keys authorize plugin dashboard routes. Configuration uses `QZONE_ASTRBOT_URL`, `QZONE_ASTRBOT_TOKEN`, `QZONE_ASTRBOT_VERSION`, and `QZONE_PLUGIN_VERSION`; there are no defaults or auth fallbacks. See the ADR for the exact command, origin restrictions, restricted output layout and storage permissions. Platform session expiry and plugin HTTP 400 may be indistinguishable; failures are generic, error text is not retained, and there is no automatic relogin.

Detail responses include comments, but extraction discards them and excludes stats, avatar, collector/viewer fields, and session material. Media is not downloaded; unsafe media URLs reject the post rather than being repaired by stripping query parameters. Safe links may remain partial, and unknown attribution remains unknown. Provider-export JSON is hashed before normalization but is not lossless origin response evidence. Keep output outside Hub state/backups and public directories; separate content, privacy, audience, redistribution, and public-safe bundle approval are prerequisites to any later publication.

Freeze the actual official-instance baseline at start: checked-in `instances/official.json` currently selects **30 collection/publication sources**, while `sources/nju/` contains **31 registered sources**. The legacy Security Office parent is registered but unselected. Registry size is not baseline coverage. Record the selected IDs, instance/configuration fingerprint, code version, existing database history, recent limits, and schedule. The current website schedule is every two hours (`17 */2 * * *`, UTC). Record actual baseline runs and public export times; a policy file is not proof of an operating publisher. If no operational baseline exists, run the frozen official selection alongside the pilot before claiming comparative results. Do not change `instances/official.json` merely to establish this protocol.

| Candidate | Role and starting policy |
| --- | --- |
| 南大后勤 WeChat | Official after stable publisher verification; primary operational-information candidate; explicit summary/link/full redistribution decision. |
| NJU助手 QZone | Relay; resolve whether 南哪助手 is an alias of the same stable publisher; item-reviewed publication with origin/verification attribution. |
| 南哪表白墙 QZone (optional) | Sentinel; separately measured, review-only; exclude personal/social submissions and never syndicate the whole stream. |

The 2026-09-29 National Day logistics service guide and the relayed urgent power-limit notice are historical qualification cases. They test completeness, images, identities, and attribution but **do not count as prospective benchmark successes**. Treat the reported website gap and anonymous QZone login response as motivation, not measured thirty-day recall.

Identity qualification must establish canonical WeChat `__biz` plus native publication `mid`/verified `appmsgid` alias and article `idx`, or QZone publisher UIN plus post `tid`, as specified in the ADR. Missing or conflicting native fields are not importable and cannot be counted as successfully captured/published items. Include multi-article WeChat cases and provider replacement using the same canonical descriptors. Machine timestamps must pass representation/precision/normalization/calendar-day checks; opaque text cannot acquire invented exactness. Screenshot attribution must resolve to a declared public-safe blob manifest.

## Collection, audit, and release stages

Any cadence for the later 30-day benchmark is prospective and applies only after the required source, access, safety, and operational gates pass. The one-run QZone qualification app does not schedule repeated collection. Record the actual approved cadence, serialize account requests, honor stricter provider/platform limits, and never evade restrictions.

- Proposed starting cadence: one source poll every 30 minutes, 24 hours/day, with serialized account requests and stricter provider/platform limits taking precedence. Record every cadence change, session outage, incomplete scan, and rate limit. Never evade restrictions.
- Independently audit allowlisted publisher posts through normal authorized viewing every day, including publication lists and images, to identify provider misses. Record audit coverage, audit time, and any inability to establish completeness. Do not use friend timelines or comments as a substitute.
- Days 1–7: shadow acquisition and full item review; no unreviewed publication. Historical/bootstrap items are excluded from prospective success counts.
- Days 8–30: limited shared public-feed delivery for approved candidates/items. Relay items remain reviewed; sentinel items always require individual review. Eligible shadow items held back in week 1 count toward acquisition but not public delivery.
- The future central runtime should drain approved bundles every five minutes and export on change, serialized with existing collection/export. Do not increase website collection traffic simply to accelerate social publication. Record actual schedules if this target is not met.
- Inspect the actual anonymously accessible JSON/Atom/RSS output and an unauthenticated feed reader. Image-heavy notices must have readable approved assets or an honest partial/link-only representation; an image URL in a manifest is not proof of reader usability.

## Human actionable-event rubric

An actionable event gives students a concrete action or operational accommodation: deadline/application, outage/power/water restriction, changed dining/housing/transport/service hours, campus access restriction, or safety instruction. Record affected campus/audience, event time, action, urgency, source evidence, and factual-verification status. Exclude generic publicity, greetings, advertising, gossip, and personal/social requests. Do not infer action from a title when the decisive content is in an unread image.

Maintain two labels independently: `actionable` and `publication-eligible under the reviewed policy`. Account for all observed public-channel posts, including excluded categories, in aggregate counts; do not retain irrelevant personal submissions wholesale. Human-read images and transcribe only relevant safe evidence with image references. No OCR/LLM is required.

Cluster publications into underlying events using occurrence, affected location/audience, and event time, not title similarity alone. Preserve each publisher/item identity. Classify publications as original, attributed relay, unknown-origin relay, duplicate, or material update/correction. Preserve the issuing authority separately from the relay account. An attributed report is not automatically confirmed official guidance.

One reviewer labels all items; a second reviewer adjudicates every claimed incremental/time-critical event and publication decision, plus a predeclared 10% random sample of negative labels. Record disagreements and resolutions. Keep audit-discovered missed items in the denominator even when the provider never acquired them.

## Metrics and denominators

Let `G` be the independently audited actionable events in the observed source/baseline scope, `H` those discovered by the frozen Hub baseline, and `S` those acquired socially. Let `E` be actionable events eligible for public redistribution and `P` those actually delivered through the pilot public Feed. These are scope-limited estimates, **not campus-wide recall**. Report numerators/denominators and counts alongside ratios; zero denominators are `N/A`.

| Metric | Definition |
| --- | --- |
| Actionable ratio | Actionable publications / all observed eligible-audience channel publications, per source; also report unique actionable events to reveal repost inflation. |
| Publishable actionable ratio | Publication-eligible actionable publications / all observed channel publications, and / all approved publications; include rejection reasons. |
| Acquisition recall | `|H ∩ G| / |G|` baseline, `|(H ∪ S) ∩ G| / |G|` combined, and incremental `|(S \\ H) ∩ G| / |G|`. |
| Public-feed incremental recall | Let `H_feed` be events actually delivered by baseline Feed. Report `|(P \\ H_feed) ∩ E| / |E|`, baseline public recall, and combined public recall. Also count eligible social deliveries absent from baseline discovery `H`. Provider discovery alone is not product success. |
| Incremental yield | New verified actionable events per source/day; report attributed but unconfirmed reports separately. |
| Duplicate/relay burden | Publications per event, same-/cross-source duplicates, repeated alerts visible to readers, supported original-attribution ratio, and material updates/corrections. |
| Discovery lead | `baseline first-observed time - social first-observed time` for matched events; positive means social earlier. |
| Delivery lead | `baseline public-feed availability - social public-feed availability` for matched events; includes review, import, and export delay. |
| Reliability | Audit-verified eligible-post capture rate, successful/failed/incomplete polls, media completeness and reader usability, session downtime, rate limits, acquisition-to-import and approval-to-public lag. |
| Operator cost | Setup separately; recurring renewal/recovery, audit, review, redaction, correction, and takedown minutes per source/week and per new actionable event. |

Report lead median/p90 and matched-event counts. Use observed timestamps, not inferred source times or Feed's day-to-UTC-noon transport timestamps. Retain original timestamp precision/timezone, polling uncertainty, and both original-issuer and relay publication times. Unmatched events are censored after the fixed follow-up; do not assign infinite lead. Show acquisition-only speed separately from reader-visible delivery lead and explain cadence differences.

A Hub link-only record can already establish event discovery: measure discovery presence separately from usable text/image coverage. Do not call an enriched duplicate a newly recalled event.

## Evidence and retention

Retain approved public-safe payload/media hashes and lengths, safe original links, stable publisher/item identities, original publication representations, first-observed/import/approval/export times, provider/exporter/sanitation/policy versions, approval records bound to exact hashes, poll/audit failures and completeness, frozen baseline observations, public Feed generations, reader checks, event clusters/labels/adjudication, attribution evidence, corrections, and operator time.

Necessary restricted publisher-post review evidence is operator-only and outside Hub/public backups, after secret removal. Store no credentials, browser sessions, viewer traces, private conversations, or broad personal-submission archives. Proposed restricted retention: the run plus 90 days, then deletion review; retain a sanitized metric/decision ledger. Public retention and takedown follow the reviewed source policy, not automatic permanent mirroring.

## Admission gates and outcomes

Every source must pass the hard gates: stable publisher/public-audience evidence; approved redistribution basis/mode; enforced read-only operation/target restrictions; no observed credentials, prohibited private content, or unapproved personal-information publication; passing malicious-metadata fixtures; native ID stability across replay/provider replacement; working correction/suppression of entries and assets; and real unauthenticated reader proof. Schema acceptance alone is not admission.

Sentinel admission can use only `review-only` (with an item-review decision for every approved item) or `denied` policy. Whole-stream full/summary/link-only sentinel source policies are invalid, regardless of source utility. Routing and media URLs must pass their purpose-specific rules and contain no session/auth/tracking material.

Proposed utility/operation thresholds, fixed before Day 1:

- At least 95% capture of audit-verified eligible posts; report incomplete audits instead of claiming the threshold from provider output alone.
- At least three verified incremental actionable events, or one materially important time-critical event missed by baseline. Require actual approved public-feed delivery for central admission, not only shadow acquisition.
- Approval-to-public delivery p95 within 15 minutes, with acquisition/review delays separately visible; approved images must work in the selected publication mode.
- Recurring operator burden within the predeclared budget, initially two hours/source/week; account for benchmark audit cost separately and include production-required review/recovery work.

Outcome per source: admit the approved mode, continue measurement for low-volume/inconclusive results, or reject/suspend. Safety gates override utility. High rejection/review cost can reject a sentinel even if it finds useful items. Optional sentinel results cannot conceal failure of the primary official/relay candidates. Document changes in privacy, access, or provider behavior and requalify before expanding scope. No source admission, 30-day recall result, importer/review/public reader, or public integration is established by the QZone qualification hook.
