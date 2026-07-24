//! macOS application menu (a port of `apps/desktop/src/main/menu.ts`).
//!
//! Builds the mac-only application menu and emits `menu:navigate` (with a view
//! target string) or `menu:about` when a navigable item is clicked, mirroring
//! the Electron `onNavigate`/`onAbout` relays. On non-macOS platforms no
//! application menu is installed (matching the Electron `Menu.setApplicationMenu(null)`).
//!
//! i18n: the renderer's translation catalogs are TypeScript and are not
//! reachable from Rust without duplicating them. To keep this faithful and
//! simple, the menu labels are ENGLISH for now; full localization (rebuilding
//! the menu on a language change, as the Electron `rememberLanguage` did) is a
//! deferred follow-up. The navigable item *ids* -- the load-bearing part the
//! renderer reacts to -- are stable and localization-independent.
//!
//! Glyphs: the nav items carry the same stroke glyphs the Electron menu used
//! (the `build/menu-icons/*Template.png` masks, committed under
//! `src-tauri/icons/menu-icons/` and shipped as bundle `resources`). Tauri v2
//! *does* support a per-item image (`SubmenuBuilder::icon` / `submenu_icon` and
//! `IconMenuItemBuilder`), so the images are attached. Caveat: `muda` sets the
//! `NSMenuItem` image directly and does NOT flag it as a macOS *template*
//! image, so the system does not re-tint it per appearance the way an
//! Electron template image was -- the committed masks render with their own
//! pixels. Appearance-aware tinting would need upstream template support.

use tauri::image::Image;
use tauri::menu::{IconMenuItemBuilder, Menu, MenuBuilder, MenuItemBuilder, SubmenuBuilder};
use tauri::menu::{HELP_SUBMENU_ID, WINDOW_SUBMENU_ID};
use tauri::{AppHandle, Emitter, Runtime};

/// macOS menu-template glyphs (the @2x, 32px alpha masks), embedded so they
/// resolve without a runtime resource lookup. Keyed to the renderer's nav
/// sections, mirroring the Electron `withIcon` mapping in `menu.ts`.
const GLYPH_PROJECTS: &[u8] = include_bytes!("../../icons/menu-icons/projectsTemplate@2x.png");
const GLYPH_REPOSITORIES: &[u8] =
    include_bytes!("../../icons/menu-icons/repositoriesTemplate@2x.png");
const GLYPH_SKILLS: &[u8] = include_bytes!("../../icons/menu-icons/skillsTemplate@2x.png");
const GLYPH_MCP: &[u8] = include_bytes!("../../icons/menu-icons/mcpTemplate@2x.png");
const GLYPH_SETTINGS: &[u8] = include_bytes!("../../icons/menu-icons/settingsTemplate@2x.png");
const GLYPH_INFO: &[u8] = include_bytes!("../../icons/menu-icons/infoTemplate@2x.png");
const GLYPH_UNDO: &[u8] = include_bytes!("../../icons/menu-icons/undoTemplate@2x.png");
const GLYPH_REDO: &[u8] = include_bytes!("../../icons/menu-icons/redoTemplate@2x.png");
const GLYPH_CUT: &[u8] = include_bytes!("../../icons/menu-icons/cutTemplate@2x.png");
const GLYPH_COPY: &[u8] = include_bytes!("../../icons/menu-icons/copyTemplate@2x.png");
const GLYPH_PASTE: &[u8] = include_bytes!("../../icons/menu-icons/pasteTemplate@2x.png");
const GLYPH_SELECT_ALL: &[u8] = include_bytes!("../../icons/menu-icons/select-allTemplate@2x.png");

