import { describe, expect, it } from 'vitest';
import { parseSourceConfig } from './schemas.js';

describe('parseSourceConfig', () => {
  it('parses a WebPlus source', () => {
    const source = parseSourceConfig({
      schemaVersion: 1,
      id: 'nju-cs-graduate',
      name: 'Computer Science graduate notices',
      organization: { id: 'nju-cs', name: '计算机学院' },
      url: 'https://cs.nju.edu.cn/1703/list.htm',
      adapter: { type: 'webplus' },
      audience: ['graduate'],
      categories: ['graduate'],
    });

    expect(source.adapter.type).toBe('webplus');
    expect(source.enabled).toBe(true);
  });

  it('rejects unknown adapters', () => {
    expect(() =>
      parseSourceConfig({
        schemaVersion: 1,
        id: 'nju-test',
        name: 'Test',
        organization: { id: 'nju-test-org', name: 'Test' },
        url: 'https://example.com',
        adapter: { type: 'unknown' },
      }),
    ).toThrow(/unsupported adapter type/);
  });
});

