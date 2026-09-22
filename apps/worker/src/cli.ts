import path from 'node:path';
import process from 'node:process';
import {
  discoverWebPlusItems,
  fetchRawDocument,
  loadSourceDirectory,
  parseWebPlusNotice,
} from '@nju-info/collector';
import type { SourceConfig, WebPlusSourceConfig } from '@nju-info/core';

function sourceDirectory(): string {
  return path.resolve(process.cwd(), '../../sources/nju');
}

async function loadSources(): Promise<SourceConfig[]> {
  return loadSourceDirectory(sourceDirectory());
}

function findSource(sources: SourceConfig[], id: string): SourceConfig {
  const source = sources.find((item) => item.id === id);
  if (!source) throw new Error(`unknown source: ${id}`);
  return source;
}

function requireWebPlus(source: SourceConfig): WebPlusSourceConfig {
  if (source.adapter.type !== 'webplus') {
    throw new Error(`${source.id} is not a WebPlus source yet`);
  }
  return source as WebPlusSourceConfig;
}

async function main(): Promise<void> {
  const [command = 'sources', sourceId, limitArg] = process.argv.slice(2);
  const sources = await loadSources();

  if (command === 'sources') {
    console.log(
      JSON.stringify(
        sources.map(({ id, name, url, adapter }) => ({ id, name, url, adapter: adapter.type })),
        null,
        2,
      ),
    );
    return;
  }

  if (!sourceId) throw new Error(`usage: ${command} <source-id> [limit]`);
  const source = requireWebPlus(findSource(sources, sourceId));
  const listRaw = await fetchRawDocument(source.id, source.url);
  const items = discoverWebPlusItems(listRaw, source);

  if (command === 'discover') {
    console.log(JSON.stringify(items.slice(0, Number(limitArg ?? 10)), null, 2));
    return;
  }

  if (command === 'fetch') {
    const limit = Number(limitArg ?? 1);
    const notices = [];
    for (const item of items.slice(0, limit)) {
      const detailRaw = await fetchRawDocument(source.id, item.url);
      notices.push(parseWebPlusNotice(detailRaw, source, item));
    }
    console.log(JSON.stringify(notices, null, 2));
    return;
  }

  throw new Error(`unknown command: ${command}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});

