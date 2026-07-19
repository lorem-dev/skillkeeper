//! Update-check scheduling (Rust port of
//! `packages/core/src/state/scheduler.ts`).
//!
//! Pure timer logic over an injected [`Clock`]. The scheduler owns no real
//! timers; a host calls [`Scheduler::check_due`] periodically and the scheduler
//! decides whether a check is due. Overlapping due-checks never double-fire.
//!
//! Divergence from the TypeScript source: `checkDue` takes an async callback and
//! the "no double-fire while in flight" guard matters across `await` points.
//! This synchronous port keeps the same `#running` guard (over interior
//! mutability) so a re-entrant `check_due` call from within the running callback
//! is a no-op, matching the concurrency contract in a single-threaded world.

use std::cell::Cell;

use crate::ports::Clock;

/// Update-check scheduling mode.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SchedulerMode {
    Manual,
    OnStartup,
    Scheduled,
}

/// Scheduler configuration.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SchedulerConfig {
    pub mode: SchedulerMode,
    /// Interval between scheduled checks, in hours.
    pub interval_hours: i64,
    /// Whether `scheduled` mode also checks at startup (default true).
    pub check_on_startup: Option<bool>,
}

const MS_PER_HOUR: i64 = 3_600_000;

/// Pure timer logic for update checks over an injected [`Clock`].
pub struct Scheduler<'a> {
    config: SchedulerConfig,
    clock: &'a dyn Clock,
    last_checked: Cell<Option<i64>>,
    running: Cell<bool>,
}

impl<'a> Scheduler<'a> {
    /// Create a scheduler bound to a configuration and clock.
    pub fn new(config: SchedulerConfig, clock: &'a dyn Clock) -> Self {
        Self {
            config,
            clock,
            last_checked: Cell::new(None),
            running: Cell::new(false),
        }
    }

    /// Whether an update check should run at application startup.
    pub fn should_check_on_startup(&self) -> bool {
        match self.config.mode {
            SchedulerMode::OnStartup => true,
            SchedulerMode::Scheduled => self.config.check_on_startup.unwrap_or(true),
            SchedulerMode::Manual => false,
        }
    }

    /// Record that a check just happened (resets the interval baseline).
    pub fn mark_checked(&self) {
        self.last_checked.set(Some(self.clock.now()));
    }

    /// Pure predicate: whether a scheduled check is due now. Does not mutate
    /// state. Always false in non-scheduled modes. True before the first
    /// baseline so the first scheduled tick establishes the baseline.
    pub fn is_due(&self) -> bool {
        if self.config.mode != SchedulerMode::Scheduled {
            return false;
        }
        let Some(last) = self.last_checked.get() else {
            return true;
        };
        let elapsed = self.clock.now() - last;
        elapsed >= self.config.interval_hours * MS_PER_HOUR
    }

