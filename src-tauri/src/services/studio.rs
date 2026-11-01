//! Widget Studio: custom widgets made from HTML/CSS or from a template.
//!
//! HTML widgets are rendered by the UI in a sandboxed frame without scripts,
//! so nothing here runs them. Feed widgets are fetched here, only from hosts
//! on the widget's own allowlist, and only plain text reaches the UI.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use rusqlite::{params, Connection, OptionalExtension, Row};
use serde::Serialize;
use serde_json::{json, Value};

use crate::error::{AppError, AppResult};

pub const KINDS: &[&str] = &["html", "text", "counter", "links", "feed"];
const MAX_WIDGETS: i64 = 64;
const MAX_CONFIG: usize = 160 * 1024;
const MAX_FEED_BYTES: usize = 2 * 1024 * 1024;
const MIN_REFRESH_MINUTES: u64 = 5;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CustomWidget {
    pub id: i64,
    pub profile_id: Option<i64>,
    pub name: String,
    pub kind: String,
    pub config: Value,
    pub updated_at: String,
}

const SELECT: &str = "SELECT id, profile_id, name, kind, config_json, updated_at FROM custom_widgets";

fn row(r: &Row) -> rusqlite::Result<CustomWidget> {
    Ok(CustomWidget {
        id: r.get(0)?,
        profile_id: r.get(1)?,
        name: r.get(2)?,
        kind: r.get(3)?,
        config: serde_json::from_str(&r.get::<_, String>(4)?).unwrap_or_else(|_| json!({})),
        updated_at: r.get(5)?,
    })
}

pub fn list(conn: &Connection) -> AppResult<Vec<CustomWidget>> {
    let mut stmt = conn.prepare(&format!("{SELECT} ORDER BY name COLLATE NOCASE, id"))?;
    let rows = stmt.query_map([], row)?;
    Ok(rows.collect::<Result<_, _>>()?)
}

pub fn get(conn: &Connection, id: i64) -> AppResult<CustomWidget> {
    conn.query_row(&format!("{SELECT} WHERE id = ?1"), [id], row)
        .optional()?
        .ok_or_else(|| AppError::NotFound("this custom widget no longer exists".into()))
}

/// Starting content for each kind, so a new widget shows something at once.
fn template(kind: &str) -> Value {
    match kind {
        "html" => json!({
            "html": "<div class=\"card\">\n  <h1>HELLO, RUNNER</h1>\n  <p>Edit HTML and CSS in Widget Studio.</p>\n</div>",
            "css": ".card {\n  padding: 12px;\n  border: 1px solid var(--c-primary);\n  color: var(--c-text);\n}\nh1 {\n  margin: 0 0 6px;\n  font: 600 18px var(--font-display);\n  color: var(--c-primary);\n  letter-spacing: 0.12em;\n}"
        }),
        "text" => json!({ "text": "Your text here", "size": 18, "align": "left" }),
        "counter" => json!({ "label": "Counter", "value": 0, "step": 1 }),
        "links" => json!({ "links": [{ "title": "GitHub", "url": "https://github.com" }] }),
        _ => json!({ "url": "", "format": "rss", "allow": [], "limit": 10, "refresh": 30, "itemsPath": "", "titleField": "title", "linkField": "url", "dateField": "" }),
    }
}

fn name(s: &str) -> AppResult<String> {
    let s = s.trim();
    if s.is_empty() || s.chars().count() > 40 {
        return Err(AppError::Invalid("widget name must be 1–40 characters".into()));
    }
    Ok(s.to_string())
}

fn http_url(s: &str) -> AppResult<url::Url> {
    let u = url::Url::parse(s.trim()).map_err(|_| AppError::Invalid(format!("'{s}' is not a full http(s) address")))?;
    if !matches!(u.scheme(), "http" | "https") || u.host_str().is_none() {
        return Err(AppError::Invalid(format!("'{s}' is not an http(s) address")));
    }
    Ok(u)
}

