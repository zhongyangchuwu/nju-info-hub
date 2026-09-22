import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadSourceDirectory } from './registry.js';

describe('source registry', () => {
  it('loads every checked-in NJU source with unique ids', async () => {
    const directory = fileURLToPath(
      new URL('../../../sources/nju/', import.meta.url),
    );
    const sources = await loadSourceDirectory(directory);

    expect(sources.length).toBeGreaterThanOrEqual(8);
    expect(new Set(sources.map((source) => source.id)).size).toBe(
      sources.length,
    );
    expect(sources.every((source) => source.enabled)).toBe(true);
  });
});