/// Decode an embedded menu glyph into a Tauri image, falling back to a single
/// transparent pixel if decoding ever fails so a bad asset can never drop the
/// whole application menu.
fn glyph(png: &'static [u8]) -> Image<'static> {
    Image::from_bytes(png).unwrap_or_else(|_| Image::new_owned(vec![0, 0, 0, 0], 1, 1))
}

/// Resolve a menu-item id to the renderer navigation target it stands for.
///
/// Pure and unit-testable; the ids mirror the `MenuNavTarget` union in
/// `menu.ts`. Two ids map to `settings` (the app-menu entry and the dedicated
/// Settings menu) because macOS shows both, exactly as the Electron menu did.
pub fn nav_target(id: &str) -> Option<&'static str> {
    match id {
        "nav.projects" => Some("projects"),
        "nav.repositories" => Some("repositories"),
        "nav.skills-components" => Some("skills-components"),
        "nav.skills-management" => Some("skills-management"),
        "nav.mcp-components" => Some("mcp-components"),
        "nav.mcp-management" => Some("mcp-management"),
        "nav.settings" | "nav.openSettings" => Some("settings"),
        _ => None,
    }
}

/// Resolve the i18n key for the Help menu's onboarding toggle label, given
/// whether onboarding is currently active.
///
/// Pure and unit-testable; kept separate from the `Translator` lookup so the
/// selection logic can be verified without building a menu or a translator.
fn onboarding_toggle_label_key(active: bool) -> &'static str {
    if active {
        "menu.onboarding.skip"
    } else {
        "menu.onboarding.start"
    }
}

/// Build the macOS application menu.
///
/// Order mirrors `menu.ts`: SkillKeeper, Edit, View, Settings, Window, Help.
/// Resolve the configured UI language code (e.g. "en", "de", "zh-cn") from the
/// saved config, defaulting to English when it cannot be read.
fn current_lang<R: Runtime>(app: &AppHandle<R>) -> String {
    use tauri::Manager;
    let Some(ctx) = app.try_state::<std::sync::Arc<crate::state::AppContext>>() else {
        return "en".to_string();
    };
    let loaded = skillkeeper_config::load_config(&ctx.fs, &ctx.paths.config_yaml);
    serde_json::to_value(loaded.config.general.language)
        .ok()
        .and_then(|v| v.as_str().map(str::to_string))
        .unwrap_or_else(|| "en".to_string())
}

/// Map an app UI language code to the BCP-47 code AppKit uses to localize the
/// standard menus -- including the window-tiling group it injects into the
/// Window menu (Fill / Center / Move & Resize / Full Screen Tile / Remove Window
/// from Set). Codes that already match pass through unchanged.
#[cfg(target_os = "macos")]
fn macos_language_code(lang: &str) -> String {
    match lang {
        "zh-cn" => "zh-Hans".to_string(),
        "zh-tw" => "zh-Hant".to_string(),
        "sr-cyrl" => "sr-Cyrl".to_string(),
        "sr-latn" => "sr-Latn".to_string(),
        other => other.to_string(),
    }
}

/// Override the process UI language so AppKit localizes the standard menu items
/// it injects itself (the Window tiling group) to the app's configured language,
/// independent of the system language. Paired with the `CFBundleLocalizations`
/// declared in `Info.plist`, this makes `NSBundle`'s preferred localization the
/// chosen language so AppKit picks its matching strings.
///
/// Must run BEFORE the `NSApplication` is created (before the Tauri builder), as
/// AppKit resolves the language once at launch; a later change needs a relaunch.
/// No-op off macOS.
pub fn set_process_language(lang: &str) {
    #[cfg(target_os = "macos")]
    {
        use objc2::runtime::AnyObject;
        use objc2_foundation::{NSArray, NSString, NSUserDefaults};

        let value = NSString::from_str(&macos_language_code(lang));
        let langs = NSArray::from_retained_slice(&[value]);
        let key = NSString::from_str("AppleLanguages");
        let obj: &AnyObject = &langs;
        unsafe {
            let defaults = NSUserDefaults::standardUserDefaults();
            defaults.setObject_forKey(Some(obj), &key);
        }
    }
    #[cfg(not(target_os = "macos"))]
    let _ = lang;
}

