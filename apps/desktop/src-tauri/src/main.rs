#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // `ssh` invokes this same binary as its askpass helper, passing the prompt
    // as the single argument. That path must not start Tauri, a webview, or any
    // window: it prints one line and exits.
    let args: Vec<String> = std::env::args().skip(1).collect();
    if skillkeeper_lib::app::askpass::is_helper_invocation(&args) {
        std::process::exit(skillkeeper_lib::app::askpass::helper_main(&args));
    }
    skillkeeper_lib::run()
}
