import path from 'node:path';
import { z } from 'zod';

const runtimeSchema = z.object({
  inputPath: z.string().min(1),
  outputRoot: z.string().min(1),
  protectedRoot: z.string().min(1),
}).strict();

export type WereadAcquireRuntime = z.infer<typeof runtimeSchema>;

export function runtimeFromEnv(env: NodeJS.ProcessEnv = process.env): WereadAcquireRuntime {
  return runtimeSchema.parse({
    inputPath: env.WECHAT_WEREAD_INPUT,
    outputRoot: env.WECHAT_WEREAD_OUTPUT_ROOT,
    protectedRoot: env.WECHAT_WEREAD_PROTECTED_ROOT,
  });
}

export function assertAbsoluteRuntime(runtime: WereadAcquireRuntime): WereadAcquireRuntime {
  for (const [name, value] of Object.entries(runtime)) {
    if (!path.isAbsolute(value)) throw new Error(`${name} must be an absolute path`);
  }
  return runtime;
}