pub fn build<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    // Translate the custom labels for the configured language. Predefined items
    // (undo/copy/quit/minimize/...) are localized by macOS itself.
    let tr = super::i18n::Translator::for_lang(&current_lang(app));
    let about = IconMenuItemBuilder::with_id("nav.about", tr.t("menu.about"))
        .icon(glyph(GLYPH_INFO))
        .build(app)?;
    let settings = IconMenuItemBuilder::with_id("nav.settings", tr.t("nav.settings"))
        .accelerator("CmdOrCtrl+,")
        .icon(glyph(GLYPH_SETTINGS))
        .build(app)?;

    // Custom, translated replacements for the predefined app/edit items. macOS
    // localizes predefined items from the bundle/OS locale, not our config
    // language, so we build our own and route them to the native selectors via
    // NSApp.sendAction (see handle_event) to preserve the responder-chain
    // behavior (copy/paste/undo in text fields, quit teardown, etc.).
    let hide = MenuItemBuilder::with_id("app.hide", tr.t("menu.hide"))
        .accelerator("CmdOrCtrl+H")
        .build(app)?;
    let hide_others = MenuItemBuilder::with_id("app.hideOthers", tr.t("menu.hideOthers"))
        .accelerator("CmdOrCtrl+Alt+H")
        .build(app)?;
    let show_all = MenuItemBuilder::with_id("app.showAll", tr.t("menu.showAll")).build(app)?;
    let quit = MenuItemBuilder::with_id("app.quit", tr.t("menu.quit"))
        .accelerator("CmdOrCtrl+Q")
        .build(app)?;
    let app_menu = SubmenuBuilder::new(app, tr.t("app.title"))
        .item(&about)
        .separator()
        .item(&settings)
        .separator()
        .services()
        .separator()
        .item(&hide)
        .item(&hide_others)
        .item(&show_all)
        .separator()
        .item(&quit)
        .build()?;

    let undo = IconMenuItemBuilder::with_id("edit.undo", tr.t("menu.undo"))
        .accelerator("CmdOrCtrl+Z")
        .icon(glyph(GLYPH_UNDO))
        .build(app)?;
    let redo = IconMenuItemBuilder::with_id("edit.redo", tr.t("menu.redo"))
        .accelerator("Shift+CmdOrCtrl+Z")
        .icon(glyph(GLYPH_REDO))
        .build(app)?;
    let cut = IconMenuItemBuilder::with_id("edit.cut", tr.t("menu.cut"))
        .accelerator("CmdOrCtrl+X")
        .icon(glyph(GLYPH_CUT))
        .build(app)?;
    let copy = IconMenuItemBuilder::with_id("edit.copy", tr.t("menu.copy"))
        .accelerator("CmdOrCtrl+C")
        .icon(glyph(GLYPH_COPY))
        .build(app)?;
    let paste = IconMenuItemBuilder::with_id("edit.paste", tr.t("menu.paste"))
        .accelerator("CmdOrCtrl+V")
        .icon(glyph(GLYPH_PASTE))
        .build(app)?;
    let select_all = IconMenuItemBuilder::with_id("edit.selectAll", tr.t("menu.selectAll"))
        .accelerator("CmdOrCtrl+A")
        .icon(glyph(GLYPH_SELECT_ALL))
        .build(app)?;
    let edit_menu = SubmenuBuilder::new(app, tr.t("menu.edit"))
        .item(&undo)
        .item(&redo)
        .separator()
        .item(&cut)
        .item(&copy)
        .item(&paste)
        .item(&select_all)
        .build()?;

    let skills_menu = SubmenuBuilder::new(app, tr.t("nav.skills"))
        .submenu_icon(glyph(GLYPH_SKILLS))
        .text("nav.skills-components", tr.t("skills.componentsTitle"))
        .text("nav.skills-management", tr.t("skills.managementTitle"))
        .build()?;
    let mcp_menu = SubmenuBuilder::new(app, tr.t("nav.mcp"))
        .submenu_icon(glyph(GLYPH_MCP))
        .text("nav.mcp-components", tr.t("mcp.componentsTitle"))
        .text("nav.mcp-management", tr.t("mcp.managementTitle"))
        .build()?;
    let view_menu = SubmenuBuilder::new(app, tr.t("menu.view"))
        .icon("nav.projects", tr.t("nav.projects"), glyph(GLYPH_PROJECTS))
        .icon(
            "nav.repositories",
            tr.t("nav.repositories"),
            glyph(GLYPH_REPOSITORIES),
        )
        .item(&skills_menu)
        .item(&mcp_menu)
        .build()?;

    let open_settings = IconMenuItemBuilder::with_id("nav.openSettings", tr.t("menu.openSettings"))
        .icon(glyph(GLYPH_SETTINGS))
        .build(app)?;
    let settings_menu = SubmenuBuilder::new(app, tr.t("nav.settings"))
        .item(&open_settings)
        .build()?;

    let minimize = MenuItemBuilder::with_id("window.minimize", tr.t("menu.minimize"))
        .accelerator("CmdOrCtrl+M")
        .build(app)?;
    let zoom = MenuItemBuilder::with_id("window.zoom", tr.t("menu.zoom")).build(app)?;
    let close_window = MenuItemBuilder::with_id("window.close", tr.t("menu.close"))
        .accelerator("CmdOrCtrl+W")
        .build(app)?;
    let window_menu = SubmenuBuilder::with_id(app, WINDOW_SUBMENU_ID, tr.t("menu.window"))
        .item(&minimize)
        .item(&zoom)
        .separator()
        .item(&close_window)
        .build()?;

    // The Help menu's onboarding toggle starts labeled for the current
    // onboarding mode (read via the desktop `AppContext` state, defaulting to
    // "start" if the state is unavailable at menu-build time).
    let onboarding_active = {
        use tauri::Manager;
        app.try_state::<std::sync::Arc<crate::state::AppContext>>()
            .map(|ctx| !crate::commands::onboarding::load(&ctx).completed)
            .unwrap_or(false)
    };
    let onboarding_label = tr.t(onboarding_toggle_label_key(onboarding_active));
    let onboarding_item =
        MenuItemBuilder::with_id("onboarding.toggle", onboarding_label).build(app)?;
    let help_menu = SubmenuBuilder::with_id(app, HELP_SUBMENU_ID, tr.t("menu.help"))
        .item(&onboarding_item)
        .build()?;

    MenuBuilder::new(app)
        .item(&app_menu)
        .item(&edit_menu)
        .item(&view_menu)
        .item(&settings_menu)
        .item(&window_menu)
        .item(&help_menu)
        .build()
}

