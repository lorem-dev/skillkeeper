//! System [`Clock`] backed by the wall clock.

use std::time::{SystemTime, UNIX_EPOCH};

use crate::ports::Clock;

/// A [`Clock`] that reads the current wall-clock time.
#[derive(Debug, Clone, Copy, Default)]
pub struct SystemClock;

impl SystemClock {
    /// Create a new system clock.
    pub fn new() -> Self {
        Self
    }
}

impl Clock for SystemClock {
    fn now(&self) -> i64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn now_returns_a_plausible_epoch_millis() {
        // Comfortably after 2020-01-01 (1_577_836_800_000 ms).
        assert!(SystemClock::new().now() > 1_577_836_800_000);
    }
}
