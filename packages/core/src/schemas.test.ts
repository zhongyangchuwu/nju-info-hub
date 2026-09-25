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
    });

    expect(source.adapter.type).toBe('webplus');
  });

  it('rejects unsupported adapters and removed source-policy fields', () => {
    expect(() =>
      parseSourceConfig({
        schemaVersion: 1,
        id: 'nju-test',
        name: 'Test',
        organization: { id: 'nju-test-org', name: 'Test' },
        url: 'https://example.com',
        adapter: { type: 'rsshub', route: '/test' },
      }),
    ).toThrow();

    expect(() =>
      parseSourceConfig({
        schemaVersion: 1,
        id: 'nju-test',
        name: 'Test',
        organization: { id: 'nju-test-org', name: 'Test' },
        url: 'https://example.com',
        adapter: { type: 'webplus' },
        enabled: false,
      }),
    ).toThrow();
  });
});

