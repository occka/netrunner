//! Saved site logins, off until the user turns them on. Passwords live only in
//! Windows Credential Manager; the database holds which accounts exist. A page
//! can never ask for a login: filling happens only when the user clicks, in the
//! top frame, on exactly the site the login was saved for, over HTTPS.

use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use tauri::Url;

use crate::error::{AppError, AppResult};
use crate::services::settings;

/// Development builds keep their own entries.
const SERVICE: &str = if cfg!(debug_assertions) { "NETRUNNER-DEV-login" } else { "NETRUNNER-login" };
const INDEX: &str = "browser.logins";

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Login {
    pub host: String,
    pub username: String,
}

fn entry(host: &str, username: &str) -> AppResult<keyring::Entry> {
    keyring::Entry::new(SERVICE, &format!("{host}|{username}")).map_err(|e| AppError::Internal(format!("credential store unavailable: {e}")))
}

pub fn list(conn: &Connection) -> AppResult<Vec<Login>> {
    Ok(settings::get(conn, INDEX)?.and_then(|v| serde_json::from_value(v).ok()).unwrap_or_default())
}

fn write_index(conn: &Connection, logins: &[Login]) -> AppResult<()> {
    settings::set(conn, INDEX, &serde_json::to_value(logins)?)
}

pub fn save(conn: &Connection, host: &str, username: &str, password: &str) -> AppResult<()> {
    if host.is_empty() || host.len() > 253 || username.chars().count() > 256 {
        return Err(AppError::Invalid("invalid site or user name".into()));
    }
    if password.is_empty() || password.chars().count() > 512 {
        return Err(AppError::Invalid("the password must be 1 to 512 characters".into()));
    }
    entry(host, username)?.set_password(password).map_err(|e| AppError::Internal(format!("cannot store the password: {e}")))?;
    let mut logins = list(conn)?;
    let login = Login { host: host.into(), username: username.into() };
    if !logins.contains(&login) {
        logins.push(login);
        write_index(conn, &logins)?;
    }
    Ok(())
}

pub fn delete(conn: &Connection, host: &str, username: &str) -> AppResult<()> {
    match entry(host, username)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => {}
        Err(e) => return Err(AppError::Internal(format!("cannot delete the password: {e}"))),
    }
    let logins: Vec<Login> = list(conn)?.into_iter().filter(|l| !(l.host == host && l.username == username)).collect();
    write_index(conn, &logins)
}

pub fn password(host: &str, username: &str) -> AppResult<String> {
    entry(host, username)?.get_password().map_err(|_| AppError::NotFound("this login has no saved password".into()))
}

/// Exactly the saved host, and encrypted unless it is a local address.
pub fn may_fill(page: &str, host: &str) -> bool {
    let Ok(url) = Url::parse(page) else { return false };
    let Some(page_host) = url.host_str() else { return false };
    page_host == host && (url.scheme() == "https" || (url.scheme() == "http" && super::is_local_host(page_host)))
}

/// Puts the login in the page's visible password field and the field before it.
/// Set through the native setter, so that frameworks notice the change.
pub fn fill_script(username: &str, password: &str) -> AppResult<String> {
    let (user, pass) = (serde_json::to_string(username)?, serde_json::to_string(password)?);
    Ok(format!(
        "(()=>{{const shown=e=>e&&!e.disabled&&!e.readOnly&&e.offsetParent!==null;\
const pw=[...document.querySelectorAll('input[type=password]')].find(shown);if(!pw)return false;\
const fields=[...(pw.form||document).querySelectorAll('input')].filter(i=>shown(i)&&['text','email','tel',''].includes(i.type));\
const user=fields.filter(i=>i.compareDocumentPosition(pw)&Node.DOCUMENT_POSITION_FOLLOWING).pop();\
const set=(e,v)=>{{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,v);e.dispatchEvent(new Event('input',{{bubbles:true}}));e.dispatchEvent(new Event('change',{{bubbles:true}}))}};\
if(user)set(user,{user});set(pw,{pass});pw.focus();return true}})()"
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fills_only_on_the_exact_secure_site() {
        assert!(may_fill("https://example.com/login", "example.com"));
        assert!(may_fill("https://example.com:8443/", "example.com"));
        assert!(may_fill("http://localhost:3000/", "localhost"));
        for (page, host) in [
            ("http://example.com/", "example.com"),
            ("https://evil.com/?example.com", "example.com"),
            ("https://example.com.evil.net/", "example.com"),
            ("https://login.example.com/", "example.com"),
            ("https://example.com@evil.com/", "example.com"),
            ("about:blank", "example.com"),
            ("not a url", "example.com"),
        ] {
            assert!(!may_fill(page, host), "{page}");
        }
    }

    #[test]
    fn the_script_cannot_be_broken_out_of() {
        let s = fill_script("a\"b", "p'\"\\</script>`${x}").unwrap();
        assert!(s.contains(r#"set(user,"a\"b")"#), "{s}");
        assert!(s.contains(r#"set(pw,"p'\"\\</script>`${x}")"#), "{s}");
    }
}
