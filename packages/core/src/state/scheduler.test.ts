import { describe, expect, it } from 'vitest';
import { Scheduler } from './scheduler.js';
import type { Clock } from '../kernel/ports.js';

/** A controllable clock for deterministic scheduler tests. */
function fakeClock(
  start = 0,
): Clock & { advance: (ms: number) => void; set: (ms: number) => void } {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
    set: (ms: number) => {
      t = ms;
    },
  };
}

const HOUR = 3_600_000;

describe('Scheduler - startup behavior', () => {
  it('reports startup checks for on-startup and scheduled modes only', () => {
    const clock = fakeClock();
    expect(new Scheduler({ mode: 'manual', intervalHours: 24 }, clock).shouldCheckOnStartup()).toBe(
      false,
    );
    expect(
      new Scheduler({ mode: 'on-startup', intervalHours: 24 }, clock).shouldCheckOnStartup(),
    ).toBe(true);
    expect(
      new Scheduler(
        { mode: 'scheduled', intervalHours: 24, checkOnStartup: true },
        clock,
      ).shouldCheckOnStartup(),
    ).toBe(true);
    expect(
      new Scheduler(
        { mode: 'scheduled', intervalHours: 24, checkOnStartup: false },
        clock,
      ).shouldCheckOnStartup(),
    ).toBe(false);
    // Absent checkOnStartup defaults to true for scheduled mode.
    expect(
      new Scheduler({ mode: 'scheduled', intervalHours: 24 }, clock).shouldCheckOnStartup(),
    ).toBe(true);
  });
});

describe('Scheduler - isDue predicate edges', () => {
  it('is false in manual mode regardless of elapsed time', () => {
    const clock = fakeClock();
    const s = new Scheduler({ mode: 'manual', intervalHours: 1 }, clock);
    clock.advance(100 * HOUR);
    expect(s.isDue()).toBe(false);
  });

  it('is true before the first baseline in scheduled mode', () => {
    const s = new Scheduler({ mode: 'scheduled', intervalHours: 1 }, fakeClock());
    expect(s.isDue()).toBe(true);
  });
});

describe('Scheduler - due timing', () => {
  it('manual mode is never due', async () => {
    const clock = fakeClock();
    const s = new Scheduler({ mode: 'manual', intervalHours: 1 }, clock);
    clock.advance(100 * HOUR);
    let fired = 0;
    await s.checkDue(async () => {
      fired++;
    });
    expect(fired).toBe(0);
  });

  it('scheduled mode does not fire before the interval elapses', async () => {
    const clock = fakeClock();
    const s = new Scheduler({ mode: 'scheduled', intervalHours: 24 }, clock);
    let fired = 0;
    const run = async (): Promise<void> => {
      fired++;
    };
    // First call establishes the baseline without firing.
    await s.checkDue(run);
    clock.advance(23 * HOUR);
    await s.checkDue(run);
    expect(fired).toBe(0);
  });

  it('scheduled mode fires once the interval has elapsed', async () => {
    const clock = fakeClock();
    const s = new Scheduler({ mode: 'scheduled', intervalHours: 24 }, clock);
    let fired = 0;
    const run = async (): Promise<void> => {
      fired++;
    };
    await s.checkDue(run);
    clock.advance(24 * HOUR);
    await s.checkDue(run);
    expect(fired).toBe(1);
    // After firing, the next interval restarts.
    clock.advance(1 * HOUR);
    await s.checkDue(run);
    expect(fired).toBe(1);
    clock.advance(24 * HOUR);
    await s.checkDue(run);
    expect(fired).toBe(2);
  });

  it('isDue is a pure predicate that does not change state', () => {
    const clock = fakeClock();
    const s = new Scheduler({ mode: 'scheduled', intervalHours: 1 }, clock);
    s.markChecked();
    expect(s.isDue()).toBe(false);
    clock.advance(HOUR);
    expect(s.isDue()).toBe(true);
    // Repeated reads do not consume the due state.
    expect(s.isDue()).toBe(true);
  });
});

describe('Scheduler - concurrency', () => {
  it('overlapping due checks do not double-fire', async () => {
    const clock = fakeClock();
    const s = new Scheduler({ mode: 'scheduled', intervalHours: 1 }, clock);
    await s.checkDue(async () => {});
    clock.advance(2 * HOUR);

    let running = 0;
    let maxConcurrent = 0;
    let fired = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const run = async (): Promise<void> => {
      fired++;
      running++;
      maxConcurrent = Math.max(maxConcurrent, running);
      await gate;
      running--;
    };

    // Fire two overlapping due-checks; the second must be a no-op while the
    // first is in flight.
    const a = s.checkDue(run);
    const b = s.checkDue(run);
    release();
    await Promise.all([a, b]);

    expect(fired).toBe(1);
    expect(maxConcurrent).toBe(1);
  });

  it('allows a new check after the in-flight one settles', async () => {
    const clock = fakeClock();
    const s = new Scheduler({ mode: 'scheduled', intervalHours: 1 }, clock);
    await s.checkDue(async () => {});
    let fired = 0;
    clock.advance(2 * HOUR);
    await s.checkDue(async () => {
      fired++;
    });
    clock.advance(2 * HOUR);
    await s.checkDue(async () => {
      fired++;
    });
    expect(fired).toBe(2);
  });
});
