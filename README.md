# NJU Info Hub

An unofficial, read-only information aggregation layer for Nanjing University.

> This is a community project and is not affiliated with or endorsed by Nanjing University.

NJU Info Hub aims to turn fragmented public campus information into a normalized, traceable dataset that can be consumed by search tools, feeds, agents, and MCP clients.

## Status

The public ingestion foundation is in place:

- the generic WebPlus/Sudy collector has multi-site fixture coverage, pagination, resilient fetching, and parser hardening;
- raw documents, source items, notice revisions, and attachments are persisted in SQLite;
- Node.js 26 is the default repository runtime and Node.js 24 remains the compatibility floor.

The current P0 task is [Issue #5](https://github.com/zhongyangchuwu/nju-info-hub/issues/5): source freshness and trustworthy "latest" discovery semantics.

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
        +--> REST / JSON   [planned]
        +--> RSS / Atom    [planned]
        +--> MCP           [planned]
```

The source adapter boundary is intentionally independent of MCP. Future WeChat/QQ support should add new adapters or a local sidecar without changing the canonical data model.

## Repository layout

```text
apps/
  worker/        development CLI for discovery, parsing, and ingestion
packages/
  core/          shared schemas and canonical types
  collector/     source registry loader and source adapters
  db/            SQLite schema, migrations, and persistence API
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

# fetch and parse the newest detail page
pnpm worker -- fetch nju-cs-graduate 1

# ingest notices and raw documents into SQLite
pnpm worker -- ingest nju-cs-graduate /tmp/nju-info.sqlite 10
```

Live commands access public NJU websites. Unit tests use local fixtures instead.

## Initial sources

The current public-source registry and fixtures cover multiple NJU WebPlus/Sudy sites, including Computer Science graduate notices, Student Affairs public notices, and student exchange notices. Additional high-value public sources are tracked through the roadmap and GitHub Issues.

More sources should preferably be added by contributing YAML under `sources/nju/` rather than adding a new crawler.

## License

License selection is still pending. Until a license is added, normal copyright rules apply.
