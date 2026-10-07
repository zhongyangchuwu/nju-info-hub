import { acquireWereadLatest } from './acquire.js';
import { runtimeFromEnv } from './config.js';

try {
  const result = await acquireWereadLatest(runtimeFromEnv());
  process.stdout.write(JSON.stringify(result) + '\n');
} catch (error) {
  const message = error instanceof Error ? error.message : 'unknown error';
  process.stderr.write(`wechat-weread-acquire failed: ${message}\n`);
  process.exitCode = 1;
}
