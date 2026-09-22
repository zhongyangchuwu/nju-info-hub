import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { parseSourceConfig, type SourceConfig } from '@nju-info/core';
import { parse as parseYaml } from 'yaml';

export async function loadSourceFile(filePath: string): Promise<SourceConfig> {
  const source = await readFile(filePath, 'utf8');
  return parseSourceConfig(parseYaml(source));
}

export async function loadSourceDirectory(dirPath: string): Promise<SourceConfig[]> {
  const names = (await readdir(dirPath))
    .filter((name) => name.endsWith('.yaml') || name.endsWith('.yml'))
    .sort();

  const sources = await Promise.all(
    names.map((name) => loadSourceFile(path.join(dirPath, name))),
  );

  const ids = new Set<string>();
  for (const source of sources) {
    if (ids.has(source.id)) {
      throw new Error(`duplicate source id: ${source.id}`);
    }
    ids.add(source.id);
  }

  return sources;
}

