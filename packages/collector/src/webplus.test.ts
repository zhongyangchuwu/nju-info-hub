import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { RawDocument, WebPlusSourceConfig } from '@nju-info/core';
import { discoverWebPlusItems, parseWebPlusNotice } from './webplus.js';

const source: WebPlusSourceConfig = {
  schemaVersion: 1,
  id: 'nju-cs-graduate',
  name: '计算机学院研究生公告栏',
  organization: { id: 'nju-cs', name: '计算机学院' },
  url: 'https://cs.nju.edu.cn/1703/list.htm',
  adapter: { type: 'webplus' },
  audience: ['graduate'],
  categories: ['graduate'],
  enabled: true,
};

function raw(url: string, body: string): RawDocument {
  return {
    sourceId: source.id,
    url,
    fetchedAt: '2026-09-22T00:00:00.000Z',
    contentType: 'text/html; charset=utf-8',
    body,
    sha256: createHash('sha256').update(body).digest('hex'),
  };
}

describe('WebPlus adapter', () => {
  it('discovers article links and nearby publication dates', () => {
    const list = raw(
      source.url,
      `<ul class="news_list list2">
        <li><span class="news_title"><a href="/e2/e4/c1703a844516/page.htm" title="奖学金评选工作的通知">奖学金评选工作的通知</a></span><span class="news_meta">2026-09-21</span></li>
      </ul>`,
    );

    expect(discoverWebPlusItems(list, source)).toEqual([
      {
        sourceId: 'nju-cs-graduate',
        url: 'https://cs.nju.edu.cn/e2/e4/c1703a844516/page.htm',
        title: '奖学金评选工作的通知',
        publishedAtRaw: '2026-09-21',
      },
    ]);
  });

  it('parses content and both link/pdf-player attachments', () => {
    const detail = raw(
      'https://cs.nju.edu.cn/e2/e4/c1703a844516/page.htm',
      `<article>
        <h1 class="arti_title">计算机学院2026年研究生奖学金评选工作的通知</h1>
        <p class="arti_metas"><span class="arti_update">发布时间：2026-09-21</span></p>
        <div class="wp_articlecontent">
          <p>请按要求提交材料。</p>
          <span id="奖学金通知.pdf" class="wp_pdf_player" pdfsrc="/_upload/article/files/a/notice.pdf"></span>
          <a href="/_upload/article/files/a/form.xlsx" title="附件一：申请表.xlsx">附件一：申请表.xlsx</a>
        </div>
      </article>`,
    );

    const notice = parseWebPlusNotice(detail, source);
    expect(notice.title).toContain('研究生奖学金');
    expect(notice.publishedAtRaw).toBe('2026-09-21');
    expect(notice.bodyText).toContain('请按要求提交材料');
    expect(notice.attachments).toHaveLength(2);
    expect(notice.attachments.map((item) => item.url)).toEqual(
      expect.arrayContaining([
        'https://cs.nju.edu.cn/_upload/article/files/a/notice.pdf',
        'https://cs.nju.edu.cn/_upload/article/files/a/form.xlsx',
      ]),
    );
  });
});