    /// Run `run` if a scheduled check is due and none is already in flight. The
    /// first call establishes the interval baseline without firing. While a run
    /// is in flight, concurrent (re-entrant) calls are no-ops (no double-fire).
    /// The baseline is advanced when a run starts so the next interval is
    /// measured from there.
    pub fn check_due(&self, run: impl FnOnce()) {
        if self.config.mode != SchedulerMode::Scheduled {
            return;
        }
        if self.running.get() {
            return;
        }
        if self.last_checked.get().is_none() {
            // Establish the baseline on the first observation without firing.
            self.last_checked.set(Some(self.clock.now()));
            return;
        }
        if !self.is_due() {
            return;
        }

        self.running.set(true);
        self.last_checked.set(Some(self.clock.now()));
        run();
        self.running.set(false);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A controllable clock for deterministic scheduler tests.
    struct FakeClock {
        t: Cell<i64>,
    }

    impl FakeClock {
        fn new(start: i64) -> Self {
            Self {
                t: Cell::new(start),
            }
        }

        fn advance(&self, ms: i64) {
            self.t.set(self.t.get() + ms);
        }
    }

    impl Clock for FakeClock {
        fn now(&self) -> i64 {
            self.t.get()
        }
    }

    const HOUR: i64 = 3_600_000;

    fn config(
        mode: SchedulerMode,
        interval_hours: i64,
        check_on_startup: Option<bool>,
    ) -> SchedulerConfig {
        SchedulerConfig {
            mode,
            interval_hours,
            check_on_startup,
        }
    }

    // --- startup behavior ---

    #[test]
    fn reports_startup_checks_for_on_startup_and_scheduled_modes_only() {
        let clock = FakeClock::new(0);
        assert!(
            !Scheduler::new(config(SchedulerMode::Manual, 24, None), &clock)
                .should_check_on_startup()
        );
        assert!(
            Scheduler::new(config(SchedulerMode::OnStartup, 24, None), &clock)
                .should_check_on_startup()
        );
        assert!(
            Scheduler::new(config(SchedulerMode::Scheduled, 24, Some(true)), &clock)
                .should_check_on_startup()
        );
        assert!(
            !Scheduler::new(config(SchedulerMode::Scheduled, 24, Some(false)), &clock)
                .should_check_on_startup()
        );
        // Absent check_on_startup defaults to true for scheduled mode.
        assert!(
            Scheduler::new(config(SchedulerMode::Scheduled, 24, None), &clock)
                .should_check_on_startup()
        );
    }

    // --- isDue predicate edges ---

    #[test]
    fn is_false_in_manual_mode_regardless_of_elapsed_time() {
        let clock = FakeClock::new(0);
        let s = Scheduler::new(config(SchedulerMode::Manual, 1, None), &clock);
        clock.advance(100 * HOUR);
        assert!(!s.is_due());
    }

    #[test]
    fn is_true_before_the_first_baseline_in_scheduled_mode() {
        let clock = FakeClock::new(0);
        let s = Scheduler::new(config(SchedulerMode::Scheduled, 1, None), &clock);
        assert!(s.is_due());
    }

    // --- due timing ---

    #[test]
    fn manual_mode_is_never_due() {
        let clock = FakeClock::new(0);
        let s = Scheduler::new(config(SchedulerMode::Manual, 1, None), &clock);
        clock.advance(100 * HOUR);
        let fired = Cell::new(0);
        s.check_due(|| fired.set(fired.get() + 1));
        assert_eq!(fired.get(), 0);
    }

    #[test]
    fn scheduled_mode_does_not_fire_before_the_interval_elapses() {
        let clock = FakeClock::new(0);
        let s = Scheduler::new(config(SchedulerMode::Scheduled, 24, None), &clock);
        let fired = Cell::new(0);
        // First call establishes the baseline without firing.
        s.check_due(|| fired.set(fired.get() + 1));
        clock.advance(23 * HOUR);
        s.check_due(|| fired.set(fired.get() + 1));
        assert_eq!(fired.get(), 0);
    }

    #[test]
    fn scheduled_mode_fires_once_the_interval_has_elapsed() {
        let clock = FakeClock::new(0);
        let s = Scheduler::new(config(SchedulerMode::Scheduled, 24, None), &clock);
        let fired = Cell::new(0);
        s.check_due(|| fired.set(fired.get() + 1));
        clock.advance(24 * HOUR);
        s.check_due(|| fired.set(fired.get() + 1));
        assert_eq!(fired.get(), 1);
        // After firing, the next interval restarts.
        clock.advance(HOUR);
        s.check_due(|| fired.set(fired.get() + 1));
        assert_eq!(fired.get(), 1);
        clock.advance(24 * HOUR);
        s.check_due(|| fired.set(fired.get() + 1));
        assert_eq!(fired.get(), 2);
    }

    #[test]
    fn is_due_is_a_pure_predicate_that_does_not_change_state() {
        let clock = FakeClock::new(0);
        let s = Scheduler::new(config(SchedulerMode::Scheduled, 1, None), &clock);
        s.mark_checked();
        assert!(!s.is_due());
        clock.advance(HOUR);
        assert!(s.is_due());
        // Repeated reads do not consume the due state.
        assert!(s.is_due());
    }

    // --- concurrency ---

    #[test]
    fn overlapping_due_checks_do_not_double_fire() {
        let clock = FakeClock::new(0);
        let s = Scheduler::new(config(SchedulerMode::Scheduled, 1, None), &clock);
        s.check_due(|| {}); // baseline
        clock.advance(2 * HOUR);

        let fired = Cell::new(0);
        // While the first check is in flight, a re-entrant due-check must be a
        // no-op (the running guard prevents a second fire).
        s.check_due(|| {
            fired.set(fired.get() + 1);
            s.check_due(|| fired.set(fired.get() + 1));
        });

        assert_eq!(fired.get(), 1);
    }

    #[test]
    fn allows_a_new_check_after_the_in_flight_one_settles() {
        let clock = FakeClock::new(0);
        let s = Scheduler::new(config(SchedulerMode::Scheduled, 1, None), &clock);
        s.check_due(|| {}); // baseline
        let fired = Cell::new(0);
        clock.advance(2 * HOUR);
        s.check_due(|| fired.set(fired.get() + 1));
        clock.advance(2 * HOUR);
        s.check_due(|| fired.set(fired.get() + 1));
        assert_eq!(fired.get(), 2);
    }

    // --- is_due across non-scheduled modes ---

    #[test]
    fn is_due_is_false_in_on_startup_mode_regardless_of_elapsed_time() {
        let clock = FakeClock::new(0);
        let s = Scheduler::new(config(SchedulerMode::OnStartup, 1, None), &clock);
        s.mark_checked();
        clock.advance(100 * HOUR);
        assert!(!s.is_due());
    }

    // --- check_due across non-scheduled modes ---

    #[test]
    fn check_due_is_a_noop_in_on_startup_mode() {
        let clock = FakeClock::new(0);
        let s = Scheduler::new(config(SchedulerMode::OnStartup, 1, None), &clock);
        clock.advance(100 * HOUR);
        let fired = Cell::new(0);
        s.check_due(|| fired.set(fired.get() + 1));
        assert_eq!(fired.get(), 0);
    }

    // --- timing boundaries ---

    #[test]
    fn scheduled_mode_fires_exactly_at_the_interval_boundary() {
        let clock = FakeClock::new(0);
        let s = Scheduler::new(config(SchedulerMode::Scheduled, 1, None), &clock);
        s.mark_checked();
        // One millisecond short of the interval is not yet due.
        clock.advance(HOUR - 1);
        assert!(!s.is_due());
        // Landing exactly on the interval is due (the comparison is `>=`).
        clock.advance(1);
        assert!(s.is_due());
    }

    #[test]
    fn scheduled_mode_fires_once_when_overdue_by_several_intervals() {
        let clock = FakeClock::new(0);
        let s = Scheduler::new(config(SchedulerMode::Scheduled, 24, None), &clock);
        let fired = Cell::new(0);
        s.check_due(|| fired.set(fired.get() + 1)); // baseline
                                                    // Far past several intervals; the scheduler still fires a single check.
        clock.advance(100 * 24 * HOUR);
        s.check_due(|| fired.set(fired.get() + 1));
        assert_eq!(fired.get(), 1);
    }

    #[test]
    fn a_zero_hour_interval_is_due_immediately_after_the_baseline() {
        let clock = FakeClock::new(0);
        let s = Scheduler::new(config(SchedulerMode::Scheduled, 0, None), &clock);
        s.mark_checked();
        // With a zero interval, any elapsed time (including none) is due.
        assert!(s.is_due());
    }

    // --- derived traits on the config value types ---

    #[test]
    fn config_and_mode_derive_debug_clone_and_equality() {
        let cfg = config(SchedulerMode::Scheduled, 24, Some(false));
        let copied = cfg;
        assert_eq!(cfg, copied);
        assert_ne!(cfg, config(SchedulerMode::Manual, 24, Some(false)));
        assert!(format!("{cfg:?}").contains("Scheduled"));
        assert_eq!(cfg.mode, SchedulerMode::Scheduled);
        assert!(format!("{:?}", cfg.mode).contains("Scheduled"));
    }
}
