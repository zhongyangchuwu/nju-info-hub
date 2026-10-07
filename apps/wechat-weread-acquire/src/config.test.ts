import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { assertAbsoluteRuntime, runtimeFromEnv } from './config.js';

const env = {
  WECHAT_WEREAD_INPUT: path.join(os.tmpdir(), 'synthetic-input.json'),
  WECHAT_WEREAD_OUTPUT_ROOT: path.join(os.tmpdir(), 'synthetic-output'),
  WECHAT_WEREAD_PROTECTED_ROOT: path.join(os.tmpdir(), 'synthetic-provider-state'),
};
const policyPath = path.join(os.tmpdir(), 'synthetic-policy.json');

describe('shadow CLI boundary', () => {
  it('requires both explicit --shadow and a separately supplied source policy', () => {
    expect(() => runtimeFromEnv(env, ['--shadow'])).toThrow(/requires WECHAT_WEREAD_SOURCE_POLICY/);
    expect(() => runtimeFromEnv({ ...env, WECHAT_WEREAD_SOURCE_POLICY: policyPath })).toThrow(/explicit --shadow/);
    expect(runtimeFromEnv(env)).not.toHaveProperty('sourcePolicyPath');
    expect(runtimeFromEnv({ ...env, WECHAT_WEREAD_SOURCE_POLICY: policyPath }, ['--shadow']).sourcePolicyPath).toBe(policyPath);
    expect(runtimeFromEnv({ ...env, WECHAT_WEREAD_SOURCE_POLICY: policyPath }, ['--', '--shadow']).sourcePolicyPath)
      .toBe(policyPath);
  });

  it.each([['--approve'], ['--publish'], ['--shadow', '--approve'], ['--shadow', '--shadow']])(
    'rejects unsupported arguments %j', (...args) => {
      expect(() => runtimeFromEnv({ ...env, WECHAT_WEREAD_SOURCE_POLICY: policyPath }, args)).toThrow(/Usage/);
    },
  );

  it('rejects relative source policy paths and unexpected runtime fields', () => {
    const runtime = runtimeFromEnv({ ...env, WECHAT_WEREAD_SOURCE_POLICY: 'policy.json' }, ['--shadow']);
    expect(() => assertAbsoluteRuntime(runtime)).toThrow(/sourcePolicyPath must be an absolute path/);
    expect(() => assertAbsoluteRuntime({ ...runtimeFromEnv(env), publicationEligible: true } as never)).toThrow();
  });
});
