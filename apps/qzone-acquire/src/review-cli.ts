import path from 'node:path';
import { createQzoneShadow, reviewQzoneShadow } from './review.js';

const usage = 'usage: qzone-offline <shadow|review> -- <input-run-dir> <selection-or-decisions.json> <current-policy.json> <output-root>';
const configurationError = 'QZONE_PROTECTED_ROOT must be an absolute canonical platform state/session root';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args.shift();
  if (args[0] === '--') args.shift();
  if ((command !== 'shadow' && command !== 'review') || args.length !== 4 ||
      args.some((arg) => !path.isAbsolute(arg))) throw new Error(usage);
  const protectedRoot = process.env.QZONE_PROTECTED_ROOT;
  if (!protectedRoot || !path.isAbsolute(protectedRoot) || path.resolve(protectedRoot) !== protectedRoot ||
      /[\u0000-\u001f\u007f]/.test(protectedRoot)) throw new Error(configurationError);
  const common = { inputDir: args[0]!, policyPath: args[2]!, outputRoot: args[3]!, protectedRoot };
  const result = command === 'shadow'
    ? await createQzoneShadow({ ...common, selectionPath: args[1]! })
    : await reviewQzoneShadow({ ...common, decisionsPath: args[1]! });
  console.log(JSON.stringify(result));
}

main().catch((error: unknown) => {
  const message = error instanceof Error && (error.message === usage || error.message === configurationError)
    ? error.message : 'QZone offline operation failed';
  console.error(message);
  process.exitCode = 1;
});
