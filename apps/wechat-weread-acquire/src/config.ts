import path from 'node:path';
import { z } from 'zod';

const runtimeSchema = z.object({
  inputPath: z.string().min(1),
  outputRoot: z.string().min(1),
  protectedRoot: z.string().min(1),
  sourcePolicyPath: z.string().min(1).optional(),
}).strict();

export type WereadAcquireRuntime = z.infer<typeof runtimeSchema>;

export function runtimeFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  args: readonly string[] = [],
): WereadAcquireRuntime {
  const normalizedArgs = args[0] === '--' ? args.slice(1) : args;
  if (normalizedArgs.length > 1 || (normalizedArgs.length === 1 && normalizedArgs[0] !== '--shadow')) {
    throw new Error('Usage: wechat-weread-acquire [--shadow]');
  }
  const shadow = normalizedArgs[0] === '--shadow';
  if (shadow && !env.WECHAT_WEREAD_SOURCE_POLICY) {
    throw new Error('--shadow requires WECHAT_WEREAD_SOURCE_POLICY');
  }
  if (!shadow && env.WECHAT_WEREAD_SOURCE_POLICY !== undefined) {
    throw new Error('WECHAT_WEREAD_SOURCE_POLICY requires explicit --shadow');
  }
  return runtimeSchema.parse({
    inputPath: env.WECHAT_WEREAD_INPUT,
    outputRoot: env.WECHAT_WEREAD_OUTPUT_ROOT,
    protectedRoot: env.WECHAT_WEREAD_PROTECTED_ROOT,
    ...(shadow ? { sourcePolicyPath: env.WECHAT_WEREAD_SOURCE_POLICY } : {}),
  });
}

export function assertAbsoluteRuntime(runtime: WereadAcquireRuntime): WereadAcquireRuntime {
  const parsed = runtimeSchema.parse(runtime);
  for (const [name, value] of Object.entries(parsed)) {
    if (value !== undefined && !path.isAbsolute(value)) throw new Error(`${name} must be an absolute path`);
  }
  return parsed;
}
