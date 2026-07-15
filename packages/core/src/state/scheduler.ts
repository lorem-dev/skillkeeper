import type { Clock } from '../kernel/ports.js';

/** Update-check scheduling mode. */
export type SchedulerMode = 'manual' | 'on-startup' | 'scheduled';

/** Scheduler configuration. */
export interface SchedulerConfig {
  readonly mode: SchedulerMode;
  /** Interval between scheduled checks, in hours. */
  readonly intervalHours: number;
  /** Whether `scheduled` mode also checks at startup (default true). */
  readonly checkOnStartup?: boolean;
}

const MS_PER_HOUR = 3_600_000;

/**
 * Pure timer logic for update checks over an injected {@link Clock}. It owns no
 * real timers; a host calls {@link Scheduler.checkDue} periodically (or on a
 * real interval) and the scheduler decides whether a check is due. Overlapping
 * due-checks never double-fire.
 */
export class Scheduler {
  readonly #config: SchedulerConfig;
  readonly #clock: Clock;
  #lastChecked: number | undefined;
  #running = false;

  constructor(config: SchedulerConfig, clock: Clock) {
    this.#config = config;
    this.#clock = clock;
  }

  /** Whether an update check should run at application startup. */
  shouldCheckOnStartup(): boolean {
    if (this.#config.mode === 'on-startup') return true;
    if (this.#config.mode === 'scheduled') return this.#config.checkOnStartup ?? true;
    return false;
  }

  /** Record that a check just happened (resets the interval baseline). */
  markChecked(): void {
    this.#lastChecked = this.#clock.now();
  }

  /**
   * Pure predicate: whether a scheduled check is due now. Does not mutate state.
   * Always false in non-scheduled modes. True before the first baseline so the
   * first scheduled tick establishes the baseline.
   */
  isDue(): boolean {
    if (this.#config.mode !== 'scheduled') return false;
    if (this.#lastChecked === undefined) return true;
    const elapsed = this.#clock.now() - this.#lastChecked;
    return elapsed >= this.#config.intervalHours * MS_PER_HOUR;
  }

  /**
   * Run `run` if a scheduled check is due and none is already in flight. The
   * first call establishes the interval baseline without firing. While a run is
   * in flight, concurrent calls are no-ops (no double-fire). The baseline is
   * advanced when a run starts so the next interval is measured from there.
   */
  async checkDue(run: () => Promise<void>): Promise<void> {
    if (this.#config.mode !== 'scheduled') return;
    if (this.#running) return;
    if (this.#lastChecked === undefined) {
      // Establish the baseline on the first observation without firing.
      this.#lastChecked = this.#clock.now();
      return;
    }
    if (!this.isDue()) return;

    this.#running = true;
    this.#lastChecked = this.#clock.now();
    try {
      await run();
    } finally {
      this.#running = false;
    }
  }
}
