//! Config commands.
//!
//! Channel mapping: `config:get` -> `config_get`, `config:set` -> `config_set`.
//! Both return the same JSON shape the Electron handlers returned
//! (`LoadConfigResult`: `{ config, validity, warnings }`, with `validity` a
//! record of section name -> `"valid" | "invalid"`).

use serde_json::Value;
use tauri::State;

use skillkeeper_config::{
    load_config, save_config, LoadConfigResult, SkillKeeperConfig, Validity, SECTIONS,
};

use std::sync::Arc;

use super::blocking;
use crate::state::AppContext;

/// Load the config file, its per-section validity, and any warnings.
///
/// Never fails: a missing or unreadable file degrades to defaults.
pub fn load(ctx: &AppContext) -> LoadConfigResult {
    load_config(&ctx.fs, &ctx.paths.config_yaml)
}

/// Persist `config` then return the reloaded result.
///
/// # Errors
///
/// Returns a message when the write fails.
pub fn save(ctx: &AppContext, config: &SkillKeeperConfig) -> Result<LoadConfigResult, String> {
    save_config(&ctx.fs, &ctx.paths.config_yaml, config).map_err(|e| e.to_string())?;
    Ok(load(ctx))
}

/// Render a [`LoadConfigResult`] into the JSON shape the renderer expects.
///
/// Shared with the config watcher so an external-edit `config:changed` event
/// carries exactly the same `{ config, validity, warnings }` payload as
/// `config:get`.
pub(crate) fn to_dto(result: &LoadConfigResult) -> Result<Value, String> {
    let mut validity = serde_json::Map::new();
    for section in SECTIONS {
        let flag = match result.validity.get(section) {
            Validity::Valid => "valid",
            Validity::Invalid => "invalid",
        };
        validity.insert(
            section.as_str().to_string(),
            Value::String(flag.to_string()),
        );
    }

    let mut obj = serde_json::Map::new();
    obj.insert(
        "config".to_string(),
        serde_json::to_value(&result.config).map_err(|e| e.to_string())?,
    );
    obj.insert("validity".to_string(), Value::Object(validity));
    obj.insert(
        "warnings".to_string(),
        serde_json::to_value(&result.warnings).map_err(|e| e.to_string())?,
    );
    Ok(Value::Object(obj))
}

/// `config:get` -- load config with validity and warnings.
#[tauri::command]
pub async fn config_get(ctx: State<'_, Arc<AppContext>>) -> Result<Value, String> {
    blocking(&ctx, |c| to_dto(&load(c))).await?
}

/// `config:set` -- persist the given config and return the reloaded result.
///
/// Re-baselines the config watcher to the just-written file so the self-write is
/// not echoed back to the renderer as an external `config:changed` event, and
/// re-applies the native window theme so an in-app theme switch updates the
/// window background/source immediately (mirrors the Electron `rememberTheme`).
#[tauri::command]
pub async fn config_set(
    ctx: State<'_, Arc<AppContext>>,
    window: tauri::WebviewWindow,
    config: SkillKeeperConfig,
) -> Result<Value, String> {
    // The write runs off the async workers; the theme apply must stay on the
    // caller (it drives the `window`, which is not `Send`).
    let result = blocking(&ctx, move |c| {
        let saved = save(c, &config)?;
        c.config_watcher.note_written(&c.fs);
        Ok::<_, String>(saved)
    })
    .await??;
    crate::app::theme::apply(&window, result.config.general.theme);
    to_dto(&result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::test_support::TempAppData;
    use skillkeeper_config::{default_config, Theme};

    #[test]
    fn get_on_missing_file_returns_defaults() {
        let app = TempAppData::new();
        let result = load(&app.ctx);
        assert_eq!(result.config, default_config());
        assert!(result.validity.all(Validity::Valid));
        assert!(result.warnings.is_empty());
    }

    #[test]
    fn set_then_get_round_trips() {
        let app = TempAppData::new();
        let mut config = default_config();
        config.general.theme = Theme::Dark;
        config.repositories.git_path = "/usr/local/bin/git".to_string();

        let saved = save(&app.ctx, &config).unwrap();
        assert_eq!(saved.config, config);

        let reloaded = load(&app.ctx);
        assert_eq!(reloaded.config.general.theme, Theme::Dark);
        assert_eq!(reloaded.config.repositories.git_path, "/usr/local/bin/git");
    }

    #[test]
    fn dto_mirrors_the_load_config_result_shape() {
        let app = TempAppData::new();
        let dto = to_dto(&load(&app.ctx)).unwrap();

        assert!(dto.get("config").unwrap().is_object());
        assert!(dto.get("warnings").unwrap().is_array());

        let validity = dto.get("validity").unwrap().as_object().unwrap();
        assert_eq!(validity.len(), SECTIONS.len());
        assert_eq!(validity.get("general").unwrap(), "valid");
        assert_eq!(validity.get("mcp").unwrap(), "valid");
    }
}
