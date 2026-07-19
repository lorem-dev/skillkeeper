//! Date/time formatting helpers with no external date-library dependency.
//!
//! The domain records ISO-8601 UTC timestamps from an injectable epoch-millis
//! clock (see [`crate::ports::Clock`]). This module is the single canonical
//! formatter shared by the install engine and the Tauri command surface.

/// Format epoch milliseconds as an ISO-8601 UTC timestamp with millisecond
/// precision (`YYYY-MM-DDTHH:MM:SS.mmmZ`), matching `new Date(ms).toISOString()`
/// for the timestamps this domain records.
pub fn iso_from_millis(ms: i64) -> String {
    let total_secs = ms.div_euclid(1000);
    let millis = ms.rem_euclid(1000);
    let days = total_secs.div_euclid(86_400);
    let secs_of_day = total_secs.rem_euclid(86_400);
    let hour = secs_of_day / 3600;
    let minute = (secs_of_day % 3600) / 60;
    let second = secs_of_day % 60;
    let (year, month, day) = civil_from_days(days);
    format!("{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}.{millis:03}Z")
}

/// Gregorian (year, month, day) for a count of days since the Unix epoch, using
/// Howard Hinnant's `civil_from_days` algorithm.
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let year = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let month = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    let year = if month <= 2 { year + 1 } else { year };
    (year, month, day)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn iso_from_millis_matches_known_timestamps() {
        assert_eq!(iso_from_millis(0), "1970-01-01T00:00:00.000Z");
        assert_eq!(iso_from_millis(1000), "1970-01-01T00:00:01.000Z");
        assert_eq!(
            iso_from_millis(1_600_000_000_000),
            "2020-09-13T12:26:40.000Z"
        );
        assert_eq!(
            iso_from_millis(1_600_000_000_123),
            "2020-09-13T12:26:40.123Z"
        );
        assert_eq!(
            iso_from_millis(1_752_710_400_000),
            "2025-07-17T00:00:00.000Z"
        );
    }
}
