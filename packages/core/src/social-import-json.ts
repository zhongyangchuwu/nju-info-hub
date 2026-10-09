export const socialImportLimits = Object.freeze({
  maxItems: 1_000,
  maxBundleBytes: 16 * 1024 * 1024,
  maxBlobBytes: 1024 * 1024,
  maxTotalBlobBytes: 64 * 1024 * 1024,
});

interface ObjectFrame {
  keys: Set<string>;
  expectingKey: boolean;
}

/** Reject ambiguous object members before native parsing discards exact transport content.
 * The scanner only tracks object key positions; JSON.parse still owns JSON syntax validation.
 * Decoded key comparison also rejects escaped-equivalent names such as content/\u0063ontent.
 */
export function parseSocialImportJson(bytes: Buffer): unknown {
  if (bytes.length > socialImportLimits.maxBundleBytes) throw new Error('Social JSON exceeds transport limit');
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  const frames: (ObjectFrame | null)[] = [];
  let index = 0;
  while (index < text.length) {
    const character = text[index];
    if (character === '"') {
      const start = index++;
      let closed = false;
      while (index < text.length) {
        if (text[index] === '\\') {
          index += 2;
        } else if (text[index++] === '"') {
          closed = true;
          break;
        }
      }
      if (!closed) throw new Error('Unterminated social JSON string');
      const frame = frames.at(-1);
      if (frame?.expectingKey) {
        const key: unknown = JSON.parse(text.slice(start, index));
        if (typeof key !== 'string') throw new Error('Invalid social JSON member');
        if (frame.keys.has(key)) throw new Error('Duplicate social JSON member');
        frame.keys.add(key);
        frame.expectingKey = false;
      }
      continue;
    }
    if (character === '{') frames.push({ keys: new Set(), expectingKey: true });
    else if (character === '[') frames.push(null);
    else if (character === '}' || character === ']') frames.pop();
    else if (character === ',') {
      const frame = frames.at(-1);
      if (frame) frame.expectingKey = true;
    }
    index++;
  }
  return JSON.parse(text) as unknown;
}
