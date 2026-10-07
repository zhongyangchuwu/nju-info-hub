import { readFile } from 'node:fs/promises';
import { acquireQzone } from './acquire.js';
import { QzoneAcquisitionError } from './client.js';
import { parseQzonePolicy, parseQzoneRuntimeConfig } from './config.js';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args[0] === '--') args.shift();
  if (args.length !== 2) throw new Error('usage: qzone-acquire <policy.json> <restricted-output-root>');
  let input: unknown;
  try {
    input = JSON.parse(await readFile(args[0]!, 'utf8'));
  } catch {
    throw new Error('Cannot read QZone source policy JSON');
  }
  const policy = parseQzonePolicy(input);
  const runtime = parseQzoneRuntimeConfig(process.env);
  const result = await acquireQzone(policy, runtime, args[1]!);
  console.log(JSON.stringify(result));
}

main().catch((error: unknown) => {
  // Never emit arbitrary provider, response, network, or filesystem error details.
  const safeMessages = [
    'usage: qzone-acquire <policy.json> <restricted-output-root>',
    'Cannot read QZone source policy JSON', 'Invalid QZone source policy',
    'QZone acquisition requires an allowlisted credentialed-public publisher policy',
    'QZone source qualification is not currently valid',
    'QZONE_ASTRBOT_URL, QZONE_ASTRBOT_TOKEN, QZONE_ASTRBOT_VERSION, QZONE_PLUGIN_VERSION and QZONE_PROTECTED_ROOT are required',
    'Invalid QZONE_ASTRBOT_URL', 'Invalid QZONE_ASTRBOT_TOKEN',
    'QZONE_ASTRBOT_URL must be a credential-free HTTPS origin or HTTP loopback origin',
    'QZONE_PROTECTED_ROOT must be an absolute platform state/session root',
    'Restricted output root must be absolute',
    'Restricted output must be separate from the repository and protected platform storage',
    'Restricted output must not resolve to repository or protected platform storage',
    'Restricted output path must not contain symlinks',
    'Restricted output root must be operator-owned and mode 0700',
  ];
  const message = error instanceof QzoneAcquisitionError ? error.message :
    error instanceof Error && safeMessages.includes(error.message) ? error.message : 'QZone acquisition failed';
  console.error(message);
  process.exitCode = 1;
});
