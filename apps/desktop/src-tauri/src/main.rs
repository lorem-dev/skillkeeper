#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // `ssh` invokes this same binary as its askpass helper, passing the prompt
    // as the single argument. That path must not start Tauri, a webview, or any
    // window: it prints one line and exits.
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args
        .first()
        .is_some_and(|a| a == skillkeeper_lib::app::askpass::SELFTEST_FLAG)
    {
        // Verifies the askpass round trip on the machine it is run on, which is
        // the only way to check the Windows behaviour of a transport whose tests
        // run on unix.
        std::process::exit(skillkeeper_lib::app::askpass::selftest_main());
    }
    if skillkeeper_lib::app::askpass::is_helper_invocation(&args) {
        std::process::exit(skillkeeper_lib::app::askpass::helper_main(&args));
    }
    skillkeeper_lib::run()
}
