import { Cron } from "croner";

export interface CollectionSchedulerOptions {
  schedule: string;
  timeZone: string;
  collect: () => Promise<void>;
  onError?: (error: unknown, trigger: "startup" | "scheduled" | "manual") => void;
  onSuccess?: (trigger: "startup" | "scheduled" | "manual") => void | Promise<void>;
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

  const execute = async (trigger: "startup" | "scheduled" | "manual"): Promise<boolean> => {
    if (active || stopped) return false;
    active = true;
    try {
      await options.collect();
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
