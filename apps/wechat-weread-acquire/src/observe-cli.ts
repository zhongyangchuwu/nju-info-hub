import { observeWereadSource } from './observe.js';

try {
  const args = process.argv.slice(2);
  const paths = args[0] === '--' ? args.slice(1) : args;
  const protectedRoot = process.env.WECHAT_WEREAD_PROTECTED_ROOT;
  if (paths.length !== 2 || !protectedRoot) {
    throw new Error('Usage: observe -- <observations.json> <output-root>; WECHAT_WEREAD_PROTECTED_ROOT required');
  }
  const result = await observeWereadSource({ observationsPath: paths[0]!, outputRoot: paths[1]!, protectedRoot });
  process.stdout.write(JSON.stringify(result) + '\n');
} catch {
  process.stderr.write('wechat-weread observe failed; use observe -- <observations.json> <output-root> with WECHAT_WEREAD_PROTECTED_ROOT\n');
  process.exitCode = 1;
}
