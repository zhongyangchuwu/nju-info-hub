import { describe, expect, it } from "vitest";
import { createCollectionScheduler } from "./scheduler.js";

const sleep = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

describe("collection scheduler", () => {
  it("runs once at startup and then follows the cron schedule", async () => {
    let calls = 0;
    const scheduler = createCollectionScheduler({
      schedule: "*/1 * * * * *",
      timeZone: "UTC",
      collect: async () => { calls += 1; },
    });
    await scheduler.start();
    expect(calls).toBe(1);
    await sleep(1_150);
    scheduler.stop();
    expect(calls).toBeGreaterThanOrEqual(2);
  });

  it("prevents overlapping collections", async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const scheduler = createCollectionScheduler({
      schedule: "0 0 1 1 *",
      timeZone: "UTC",
      runOnStart: false,
      collect: () => blocked,
    });
    await scheduler.start();
    const first = scheduler.trigger();
    await Promise.resolve();
    expect(await scheduler.trigger()).toBe(false);
    release();
    expect(await first).toBe(true);
    scheduler.stop();
  });

  it("reports successful triggers for readiness hooks", async () => {
    const successes: string[] = [];
    const scheduler = createCollectionScheduler({
      schedule: "0 0 1 1 *",
      timeZone: "UTC",
      collect: async () => {},
      onSuccess: (trigger) => { successes.push(trigger); },
    });
    await scheduler.start();
    expect(successes).toEqual(["startup"]);
    expect(await scheduler.trigger()).toBe(true);
    expect(successes).toEqual(["startup", "manual"]);
    scheduler.stop();
  });

  it("logs a transient failure and accepts later runs", async () => {
    let calls = 0;
    const failures: string[] = [];
    const scheduler = createCollectionScheduler({
      schedule: "0 0 1 1 *",
      timeZone: "UTC",
      collect: async () => {
        calls += 1;
        if (calls === 1) throw new Error("temporary upstream failure");
      },
      onError: (error) => failures.push(error instanceof Error ? error.message : String(error)),
    });
    await scheduler.start();
    expect(failures).toEqual(["temporary upstream failure"]);
    expect(await scheduler.trigger()).toBe(true);
    expect(calls).toBe(2);
    scheduler.stop();
  });
});