/// Handle a menu click: emit `menu:about` for the About item and
/// `menu:navigate` (with the resolved view target) for a navigation item.
pub fn handle_event<R: Runtime>(app: &AppHandle<R>, id: &str) {
    // Quit runs our own fast teardown + process::exit. Cmd+Q and the Quit menu
    // item both reach here, and routing app.quit to the native `terminate:`
    // selector drags the app through a ~11s AppKit/WebKit unwind (the
    // applicationShouldTerminate override only catches terminate: paths that do
    // NOT come back through this handler, e.g. Dock > Quit). See `app::quit`.
    if id == "app.quit" {
        super::quit(app);
    }
    // The other custom, translated Edit/App/Window items route to the native
    // macOS selectors so copy/paste/undo/minimize behave exactly like the
    // predefined items they replaced.
    #[cfg(target_os = "macos")]
    if id.starts_with("edit.") || id.starts_with("app.") || id.starts_with("window.") {
        send_native_menu_action(id);
        return;
    }
    if id == "nav.about" {
        let _ = app.emit("menu:about", ());
    } else if id == "onboarding.toggle" {
        let _ = app.emit("menu:onboarding-toggle", ());
    } else if let Some(target) = nav_target(id) {
        let _ = app.emit("menu:navigate", target);
    }
}

