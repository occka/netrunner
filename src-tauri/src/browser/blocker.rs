//! Content blocking for BROWSER tabs and web overlays, built on Brave's
//! `adblock` engine (EasyList / uBlock Origin filter syntax).
//!
//! A small built-in list works from the first start. The standard lists are
//! downloaded only when the user enables them (or on the periodic refresh
//! while enabled) and cached under `<data>/adblock/`. Matching runs inside the
//! WebView2 `WebResourceRequested` handler, so blocked requests never leave
//! the machine.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::{Arc, RwLock};
use std::time::{Duration, SystemTime};

use adblock::lists::{FilterSet, ParseOptions};
use adblock::request::Request;
use adblock::Engine;
use serde::Serialize;

use crate::error::{AppError, AppResult};

pub struct FilterList {
    pub id: &'static str,
    pub name: &'static str,
    pub url: &'static str,
    pub purpose: &'static str,
    pub default_on: bool,
}

/// Lists the user can enable. Sizes are approximate, for the UI.
pub const LISTS: &[FilterList] = &[
    FilterList { id: "easylist", name: "EasyList", url: "https://easylist.to/easylist/easylist.txt", purpose: "Ads (international)", default_on: true },
    FilterList { id: "easyprivacy", name: "EasyPrivacy", url: "https://easylist.to/easylist/easyprivacy.txt", purpose: "Trackers and analytics", default_on: true },
    FilterList { id: "ublock", name: "uBlock filters", url: "https://ublockorigin.github.io/uAssets/filters/filters.txt", purpose: "Ads and pop-ups missed by EasyList", default_on: true },
    FilterList { id: "ublock-privacy", name: "uBlock privacy", url: "https://ublockorigin.github.io/uAssets/filters/privacy.txt", purpose: "Extra trackers, link tracking", default_on: true },
    FilterList { id: "ublock-badware", name: "uBlock badware risks", url: "https://ublockorigin.github.io/uAssets/filters/badware.txt", purpose: "Scam, fake-download and malware sites", default_on: true },
    FilterList {
        id: "peterlowe",
        name: "Peter Lowe's list",
        url: "https://pgl.yoyo.org/adservers/serverlist.php?hostformat=adblockplus&showintro=0&mimetype=plaintext",
        purpose: "Ad and tracking servers",
        default_on: true,
    },
    FilterList { id: "ruadlist", name: "RU AdList", url: "https://easylist-downloads.adblockplus.org/advblock.txt", purpose: "Ads on Russian-language sites", default_on: true },
    FilterList { id: "cookies", name: "EasyList Cookie", url: "https://secure.fanboy.co.nz/fanboy-cookiemonster.txt", purpose: "Cookie consent banners", default_on: false },
    FilterList {
        id: "urlhaus",
        name: "URLhaus malicious URLs",
        url: "https://malware-filter.gitlab.io/malware-filter/urlhaus-filter-online.txt",
        purpose: "Active malware distribution URLs (~12 MB, slower to load)",
        default_on: false,
    },
];

/// Works before any list has been downloaded: the largest ad and tracking
/// networks, including Russian ones.
const BUILTIN: &str = include_str!("builtin_filters.txt");