/// A host on the allowlist matches itself and its subdomains.
pub fn host_allowed(host: &str, allow: &[String]) -> bool {
    let host = host.to_ascii_lowercase();
    allow.iter().any(|a| {
        let a = a.trim().trim_start_matches("*.").to_ascii_lowercase();
        !a.is_empty() && (host == a || host.ends_with(&format!(".{a}")))
    })
}

fn allow_list(config: &Value) -> Vec<String> {
    config["allow"].as_array().map(|a| a.iter().filter_map(|v| v.as_str().map(str::to_string)).collect()).unwrap_or_default()
}

/// Checks a config against its kind; the UI owns the details of rendering.
pub fn validate(kind: &str, config: &Value) -> AppResult<()> {
    if !config.is_object() || serde_json::to_string(config)?.len() > MAX_CONFIG {
        return Err(AppError::Invalid("widget content is too large (160 KB at most)".into()));
    }
    match kind {
        "links" => {
            let links = config["links"].as_array().cloned().unwrap_or_default();
            if links.len() > 48 {
                return Err(AppError::Invalid("at most 48 links".into()));
            }
            for l in &links {
                http_url(l["url"].as_str().unwrap_or(""))?;
            }
        }
        "feed" => {
            let url = config["url"].as_str().unwrap_or("").trim();
            let allow = allow_list(config);
            if allow.len() > 16 || allow.iter().any(|h| h.len() > 253 || h.contains('/') || h.contains(':')) {
                return Err(AppError::Invalid("the allowlist takes up to 16 host names (example.com)".into()));
            }
            if !url.is_empty() {
                let u = http_url(url)?;
                if !host_allowed(u.host_str().unwrap_or(""), &allow) {
                    return Err(AppError::Invalid(format!(
                        "add {} to the allowlist before using this feed",
                        u.host_str().unwrap_or("its host")
                    )));
                }
            }
        }
        _ => {}
    }
    Ok(())
}

pub fn create(conn: &Connection, kind: &str, widget_name: &str, profile_id: Option<i64>) -> AppResult<CustomWidget> {
    if !KINDS.contains(&kind) {
        return Err(AppError::Invalid("unknown widget kind".into()));
    }
    let count: i64 = conn.query_row("SELECT COUNT(*) FROM custom_widgets", [], |r| r.get(0))?;
    if count >= MAX_WIDGETS {
        return Err(AppError::Invalid(format!("at most {MAX_WIDGETS} custom widgets are supported")));
    }
    conn.execute(
        "INSERT INTO custom_widgets (profile_id, name, kind, config_json) VALUES (?1, ?2, ?3, ?4)",
        params![profile_id, name(widget_name)?, kind, serde_json::to_string(&template(kind))?],
    )?;
    get(conn, conn.last_insert_rowid())
}

pub fn update(conn: &Connection, id: i64, widget_name: &str, config: &Value) -> AppResult<CustomWidget> {
    let w = get(conn, id)?;
    validate(&w.kind, config)?;
    conn.execute(
        "UPDATE custom_widgets SET name = ?1, config_json = ?2, updated_at = datetime('now') WHERE id = ?3",
        params![name(widget_name)?, serde_json::to_string(config)?, id],
    )?;
    forget_feed(id);
    get(conn, id)
}

pub fn set_profile(conn: &Connection, id: i64, profile_id: Option<i64>) -> AppResult<CustomWidget> {
    if let Some(pid) = profile_id {
        crate::services::profiles::get(conn, pid)?;
    }
    get(conn, id)?;
    conn.execute("UPDATE custom_widgets SET profile_id = ?1 WHERE id = ?2", params![profile_id, id])?;
    get(conn, id)
}

/// Counter template: stores the new value.
pub fn set_counter(conn: &Connection, id: i64, value: i64) -> AppResult<CustomWidget> {
    let mut w = get(conn, id)?;
    if w.kind != "counter" {
        return Err(AppError::Invalid("not a counter".into()));
    }
    w.config["value"] = json!(value.clamp(-1_000_000_000, 1_000_000_000));
    conn.execute("UPDATE custom_widgets SET config_json = ?1 WHERE id = ?2", params![serde_json::to_string(&w.config)?, id])?;
    Ok(w)
}