/// Dispatch a custom Edit/App/Window menu item to its native macOS action via
/// the responder chain (`NSApplication.sendAction:to:from:` with `to = nil`),
/// exactly as the predefined menu items do. Preserves editing behavior in text
/// fields and the standard app/window commands.
#[cfg(target_os = "macos")]
fn send_native_menu_action(id: &str) {
    use objc2::sel;
    use objc2_app_kit::NSApplication;
    use objc2_foundation::MainThreadMarker;

    let selector = match id {
        "edit.undo" => sel!(undo:),
        "edit.redo" => sel!(redo:),
        "edit.cut" => sel!(cut:),
        "edit.copy" => sel!(copy:),
        "edit.paste" => sel!(paste:),
        "edit.selectAll" => sel!(selectAll:),
        "app.hide" => sel!(hide:),
        "app.hideOthers" => sel!(hideOtherApplications:),
        "app.showAll" => sel!(unhideAllApplications:),
        "app.quit" => sel!(terminate:),
        "window.minimize" => sel!(performMiniaturize:),
        "window.zoom" => sel!(performZoom:),
        "window.close" => sel!(performClose:),
        _ => return,
    };
    let Some(mtm) = MainThreadMarker::new() else {
        return;
    };
    let ns_app = NSApplication::sharedApplication(mtm);
    unsafe {
        ns_app.sendAction_to_from(selector, None, None);
    }
}

/// Recursively search a menu tree for the item with the given id.
///
/// `Menu::get`/`Submenu::get` only search their own direct children, but
/// every id we care about (`nav.*`, `edit.*`, `app.*`, `window.*`,
/// `onboarding.toggle`) lives one level down inside a submenu, so the top
/// level alone is never enough.
#[cfg(target_os = "macos")]
fn find_menu_item<R: Runtime>(
    items: &[tauri::menu::MenuItemKind<R>],
    id: &str,
) -> Option<tauri::menu::MenuItemKind<R>> {
    use tauri::menu::MenuItemKind;

    for item in items {
        if item.id().0 == id {
            return Some(item.clone());
        }
        if let MenuItemKind::Submenu(submenu) = item {
            if let Ok(children) = submenu.items() {
                if let Some(found) = find_menu_item(&children, id) {
                    return Some(found);
                }
            }
        }
    }
    None
}

/// Set the enabled state of a menu item regardless of its concrete kind. The
/// plain app/window items are `MenuItem`; the icon-decorated edit/nav items
/// (built with `IconMenuItemBuilder`) are `IconMenuItem`.
#[cfg(target_os = "macos")]
fn set_item_enabled<R: Runtime>(item: &tauri::menu::MenuItemKind<R>, enabled: bool) {
    use tauri::menu::MenuItemKind;

    match item {
        MenuItemKind::MenuItem(mi) => {
            let _ = mi.set_enabled(enabled);
        }
        MenuItemKind::Icon(mi) => {
            let _ = mi.set_enabled(enabled);
        }
        MenuItemKind::Submenu(mi) => {
            let _ = mi.set_enabled(enabled);
        }
        MenuItemKind::Check(mi) => {
            let _ = mi.set_enabled(enabled);
        }
        MenuItemKind::Predefined(_) => {}
    }
}