/// Lists are refreshed in the background when older than this.
pub const REFRESH_AFTER: Duration = Duration::from_secs(4 * 24 * 3600);

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ListStatus {
    pub id: String,
    pub name: String,
    pub purpose: String,
    pub url: String,
    pub enabled: bool,
    pub downloaded: bool,
    pub updated_at: Option<u64>,
    pub size_bytes: u64,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BlockerStatus {
    pub ready: bool,
    pub rules: usize,
    pub building: bool,
    pub last_error: Option<String>,
}

/// Verdict for one request.
pub struct Verdict {
    pub block: bool,
    #[cfg_attr(not(test), allow(dead_code))]
    pub third_party: bool,
}

pub struct Blocker {
    dir: PathBuf,
    engine: RwLock<Option<Arc<Engine>>>,
    status: RwLock<BlockerStatus>,
}

impl Blocker {
    pub fn new(data_dir: &Path) -> Self {
        Self { dir: data_dir.join("adblock"), engine: RwLock::new(None), status: RwLock::new(BlockerStatus::default()) }
    }

    pub fn status(&self) -> BlockerStatus {
        self.status.read().map(|s| s.clone()).unwrap_or_default()
    }

    fn list_path(&self, id: &str) -> PathBuf {
        self.dir.join(format!("{id}.txt"))
    }

    pub fn lists(&self, enabled: &[String]) -> Vec<ListStatus> {
        LISTS
            .iter()
            .map(|l| {
                let meta = std::fs::metadata(self.list_path(l.id)).ok();
                ListStatus {
                    id: l.id.into(),
                    name: l.name.into(),
                    purpose: l.purpose.into(),
                    url: l.url.into(),
                    enabled: enabled.iter().any(|e| e == l.id),
                    downloaded: meta.is_some(),
                    updated_at: meta
                        .as_ref()
                        .and_then(|m| m.modified().ok())
                        .and_then(|t| t.duration_since(SystemTime::UNIX_EPOCH).ok())
                        .map(|d| d.as_secs()),
                    size_bytes: meta.map(|m| m.len()).unwrap_or(0),
                }
            })
            .collect()
    }

    /// Enabled lists that are missing or older than [`REFRESH_AFTER`].
    pub fn stale(&self, enabled: &[String]) -> Vec<&'static FilterList> {
        LISTS
            .iter()
            .filter(|l| enabled.iter().any(|e| e == l.id))
            .filter(|l| {
                std::fs::metadata(self.list_path(l.id))
                    .and_then(|m| m.modified())
                    .ok()
                    .and_then(|t| t.elapsed().ok())
                    .map_or(true, |age| age > REFRESH_AFTER)
            })
            .collect()
    }

    /// Downloads the given lists. A failed download keeps the cached copy.
    pub async fn download(&self, lists: &[&FilterList]) -> Vec<(String, String)> {
        let mut errors = Vec::new();
        if let Err(e) = std::fs::create_dir_all(&self.dir) {
            errors.push(("all".into(), e.to_string()));
            return errors;
        }
        let client = match reqwest::Client::builder().timeout(Duration::from_secs(60)).user_agent("NETRUNNER filter updater").build() {
            Ok(c) => c,
            Err(e) => return vec![("all".into(), e.to_string())],
        };
        for list in lists {
            let result = async {
                let resp = client.get(list.url).send().await.map_err(|e| e.to_string())?;
                if !resp.status().is_success() {
                    return Err(format!("HTTP {}", resp.status()));
                }
                let body = resp.text().await.map_err(|e| e.to_string())?;
                // A filter list is plain text with rules; refuse HTML error pages.
                if body.len() < 200 || body.trim_start().starts_with('<') {
                    return Err("response is not a filter list".into());
                }
                let path = self.list_path(list.id);
                let tmp = path.with_extension("part");
                std::fs::write(&tmp, body).map_err(|e| e.to_string())?;
                std::fs::rename(&tmp, &path).map_err(|e| e.to_string())
            }
            .await;
            if let Err(e) = result {
                log::warn!("filter list {} not updated: {e}", list.id);
                errors.push((list.id.to_string(), e));
            }
        }
        errors
    }

    /// Builds a new engine from the built-in list and the enabled cached
    /// lists, then swaps it in. Runs on a worker thread; matching keeps using
    /// the previous engine until the new one is ready.
    pub fn rebuild(&self, enabled: &[String]) {
        if let Ok(mut s) = self.status.write() {
            s.building = true;
        }
        let mut set = FilterSet::new(false);
        let mut rules = count_rules(BUILTIN);
        set.add_filter_list(BUILTIN.to_string(), ParseOptions::default());
        for list in LISTS.iter().filter(|l| enabled.iter().any(|e| e == l.id)) {
            if let Ok(text) = std::fs::read_to_string(self.list_path(list.id)) {
                rules += count_rules(&text);
                set.add_filter_list(text, ParseOptions::default());
            }
        }
        let engine = Engine::new_with_filter_set(set);
        if let Ok(mut e) = self.engine.write() {
            *e = Some(Arc::new(engine));
        }
        if let Ok(mut s) = self.status.write() {
            *s = BlockerStatus { ready: true, rules, building: false, last_error: s.last_error.clone() };
        }
        log::info!("content blocker ready: {rules} rules");
    }

    pub fn set_error(&self, error: Option<String>) {
        if let Ok(mut s) = self.status.write() {
            s.last_error = error;
        }
    }

    fn engine(&self) -> Option<Arc<Engine>> {
        self.engine.read().ok().and_then(|e| e.clone())
    }

    /// `kind` is the request type in adblock terms ("script", "image", …).
    pub fn check(&self, url: &str, source_url: &str, kind: &str) -> Option<Verdict> {
        let request = Request::new(url, source_url, kind, "get").ok()?;
        let third_party = request.is_third_party;
        let engine = self.engine()?;
        let result = engine.check_network_request(&request);
        Some(Verdict { block: result.should_block(), third_party })
    }

    /// CSS that hides page elements matched by cosmetic filters for `url`.
    /// `classes` / `ids` come from the page so generic rules can be applied.
    pub fn cosmetic_css(&self, url: &str, classes: &[String], ids: &[String]) -> Option<String> {
        let engine = self.engine()?;
        let resources = engine.url_cosmetic_resources(url);
        let mut selectors: HashSet<String> = resources.hide_selectors;
        if !resources.generichide && (!classes.is_empty() || !ids.is_empty()) {
            selectors.extend(engine.hidden_class_id_selectors(classes, ids, &resources.exceptions));
        }
        if selectors.is_empty() {
            return None;
        }
        // One rule per selector: an invalid selector then only drops itself.
        let mut css = String::new();
        for s in selectors {
            if s.contains('{') || s.contains('}') || s.contains("</") {
                continue;
            }
            css.push_str(&s);
            css.push_str("{display:none!important}\n");
        }
        Some(css)
    }
}

