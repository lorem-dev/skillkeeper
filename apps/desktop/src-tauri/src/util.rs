//! Small cross-platform process helpers.

use std::process::Command;

/// Prevent a console window from flashing when this GUI app (which has no console
/// of its own) spawns a console subprocess on Windows -- `ssh-add`, `where`, an
/// editor CLI, etc. Without the `CREATE_NO_WINDOW` creation flag each such spawn
/// briefly pops a console window, which reads as flicker. No-op on other
/// platforms, where child processes never create a console window.
pub fn hide_console(command: &mut Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    #[cfg(not(windows))]
    let _ = command;
}
