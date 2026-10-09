import { Cron } from "croner";
import type { CollectionTrigger } from "@nju-info/core";

export interface CollectionSchedulerOptions {
  schedule: string;
  timeZone: string;
  collect: (trigger: CollectionTrigger) => Promise<void>;
  onError?: (error: unknown, trigger: CollectionTrigger) => void;
  onSuccess?: (trigger: CollectionTrigger) => void | Promise<void>;
  runOnStart?: boolean;
}

export interface CollectionScheduler {
  start(): Promise<void>;
  trigger(): Promise<boolean>;
  stop(): void;
}

export function createCollectionScheduler(options: CollectionSchedulerOptions): CollectionScheduler {
  let active = false;
  let started = false;
  let stopped = false;

  const execute = async (trigger: CollectionTrigger): Promise<boolean> => {
    if (active || stopped) return false;
    active = true;
    try {
      await options.collect(trigger);
      await options.onSuccess?.(trigger);
      return true;
    } catch (error) {
      options.onError?.(error, trigger);
      return false;
    } finally {
      active = false;
    }
  };

  const job = new Cron(
    options.schedule,
    {
      timezone: options.timeZone,
      paused: true,
      protect: true,
    },
    async () => { await execute("scheduled"); },
  );

  return {
    async start() {
      if (started || stopped) return;
      started = true;
      if (options.runOnStart !== false) await execute("startup");
      if (!stopped) job.resume();
    },
    trigger: () => execute("manual"),
    stop() {
      if (stopped) return;
      stopped = true;
      job.stop();
    },
  };
}
