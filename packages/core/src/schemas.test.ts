import { describe, expect, it } from 'vitest';
import { parseSourceConfig } from './schemas.js';

const minimalSourceConfig = {
  schemaVersion: 1,
  id: 'nju-cs-graduate',
  name: 'Computer Science graduate notices',
  organization: { id: 'nju-cs', name: '计算机学院' },
  url: 'https://cs.nju.edu.cn/1703/list.htm',
  adapter: { type: 'webplus' },
};

describe('parseSourceConfig', () => {
  it('parses an existing minimal WebPlus source', () => {
    const source = parseSourceConfig(minimalSourceConfig);

    expect(source.adapter.type).toBe('webplus');
    expect(source.organization.kind).toBeUndefined();
    expect(source.classification).toBeUndefined();
  });

  it('parses a Boshan source', () => {
    const source = parseSourceConfig({
      ...minimalSourceConfig,
      id: 'nju-hospital-announcements',
      url: 'https://hospital.nju.edu.cn/xwgg/ggtz/index.html',
      adapter: {
        type: 'boshan',
        channelId: 18099,
        pageSize: 15,
        selectors: { content: '#zoom' },
      },
    });

    expect(source.adapter).toEqual({
      type: 'boshan',
      channelId: 18099,
      pageSize: 15,
      selectors: { content: '#zoom' },
    });
  });

  it.each([
    { channelId: 0, pageSize: 15, content: '#zoom' },
    { channelId: 18099, pageSize: 0, content: '#zoom' },
    { channelId: 18099, pageSize: 15, content: '' },
  ])('rejects invalid Boshan adapter config: %o', ({ channelId, pageSize, content }) => {
    expect(() =>
      parseSourceConfig({
        ...minimalSourceConfig,
        adapter: {
          type: 'boshan',
          channelId,
          pageSize,
          selectors: { content },
        },
      }),
    ).toThrow();
  });

  it('parses an employment information source', () => {
    const source = parseSourceConfig({
      ...minimalSourceConfig,
      id: 'nju-employment-news',
      url: 'https://job.nju.edu.cn/career/info?type=NEWS',
      adapter: {
        type: 'job-portal-information',
        contentType: 'NEWS',
        pageSize: 15,
      },
    });

    expect(source.adapter).toEqual({
      type: 'job-portal-information',
      contentType: 'NEWS',
      pageSize: 15,
    });
  });

  it.each([
    { contentType: 'OTHER', pageSize: 15 },
    { contentType: 'NEWS', pageSize: 0 },
    { contentType: 'NEWS', pageSize: 101 },
  ])(
    'rejects invalid employment information adapter config: %o',
    ({ contentType, pageSize }) => {
      expect(() =>
        parseSourceConfig({
          ...minimalSourceConfig,
          adapter: {
            type: 'job-portal-information',
            contentType,
            pageSize,
          },
        }),
      ).toThrow();
    },
  );

  it('parses an employment recruitment source', () => {
    const source = parseSourceConfig({
      ...minimalSourceConfig,
      id: 'nju-employment-recruitments',
      url: 'https://job.nju.edu.cn/career/jobs-v2',
      adapter: {
        type: 'job-portal-recruitment',
        pageSize: 20,
      },
    });

    expect(source.adapter).toEqual({
      type: 'job-portal-recruitment',
      pageSize: 20,
    });
  });

  it.each([0, 101])(
    'rejects invalid employment recruitment page size: %s',
    (pageSize) => {
      expect(() =>
        parseSourceConfig({
          ...minimalSourceConfig,
          adapter: {
            type: 'job-portal-recruitment',
            pageSize,
          },
        }),
      ).toThrow();
    },
  );

  it('parses optional source classification metadata', () => {
    const source = parseSourceConfig({
      ...minimalSourceConfig,
      organization: {
        ...minimalSourceConfig.organization,
        kind: 'academic-unit',
      },
      classification: {
        audiences: ['graduate-students'],
        topics: ['academics', 'research'],
      },
    });

    expect(source.organization.kind).toBe('academic-unit');
    expect(source.classification).toEqual({
      audiences: ['graduate-students'],
      topics: ['academics', 'research'],
    });
  });

  it('rejects invalid source classification metadata', () => {
    expect(() =>
      parseSourceConfig({
        ...minimalSourceConfig,
        organization: {
          ...minimalSourceConfig.organization,
          kind: 'department',
        },
      }),
    ).toThrow();

    expect(() =>
      parseSourceConfig({
        ...minimalSourceConfig,
        classification: {
          audiences: ['graduate-students', 'graduate-students'],
        },
      }),
    ).toThrow();

    expect(() =>
      parseSourceConfig({
        ...minimalSourceConfig,
        classification: { topics: ['Student Affairs'] },
      }),
    ).toThrow();

    expect(() =>
      parseSourceConfig({
        ...minimalSourceConfig,
        classification: {},
      }),
    ).toThrow();
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

