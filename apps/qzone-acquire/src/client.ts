import { z } from 'zod';
import { socialNativeIdentitySchema } from '@nju-info/core';
import { parseQzoneRuntimeConfig, type QzoneRuntimeConfig } from './config.js';
import { projectQzonePost, type QzonePost } from './normalize.js';

export type AcquisitionErrorCode = 'authentication' | 'rate-limited' | 'provider' | 'transport' | 'invalid-response';

export class QzoneAcquisitionError extends Error {
  constructor(readonly code: AcquisitionErrorCode) {
    super(`QZone acquisition failed: ${code}`);
    this.name = 'QzoneAcquisitionError';
  }
}

const feedSchema = z.object({
  ok: z.literal(true),
  data: z.object({ items: z.array(z.unknown()).max(10), cursor: z.string(), has_more: z.boolean() }),
});
const detailSchema = z.object({ ok: z.literal(true), data: z.object({ post: z.unknown() }) });
const maxResponseBytes = 2 * 1024 * 1024;

export interface QzoneRead<T> {
  data: T;
  acquiredAt: string;
}

/** Collector-side only. No generic request/action surface and no login or session access. */
export class AstrBotQzoneClient {
  #origin: string;
  #token: string;
  #uin: string;
  #knownIds = new Set<string>();

  constructor(config: QzoneRuntimeConfig, uin: string) {
    // Validate even programmatic callers; errors never include endpoint or token values.
    const checked = parseQzoneRuntimeConfig({
      QZONE_ASTRBOT_URL: config.origin, QZONE_ASTRBOT_TOKEN: config.token,
      QZONE_ASTRBOT_VERSION: config.astrbotVersion, QZONE_PLUGIN_VERSION: config.pluginVersion,
    });
    const identity = socialNativeIdentitySchema.safeParse({
      platform: 'qzone', publisher: { scheme: 'qzone-uin', version: 1, value: uin },
      item: { scheme: 'qzone-tid', version: 1, tid: 'validation' },
    });
    if (!identity.success) throw new Error('Invalid allowlisted QZone publisher identity');
    this.#origin = checked.origin;
    this.#token = checked.token;
    this.#uin = uin;
  }

  async #read(operation: 'feed' | 'detail', params: URLSearchParams): Promise<QzoneRead<unknown>> {
    const url = new URL(`/api/plugin/astrbot_plugin_qzone/page/${operation}`, this.#origin);
    url.search = params.toString();
    try {
      const response = await fetch(url, {
        method: 'GET', headers: { accept: 'application/json', authorization: `Bearer ${this.#token}` },
        redirect: 'manual', signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) {
        await response.body?.cancel();
        if (response.status === 401 || response.status === 403) throw new QzoneAcquisitionError('authentication');
        if (response.status === 429) throw new QzoneAcquisitionError('rate-limited');
        throw new QzoneAcquisitionError('provider');
      }
      if (!response.headers.get('content-type')?.toLowerCase().startsWith('application/json')) {
        await response.body?.cancel();
        throw new QzoneAcquisitionError('invalid-response');
      }
      const reader = response.body?.getReader();
      if (!reader) throw new QzoneAcquisitionError('invalid-response');
      const chunks: Uint8Array[] = [];
      let length = 0;
      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          length += chunk.value.byteLength;
          if (length > maxResponseBytes) {
            await reader.cancel();
            throw new QzoneAcquisitionError('invalid-response');
          }
          chunks.push(chunk.value);
        }
      } finally {
        reader.releaseLock();
      }
      let data: unknown;
      try {
        data = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, length)));
      } catch {
        throw new QzoneAcquisitionError('invalid-response');
      }
      if (typeof data === 'object' && data !== null && 'ok' in data && data.ok === false) {
        throw new QzoneAcquisitionError('provider');
      }
      return { data, acquiredAt: new Date().toISOString() };
    } catch (error) {
      if (error instanceof QzoneAcquisitionError) throw error;
      throw new QzoneAcquisitionError('transport');
    }
  }

  async feed(): Promise<QzoneRead<QzonePost[]>> {
    this.#knownIds.clear();
    const result = await this.#read('feed', new URLSearchParams({ scope: 'profile', hostuin: this.#uin, limit: '10' }));
    const parsed = feedSchema.safeParse(result.data);
    if (!parsed.success) throw new QzoneAcquisitionError('invalid-response');
    let posts: QzonePost[];
    try {
      posts = parsed.data.data.items.map((post) => projectQzonePost(post, this.#uin));
    } catch {
      throw new QzoneAcquisitionError('invalid-response');
    }
    for (const post of posts) {
      const id = `${post.uin}:${post.tid}`;
      if (this.#knownIds.has(id)) {
        this.#knownIds.clear();
        throw new QzoneAcquisitionError('invalid-response');
      }
      this.#knownIds.add(id);
    }
    return { data: posts, acquiredAt: result.acquiredAt };
  }

  async detail(post: QzonePost): Promise<QzoneRead<QzonePost>> {
    const id = `${post.uin}:${post.tid}`;
    if (post.uin !== this.#uin || !this.#knownIds.has(id)) throw new QzoneAcquisitionError('invalid-response');
    const result = await this.#read('detail', new URLSearchParams({ id }));
    const parsed = detailSchema.safeParse(result.data);
    if (!parsed.success || parsed.data.data.post === undefined) throw new QzoneAcquisitionError('invalid-response');
    try {
      return { data: projectQzonePost(parsed.data.data.post, this.#uin, id), acquiredAt: result.acquiredAt };
    } catch {
      throw new QzoneAcquisitionError('invalid-response');
    }
  }
}
