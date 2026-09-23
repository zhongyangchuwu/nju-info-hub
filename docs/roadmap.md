# Project Roadmap

GitHub is the source of truth for NJU Info Hub implementation status.

- This document tracks the long-term project path and phase boundaries.
- GitHub Issues track active or planned work.
- Pull requests and commits record completed implementation.
- Brainstorming/Notion pages should only keep high-level context and progress summaries, not a competing implementation roadmap.

## Project direction

NJU Info Hub is an unofficial, read-only information aggregation layer for Nanjing University.

The core goal is to turn fragmented public campus information into a normalized, traceable dataset that can be consumed by search tools, feeds, agents, and MCP clients.

The public core should remain independent from personal NJU, QQ, or WeChat credentials. Private chat sources, if added later, belong in local sidecars.

## Architecture boundary

```text
source registry
      |
      v
source adapters
      |
      v
raw documents + provenance
      |
      v
normalize / revisions
      |
      v
canonical records
      |
      +--> query / REST
      +--> RSS / Atom
      +--> read-only MCP
```

Collectors must remain independent from MCP/UI. New WebPlus/Sudy sources should normally be configuration-only additions.

## Current status

### Completed foundation

- [x] Bootstrap the public WebPlus/Sudy collector.
- [x] Add representative fixtures and broaden public NJU source coverage.
- [x] Add pagination, resilient fetching, charset handling, and parser hardening.
- [x] Persist raw documents, source items, notice revisions, and attachments in SQLite.
- [x] Preserve provenance using source URL, fetch time, and content hashes.
- [x] Validate the repository under Node.js 26 and the Node.js 24 compatibility environment.

Relevant merged work:

- PR #2 — Harden WebPlus discovery and fixtures.
- PR #4 — Persist WebPlus notices in SQLite.
- PR #7 — Harden recent WebPlus discovery and source freshness.

### Latest P0 correctness pass

Issue #5 is complete via PR #7.

It corrected the stale Science & Technology source, added Graduate School coverage, supported split/month-first list dates, separated source/DOM order from publication-recency ordering, and added regression coverage for pinned old notices.

P1 persisted queries and the first read-only REST/JSON output adapter are implemented. GitHub Issues remain authoritative for current work; other delivery formats are not implied by this milestone.

## Phase roadmap

### P0 — Reliable public information core

Primary goal: make public NJU website ingestion trustworthy before exposing higher-level interfaces.

Scope:

- source registry;
- generic WebPlus/Sudy collection;
- representative fixtures;
- raw-document archival and provenance;
- SQLite persistence;
- notice revisions and attachments;
- deterministic discovery and publication-time semantics;
- source health/freshness checks;
- structured fields only when they can be extracted reliably.

High-value source families include Graduate School, Computer Science, Student Affairs, student exchange, Science & Technology, ITSC, academic calendar, and other public official sources.

Deferred from the early P0 collector:

- canonical cross-source semantic deduplication;
- deadline/audience enrichment beyond reliable deterministic extraction;
- REST/MCP interfaces;
- browser automation unless a concrete source requires it.

### P1 — Query and read-only delivery

After P0 ingestion correctness is stable:

- define a stable query layer over persisted data;
- support recent notices and source/organization filtering;
- add search as justified by actual data and query needs;
- expose read-only REST/JSON interfaces;
- expose RSS/Atom where useful;
- add a small read-only MCP adapter over the query layer.

MCP remains an output adapter, not the core data model.

### P2 — Public feed adapters

Add replaceable adapters for public sources that do not fit direct WebPlus collection, such as public WeChat-account feeds when a maintainable upstream exists.

Rules:

- adapters must be replaceable;
- public-core operation must not depend on personal accounts;
- raw source and provenance remain available for reprocessing.

### P3 — Private local sidecars

Optional local-only ingestion for private information channels such as QQ/WeChat groups.

Expected shape:

```text
private client / event stream
        |
        v
append-only local store
        |
        v
private normalized index
        |
        v
local read-only interface
```

Private sidecars must remain isolated from the public service by default.

## Data-model direction

The persistence layer should continue to preserve a distinction between:

- source configuration and provenance;
- immutable raw fetched documents;
- source publication identity;
- parsed notice revisions;
- ordered attachments.

Future canonicalization should build on this history rather than replacing it.

Potential higher-level fields include organization, category, audience, deadlines, event times, and cross-source relationships. Uncertain values should remain nullable or explicitly uncertain rather than guessed.

## Project rules

- Public core: public, read-only data only.
- No authentication bypass.
- No personal NJU/QQ/WeChat credentials in the public service.
- Preserve raw data and provenance before normalization.
- Prefer configuration over source-specific parser code.
- Keep collectors independent from output protocols.
- Fixture-test parser changes.
- Use live smoke tests as validation, not as the only test coverage.
- Introduce new infrastructure only when a concrete requirement justifies it.

## Tracking work

For current implementation status, use the GitHub issue and pull-request trackers rather than this file.