/// Approximate rule count for the UI (comments and headers excluded).
fn count_rules(text: &str) -> usize {
    text.lines()
        .map(str::trim)
        .filter(|l| !l.is_empty() && !l.starts_with('!') && !l.starts_with('['))
        .count()
}

/// Maps a list id to its definition.
pub fn list_by_id(id: &str) -> AppResult<&'static FilterList> {
    LISTS.iter().find(|l| l.id == id).ok_or_else(|| AppError::Invalid(format!("unknown filter list {id}")))
}

pub fn default_lists() -> Vec<String> {
    LISTS.iter().filter(|l| l.default_on).map(|l| l.id.to_string()).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builtin_list_blocks_common_trackers() {
        let dir = std::env::temp_dir().join(format!("nr-adblock-{}", std::process::id()));
        let b = Blocker::new(&dir);
        b.rebuild(&[]);
        assert!(b.status().rules > 20);
        let v = b.check("https://securepubads.g.doubleclick.net/tag/js/gpt.js", "https://example.com/", "script").unwrap();
        assert!(v.block && v.third_party);
        let v = b.check("https://mc.yandex.ru/metrika/tag.js", "https://news.example.ru/", "script").unwrap();
        assert!(v.block);
        let v = b.check("https://example.com/app.js", "https://example.com/", "script").unwrap();
        assert!(!v.block && !v.third_party);
        // Cosmetic rules from the built-in list.
        let css = b.cosmetic_css("https://example.com/", &["adsbygoogle".into()], &[]).unwrap_or_default();
        assert!(css.contains("adsbygoogle"));
    }

    #[test]
    fn list_registry_is_consistent() {
        let ids: HashSet<_> = LISTS.iter().map(|l| l.id).collect();
        assert_eq!(ids.len(), LISTS.len());
        assert!(LISTS.iter().all(|l| l.url.starts_with("https://")));
        assert!(list_by_id("easylist").is_ok() && list_by_id("nope").is_err());
    }
}
