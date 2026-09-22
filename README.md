# NJU Info Hub

An unofficial, read-only information aggregation layer for Nanjing University.

> This is a community project and is not affiliated with or endorsed by Nanjing University.

NJU Info Hub aims to turn fragmented public campus information into a normalized, traceable dataset that can be consumed by search tools, feeds, agents, and MCP clients.

## Status

Early proof of concept. The first milestone focuses on public NJU websites, especially sites built on the WebPlus/Sudy website platform.

Planned source families:

- public NJU websites and existing RSSHub routes;
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
  worker/        development CLI for crawling and parser smoke tests
packages/
  core/          shared schemas and canonical types
  collector/     source registry loader and source adapters
sources/
  nju/           declarative source definitions
```

Database persistence is intentionally deferred until the parser proof of concept has real samples. The intended persistence layer is SQLite first; the raw-document/canonical-record boundary is already represented in the types.

## Development

Requirements:

- Node.js 24 LTS
- pnpm 12

```bash
pnpm install
pnpm check
pnpm test

# list configured sources
pnpm worker -- sources

# discover notices from a live WebPlus list page
pnpm worker -- discover nju-cs-graduate

# fetch and parse the newest detail page
pnpm worker -- fetch nju-cs-graduate 1
```

Live commands access public NJU websites. Unit tests use local fixtures instead.

## Initial sources

The first P0 fixtures/configs cover:

- NJU Computer Science graduate notices;
- NJU Student Affairs public notices;
- NJU student exchange notices.

More sources should preferably be added by contributing YAML under `sources/nju/` rather than adding a new crawler.

## License

License selection is still pending. Until a license is added, normal copyright rules apply.

