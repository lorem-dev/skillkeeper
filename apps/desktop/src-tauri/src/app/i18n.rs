//! Menu localization from the shared gettext catalogs.
//!
//! The compiled `.mo` files under `src-tauri/locales/` are generated from the
//! single-source `locales/*.po` by `scripts/gen-i18n.mjs` (the same `.po` the
//! renderer's TS catalogs come from). Keyed msgids: a key missing from a target
//! language falls back to the English catalog. Embedded via `include_bytes!` so
//! no runtime resource lookup is needed.

use gettext::Catalog;

macro_rules! mo {
    ($lang:literal) => {
        include_bytes!(concat!("../../locales/", $lang, ".mo")) as &[u8]
    };
}

/// Embedded compiled catalog bytes for a language code, or `None` if unknown.
fn catalog_bytes(lang: &str) -> Option<&'static [u8]> {
    Some(match lang {
        "en" => mo!("en"),
        "de" => mo!("de"),
        "ru" => mo!("ru"),
        "uk" => mo!("uk"),
        "be" => mo!("be"),
        "fr" => mo!("fr"),
        "ja" => mo!("ja"),
        "zh-cn" => mo!("zh-cn"),
        "pl" => mo!("pl"),
        "sr-cyrl" => mo!("sr-cyrl"),
        "sr-latn" => mo!("sr-latn"),
        "zh-tw" => mo!("zh-tw"),
        "es" => mo!("es"),
        "pt" => mo!("pt"),
        "ko" => mo!("ko"),
        "it" => mo!("it"),
        _ => return None,
    })
}

fn parse_en() -> Catalog {
    Catalog::parse(catalog_bytes("en").expect("en.mo embedded")).expect("en.mo parses")
}

/// A key-based translator over a target language with English fallback.
pub struct Translator {
    target: Catalog,
    en: Catalog,
}

impl Translator {
    /// Build a translator for the given language code (falls back to English for
    /// an unknown or unparseable catalog).
    pub fn for_lang(lang: &str) -> Self {
        let target = match catalog_bytes(lang).and_then(|b| Catalog::parse(b).ok()) {
            Some(cat) => cat,
            None => parse_en(),
        };
        Self {
            target,
            en: parse_en(),
        }
    }

    /// Translate a message key. Falls back to English when the target language
    /// lacks the key (gettext returns the msgid unchanged for a miss).
    pub fn t(&self, key: &str) -> String {
        let translated = self.target.gettext(key);
        if translated == key {
            self.en.gettext(key).to_string()
        } else {
            translated.to_string()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn english_returns_source_values() {
        let tr = Translator::for_lang("en");
        assert_eq!(tr.t("menu.view"), "View");
        assert_eq!(tr.t("nav.repositories"), "Repositories");
    }

    #[test]
    fn unknown_language_falls_back_to_english() {
        let tr = Translator::for_lang("xx-unknown");
        assert_eq!(tr.t("menu.edit"), "Edit");
    }

    #[test]
    fn translated_language_differs_and_missing_falls_back() {
        let tr = Translator::for_lang("de");
        // A menu key the German catalog translates.
        assert_ne!(tr.t("menu.view"), "View");
        // An unknown key returns itself (no catalog entry anywhere).
        assert_eq!(tr.t("no.such.key"), "no.such.key");
    }
}
