import path from 'node:path';
import { auditQzoneSource } from './audit.js';

const usage = 'usage: qzone-audit -- <manual-audit.json> <observations.json> <current-policy.json> <output-root>';
const configurationError = 'QZONE_PROTECTED_ROOT must be an absolute canonical platform state/session root';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args[0] === '--') args.shift();
  if (args.length !== 4 || args.some((arg) => !path.isAbsolute(arg))) throw new Error(usage);
  const protectedRoot = process.env.QZONE_PROTECTED_ROOT;
  if (!protectedRoot || !path.isAbsolute(protectedRoot) || path.resolve(protectedRoot) !== protectedRoot ||
      /[\u0000-\u001f\u007f]/.test(protectedRoot)) throw new Error(configurationError);
  const result = await auditQzoneSource({
    auditPath: args[0]!, observationsPath: args[1]!, policyPath: args[2]!, outputRoot: args[3]!, protectedRoot,
  });
  console.log(JSON.stringify(result));
}

main().catch((error: unknown) => {
  const message = error instanceof Error && (error.message === usage || error.message === configurationError)
    ? error.message : 'QZone offline audit failed';
  console.error(message);
  process.exitCode = 1;
});
