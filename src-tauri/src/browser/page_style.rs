//! How pages look in BROWSER: dark mode (native WebView2 setting), NETRUNNER's
//! accent and scrollbars (a stylesheet added to the page), and, per site as an
//! experiment, a transparent page over NETRUNNER's own background.
//!
//! The stylesheet carries only colours from the theme. Nothing about the user
//! reaches a page beyond what any page could learn from its own computed style.

use tauri::{AppHandle, Manager};
use url::Url;

use super::{native, Browser, Prefs};

#[derive(Debug, Clone, PartialEq)]
pub struct PageStyle {
    pub accent: bool,
    pub transparent: bool,
    /// Opacity in % of the theme colour over the background of a transparent page.
    pub tint: u8,
}

/// `#rgb` or `#rrggbb`, so a theme value can never carry anything else into CSS.
pub fn valid_hex(s: &str) -> bool {
    let h = s.strip_prefix('#').unwrap_or("");
    matches!(h.len(), 3 | 6) && h.chars().all(|c| c.is_ascii_hexdigit())
}

pub fn rgb(hex: &str) -> (u8, u8, u8) {
    let h = hex.trim_start_matches('#');
    let channel = |s: &str| u8::from_str_radix(s, 16).unwrap_or(0);
    match h.len() {
        3 => {
            let d = |i: usize| channel(&h[i..=i].repeat(2));
            (d(0), d(1), d(2))
        }
        6 => (channel(&h[0..2]), channel(&h[2..4]), channel(&h[4..6])),
        _ => (11, 13, 16),
    }
}

fn host_in(list: &[String], host: &str) -> bool {
    list.iter().any(|e| host == e || host.ends_with(&format!(".{e}")))
}

pub fn style_for(prefs: &Prefs, url: &str) -> PageStyle {
    let host = Url::parse(url).ok().filter(|u| matches!(u.scheme(), "http" | "https")).and_then(|u| u.host_str().map(str::to_string));
    let Some(host) = host else { return PageStyle { accent: false, transparent: false, tint: prefs.page_tint } };
    PageStyle { accent: prefs.page_accent && !host_in(&prefs.page_accent_off, &host), transparent: host_in(&prefs.page_transparent, &host), tint: prefs.page_tint.min(100) }
}

/// The stylesheet for a page; empty when nothing applies.
pub fn css(style: &PageStyle, primary: &str, background: &str) -> String {
    let mut out = String::new();
    if style.accent && valid_hex(primary) {
        out.push_str(&format!("html{{accent-color:{primary};scrollbar-color:{primary} transparent}}::selection{{background:{primary}55}}"));
    }
    if style.transparent && valid_hex(background) {
        let (r, g, b) = rgb(background);
        let alpha = f32::from(style.tint.min(100)) / 100.0;
        // Pages paint their own backgrounds, usually on these outer elements.
        // Inner cards stay opaque, and that is what keeps the text readable.
        out.push_str(&format!(
            "html{{background:rgba({r},{g},{b},{alpha})!important;color-scheme:dark}}\
             body,body>div,body>main,body>section,body>header,body>footer,main,#root,#app,#__next,#content,#page,#wrapper{{background:transparent!important}}"
        ));
    }
    out
}

/// Replaces NETRUNNER's sheet on the page. A constructed sheet: an added
/// `<style>` element would be refused by a strict Content-Security-Policy.
pub fn script(css: &str) -> String {
    let json = serde_json::to_string(css).unwrap_or_else(|_| "\"\"".into());
    format!(
        "(()=>{{try{{const k=Symbol.for('netrunner.page');let s=document[k];const c={json};if(!s){{if(!c)return;s=new CSSStyleSheet();Object.defineProperty(document,k,{{value:s}})}}s.replaceSync(c);const a=document.adoptedStyleSheets;if(c&&!a.includes(s))document.adoptedStyleSheets=[...a,s];if(!c&&a.includes(s))document.adoptedStyleSheets=a.filter(x=>x!==s)}}catch(e){{}}}})()"
    )
}

/// Applies the current preferences to one tab. Runs when a page starts and
/// finishes loading, and on every tab when a setting changes.
pub fn apply(app: &AppHandle, label: &str, url: &str) {
    let Some(browser) = app.try_state::<Browser>() else { return };
    let Some(webview) = app.get_webview(label) else { return };
    let prefs = browser.prefs();
    let style = style_for(&prefs, url);
    native::set_page_appearance(&webview, prefs.page_dark != "off", style.transparent, rgb(&prefs.page_background));
    let _ = webview.eval(script(&css(&style, &prefs.page_primary, &prefs.page_background)));
}

pub fn apply_all(app: &AppHandle) {
    let Some(browser) = app.try_state::<Browser>() else { return };
    for tab in browser.tabs() {
        apply(app, &tab.id, &tab.url);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn prefs() -> Prefs {
        Prefs { page_accent: true, page_accent_off: vec!["bank.example".into()], page_transparent: vec!["duckduckgo.com".into()], page_tint: 60, ..Prefs::default() }
    }

    #[test]
    fn picks_the_style_per_site() {
        let p = prefs();
        assert_eq!(style_for(&p, "https://example.org/x"), PageStyle { accent: true, transparent: false, tint: 60 });
        assert!(!style_for(&p, "https://online.bank.example/").accent, "a subdomain follows its site");
        assert!(style_for(&p, "https://start.duckduckgo.com/").transparent);
        assert!(!style_for(&p, "https://notduckduckgo.com/").transparent);
        assert_eq!(style_for(&p, "about:blank"), PageStyle { accent: false, transparent: false, tint: 60 });
        assert!(!style_for(&Prefs { page_accent: false, ..prefs() }, "https://example.org/").accent);
    }

    #[test]
    fn builds_css_only_from_valid_colours() {
        let both = PageStyle { accent: true, transparent: true, tint: 25 };
        let c = css(&both, "#7b2cbf", "#050508");
        assert!(c.contains("accent-color:#7b2cbf") && c.contains("::selection{background:#7b2cbf55}"));
        assert!(c.contains("rgba(5,5,8,0.25)") && c.contains("body,"));
        assert_eq!(css(&PageStyle { accent: false, transparent: false, tint: 25 }, "#7b2cbf", "#050508"), "");
        // A value that is not a colour can never reach the page.
        assert_eq!(css(&both, "red;}body{display:none", "url(x)"), "");
        assert!(!valid_hex("#12") && !valid_hex("#gggggg") && !valid_hex("123456") && valid_hex("#abc"));
        assert_eq!(rgb("#abc"), (170, 187, 204));
        assert_eq!(rgb("#050508"), (5, 5, 8));
    }

    #[test]
    fn the_script_escapes_its_css_and_can_remove_it() {
        let s = script("a{content:\"x\"}");
        assert!(s.contains(r#"const c="a{content:\"x\"}""#), "{s}");
        assert!(script("").contains("const c=\"\""));
        assert!(s.contains("new CSSStyleSheet()") && s.contains("adoptedStyleSheets"));
    }
}