pub fn delete(conn: &Connection, id: i64) -> AppResult<()> {
    conn.execute("DELETE FROM custom_widgets WHERE id = ?1", [id])?;
    forget_feed(id);
    Ok(())
}

// ---------- Feeds ----------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FeedItem {
    pub title: String,
    pub link: Option<String>,
    /// Unix ms, when the feed gives a date.
    pub date: Option<i64>,
    pub summary: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FeedResult {
    pub items: Vec<FeedItem>,
    /// Unix ms of the fetch these items came from.
    pub fetched_at: i64,
}

static CACHE: Mutex<Option<HashMap<i64, (Instant, FeedResult)>>> = Mutex::new(None);

fn forget_feed(id: i64) {
    if let Ok(mut c) = CACHE.lock() {
        if let Some(map) = c.as_mut() {
            map.remove(&id);
        }
    }
}

/// Plain text: tags removed, entities for the common characters decoded, whitespace collapsed.
pub fn plain_text(s: &str, max: usize) -> String {
    let mut out = String::with_capacity(s.len().min(max));
    let mut in_tag = false;
    for c in s.chars() {
        match c {
            '<' => in_tag = true,
            '>' if in_tag => {
                in_tag = false;
                out.push(' ');
            }
            _ if !in_tag => out.push(c),
            _ => {}
        }
    }
    let out = out
        .replace("&nbsp;", " ")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&amp;", "&");
    out.split_whitespace().collect::<Vec<_>>().join(" ").chars().take(max).collect()
}

/// Only http(s) links are passed on; anything else (javascript:, file:) is dropped.
fn safe_link(s: &str) -> Option<String> {
    http_url(s).ok().map(|u| u.to_string())
}

fn walk<'a>(v: &'a Value, path: &str) -> &'a Value {
    path.split('.').filter(|p| !p.is_empty()).fold(v, |cur, key| match key.parse::<usize>() {
        Ok(i) if cur.is_array() => &cur[i],
        _ => &cur[key],
    })
}

fn json_text(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Number(n) => n.to_string(),
        Value::Bool(b) => b.to_string(),
        _ => String::new(),
    }
}

fn parse_date(s: &str) -> Option<i64> {
    chrono::DateTime::parse_from_rfc3339(s.trim())
        .or_else(|_| chrono::DateTime::parse_from_rfc2822(s.trim()))
        .ok()
        .map(|d| d.timestamp_millis())
}

/// Items from a JSON API: `itemsPath` points at an array (empty = the root),
/// the field names pick title, link and date out of each element.
pub fn parse_json(body: &[u8], config: &Value, limit: usize) -> AppResult<Vec<FeedItem>> {
    let root: Value = serde_json::from_slice(body).map_err(|e| AppError::Invalid(format!("the response is not JSON: {e}")))?;
    let field = |k: &str, d: &str| config[k].as_str().filter(|s| !s.trim().is_empty()).unwrap_or(d).to_string();
    let items = walk(&root, config["itemsPath"].as_str().unwrap_or(""))
        .as_array()
        .ok_or_else(|| AppError::Invalid("the items path does not point at a list".into()))?;
    let (tf, lf, df) = (field("titleField", "title"), field("linkField", "url"), field("dateField", ""));
    Ok(items
        .iter()
        .take(limit)
        .map(|it| FeedItem {
            title: plain_text(&json_text(walk(it, &tf)), 300),
            link: safe_link(&json_text(walk(it, &lf))),
            date: if df.is_empty() { None } else { parse_date(&json_text(walk(it, &df))) },
            summary: String::new(),
        })
        .filter(|i| !i.title.is_empty())
        .collect())
}