/// Reflect onboarding mode in the macOS app menu: relabel the Help submenu's
/// onboarding toggle and lock every other item (except Quit and the toggle
/// itself) while onboarding is active, re-enabling all of them once it ends.
#[cfg(target_os = "macos")]
pub fn sync_onboarding<R: Runtime>(app: &AppHandle<R>, active: bool) {
    use tauri::menu::MenuItemKind;

    let Some(menu) = app.menu() else {
        return;
    };
    let Ok(items) = menu.items() else {
        return;
    };

    let tr = super::i18n::Translator::for_lang(&current_lang(app));
    if let Some(MenuItemKind::MenuItem(toggle)) = find_menu_item(&items, "onboarding.toggle") {
        let label = tr.t(onboarding_toggle_label_key(active));
        let _ = toggle.set_text(label);
        let _ = toggle.set_enabled(true);
    }

    const LOCKABLE: &[&str] = &[
        "nav.about",
        "nav.projects",
        "nav.repositories",
        "nav.skills-components",
        "nav.skills-management",
        "nav.mcp-components",
        "nav.mcp-management",
        "nav.settings",
        "nav.openSettings",
        "edit.undo",
        "edit.redo",
        "edit.cut",
        "edit.copy",
        "edit.paste",
        "edit.selectAll",
        "app.hide",
        "app.hideOthers",
        "app.showAll",
        "window.minimize",
        "window.zoom",
        "window.close",
    ];
    for id in LOCKABLE {
        if let Some(item) = find_menu_item(&items, id) {
            set_item_enabled(&item, !active);
        }
    }
}

/// Install the application menu (macOS only) and wire its click handler.
///
/// No-op on other platforms, where no application menu is shown.
pub fn install<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    if cfg!(target_os = "macos") {
        let menu = build(app)?;
        app.set_menu(menu)?;
        // muda attaches the glyphs but does not flag them as macOS template
        // images, so they render as literal black masks instead of tinting to
        // the menu appearance. Mark every menu-item image as a template so the
        // system tints it (light glyphs in a dark menu, dark in a light menu).
        #[cfg(target_os = "macos")]
        mark_menu_images_as_template();
        let handle = app.clone();
        app.on_menu_event(move |_app, event| {
            handle_event(&handle, event.id().0.as_str());
        });
    }
    Ok(())
}

/// Walk the live application menu and flag each item image as a macOS template
/// image (tinted by the system from its alpha). Works around `muda` not calling
/// `NSImage.setTemplate:` when it attaches per-item images.
#[cfg(target_os = "macos")]
fn mark_menu_images_as_template() {
    use objc2_app_kit::{NSApplication, NSMenu};
    use objc2_foundation::MainThreadMarker;

    let Some(mtm) = MainThreadMarker::new() else {
        return;
    };
    let app = NSApplication::sharedApplication(mtm);
    if let Some(menu) = app.mainMenu() {
        mark_menu(&menu);
    }

    fn mark_menu(menu: &NSMenu) {
        for item in menu.itemArray().iter() {
            if let Some(image) = item.image() {
                image.setTemplate(true);
            }
            if let Some(submenu) = item.submenu() {
                mark_menu(&submenu);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{nav_target, onboarding_toggle_label_key};

    #[test]
    fn resolves_every_navigation_id() {
        assert_eq!(nav_target("nav.projects"), Some("projects"));
        assert_eq!(nav_target("nav.repositories"), Some("repositories"));
        assert_eq!(
            nav_target("nav.skills-components"),
            Some("skills-components")
        );
        assert_eq!(
            nav_target("nav.skills-management"),
            Some("skills-management")
        );
        assert_eq!(nav_target("nav.mcp-components"), Some("mcp-components"));
        assert_eq!(nav_target("nav.mcp-management"), Some("mcp-management"));
    }

    #[test]
    fn both_settings_ids_map_to_settings() {
        assert_eq!(nav_target("nav.settings"), Some("settings"));
        assert_eq!(nav_target("nav.openSettings"), Some("settings"));
    }

    #[test]
    fn about_and_unknown_ids_are_not_navigation() {
        assert_eq!(nav_target("nav.about"), None);
        assert_eq!(nav_target("undo"), None);
        assert_eq!(nav_target(""), None);
    }

    #[test]
    fn onboarding_toggle_label_key_reflects_the_active_flag() {
        assert_eq!(onboarding_toggle_label_key(true), "menu.onboarding.skip");
        assert_eq!(onboarding_toggle_label_key(false), "menu.onboarding.start");
    }
}
