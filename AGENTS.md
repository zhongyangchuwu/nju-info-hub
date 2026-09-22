# Agent guidance

## Project purpose

`nju-info-hub` is an unofficial, read-only information aggregation layer for Nanjing University.

The public core must only ingest information that is publicly readable without a personal NJU, QQ, or WeChat login. Private chat sources belong in a future local sidecar, not in the public service.

## Architectural boundaries

Keep these layers separate:

1. source registry: declarative YAML describing where information comes from;
2. source adapters: fetch and parse source-specific formats;
3. raw documents: immutable fetched payloads plus provenance/hash;
4. canonical records: normalized notices, attachments, events, deadlines, revisions;
5. outputs: REST, RSS/Atom, MCP, or other clients.

Collectors must not depend on MCP or a UI. Output adapters must not know how a website is scraped.

Prefer configuration over source-specific code. A new WebPlus/Sudy site should normally require only a YAML file. Add code only when the generic adapter cannot represent the source safely.

## Current phase

The current milestone is a WebPlus/Sudy proof of concept. Do not add a web frontend, MCP server, vector database, LLM pipeline, queue system, or dynamic plugin loader unless an issue explicitly asks for it.

## Safety and data handling

- Never commit credentials, cookies, tokens, NJU SSO data, QQ sessions, or WeChat sessions.
- Do not bypass authentication or access controls.
- Preserve source URL, fetch time, and content hash for provenance.
- Prefer saving raw source material before normalization so parsers can be rerun later.
- Treat scraped content as source material, not project-owned text; preserve attribution and links.

## Development

- Node.js 24 LTS and pnpm are the supported local toolchain.
- TypeScript is strict.
- Parser changes require fixture tests.
- Network smoke tests are useful locally but must not be the only CI coverage.
- Keep adapters deterministic. LLM-based enrichment, if added later, must be optional and downstream of parsing.