/// RSS, Atom or JSON Feed.
pub fn parse_feed(body: &[u8], limit: usize) -> AppResult<Vec<FeedItem>> {
    let feed = feed_rs::parser::parse(body).map_err(|e| AppError::Invalid(format!("not a valid RSS/Atom feed: {e}")))?;
    Ok(feed
        .entries
        .into_iter()
        .take(limit)
        .map(|e| FeedItem {
            title: plain_text(&e.title.map(|t| t.content).unwrap_or_default(), 300),
            link: e.links.iter().find_map(|l| safe_link(&l.href)),
            date: e.published.or(e.updated).map(|d| d.timestamp_millis()),
            summary: plain_text(&e.summary.map(|t| t.content).unwrap_or_default(), 400),
        })
        .filter(|i| !i.title.is_empty())
        .collect())
}

/// Fetches a feed widget's items. The address and allowlist are read from the
/// stored widget, never from the UI; redirects must stay on allowed hosts.
pub async fn feed(w: &CustomWidget, force: bool) -> AppResult<FeedResult> {
    if w.kind != "feed" {
        return Err(AppError::Invalid("not a feed widget".into()));
    }
    let refresh = w.config["refresh"].as_u64().unwrap_or(30).max(MIN_REFRESH_MINUTES);
    if let Ok(c) = CACHE.lock() {
        if let Some((at, r)) = c.as_ref().and_then(|m| m.get(&w.id)) {
            // Even a forced refresh waits a minute, so a feed is never hammered.
            let min_age = if force { Duration::from_secs(60) } else { Duration::from_secs(refresh * 60) };
            if at.elapsed() < min_age {
                return Ok(r.clone());
            }
        }
    }
    let url = w.config["url"].as_str().unwrap_or("").trim().to_string();
    if url.is_empty() {
        return Err(AppError::Invalid("set the feed address in Widget Studio".into()));
    }
    let allow = allow_list(&w.config);
    let parsed = http_url(&url)?;
    if !host_allowed(parsed.host_str().unwrap_or(""), &allow) {
        return Err(AppError::Invalid("the feed's host is not on this widget's allowlist".into()));
    }
    let policy_allow = allow.clone();
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .user_agent(concat!("NETRUNNER/", env!("CARGO_PKG_VERSION"), " (feed widget)"))
        .redirect(reqwest::redirect::Policy::custom(move |attempt| {
            let ok = attempt.previous().len() < 5
                && matches!(attempt.url().scheme(), "http" | "https")
                && host_allowed(attempt.url().host_str().unwrap_or(""), &policy_allow);
            if ok {
                attempt.follow()
            } else {
                attempt.error("redirect to a host that is not on the allowlist")
            }
        }))
        .build()
        .map_err(|e| AppError::Internal(e.to_string()))?;
    let mut resp = client.get(parsed).send().await.map_err(|e| AppError::Internal(format!("feed request failed: {e}")))?;
    if !resp.status().is_success() {
        return Err(AppError::Internal(format!("the feed answered HTTP {}", resp.status().as_u16())));
    }
    let mut body = Vec::new();
    while let Some(chunk) = resp.chunk().await.map_err(|e| AppError::Internal(e.to_string()))? {
        body.extend_from_slice(&chunk);
        if body.len() > MAX_FEED_BYTES {
            return Err(AppError::Invalid("the feed is larger than 2 MB".into()));
        }
    }
    let limit = w.config["limit"].as_u64().unwrap_or(10).clamp(1, 50) as usize;
    let items = if w.config["format"].as_str() == Some("json") { parse_json(&body, &w.config, limit)? } else { parse_feed(&body, limit)? };
    let result = FeedResult { items, fetched_at: crate::services::alarms::now_ms() };
    if let Ok(mut c) = CACHE.lock() {
        c.get_or_insert_with(HashMap::new).insert(w.id, (Instant::now(), result.clone()));
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::Database;

    #[test]
    fn crud_and_validation() {
        let db = Database::open_in_memory().unwrap();
        let conn = db.conn().unwrap();
        let w = create(&conn, "html", " Card ", None).unwrap();
        assert_eq!((w.name.as_str(), w.kind.as_str()), ("Card", "html"));
        assert!(w.config["html"].as_str().unwrap().contains("HELLO"));
        assert!(create(&conn, "script", "x", None).is_err());
        assert!(create(&conn, "text", "   ", None).is_err());

        let links = create(&conn, "links", "Links", None).unwrap();
        assert!(update(&conn, links.id, "Links", &json!({ "links": [{ "title": "x", "url": "javascript:alert(1)" }] })).is_err());
        assert!(update(&conn, links.id, "Links", &json!({ "links": [{ "title": "x", "url": "https://example.com" }] })).is_ok());

        let feed = create(&conn, "feed", "News", None).unwrap();
        let cfg = json!({ "url": "https://news.example.com/rss", "allow": [] });
        assert!(update(&conn, feed.id, "News", &cfg).is_err(), "host must be allowlisted");
        let cfg = json!({ "url": "https://news.example.com/rss", "allow": ["example.com"] });
        assert!(update(&conn, feed.id, "News", &cfg).is_ok());
        assert!(update(&conn, feed.id, "News", &json!({ "url": "file:///C:/x", "allow": ["example.com"] })).is_err());

        let c = create(&conn, "counter", "Count", None).unwrap();
        assert_eq!(set_counter(&conn, c.id, 7).unwrap().config["value"], 7);
        assert!(set_counter(&conn, w.id, 1).is_err());
        assert!(update(&conn, w.id, "Card", &json!({ "html": "x".repeat(MAX_CONFIG) })).is_err());
        delete(&conn, w.id).unwrap();
        assert!(get(&conn, w.id).is_err());
    }

    #[test]
    fn allowlist_matches_host_and_subdomains_only() {
        let allow = vec!["example.com".to_string(), "*.news.org".to_string()];
        assert!(host_allowed("example.com", &allow));
        assert!(host_allowed("feeds.EXAMPLE.com", &allow));
        assert!(host_allowed("a.news.org", &allow));
        assert!(!host_allowed("badexample.com", &allow));
        assert!(!host_allowed("example.com.evil.net", &allow));
        assert!(!host_allowed("example.com", &[]));
    }

    #[test]
    fn feeds_are_reduced_to_safe_text() {
        let rss = br#"<?xml version="1.0"?><rss version="2.0"><channel><title>T</title>
            <item><title>First &amp; &lt;b&gt;bold&lt;/b&gt;</title><link>https://example.com/1</link>
              <description>&lt;script&gt;alert(1)&lt;/script&gt;Hello</description><pubDate>Sun, 01 Nov 2026 10:00:00 GMT</pubDate></item>
            <item><title>Second</title><link>javascript:alert(1)</link></item>
            </channel></rss>"#;
        let items = parse_feed(rss, 10).unwrap();
        assert_eq!(items.len(), 2);
        assert_eq!(items[0].title, "First & bold");
        assert_eq!(items[0].link.as_deref(), Some("https://example.com/1"));
        assert!(items[0].date.is_some());
        assert!(!items[0].summary.contains('<'), "markup is stripped: {}", items[0].summary);
        assert_eq!(items[1].link, None, "non-http links are dropped");

        let body = br#"{"data":{"posts":[{"name":"A","href":"https://x.org/a","at":"2026-11-01T10:00:00Z"},{"name":"B","href":"ftp://x"}]}}"#;
        let cfg = json!({ "itemsPath": "data.posts", "titleField": "name", "linkField": "href", "dateField": "at" });
        let items = parse_json(body, &cfg, 10).unwrap();
        assert_eq!(items.len(), 2);
        assert_eq!((items[0].title.as_str(), items[0].link.as_deref()), ("A", Some("https://x.org/a")));
        assert!(items[0].date.is_some() && items[1].link.is_none());
        assert!(parse_json(br#"{"a":1}"#, &json!({ "itemsPath": "a" }), 10).is_err());
    }
}
