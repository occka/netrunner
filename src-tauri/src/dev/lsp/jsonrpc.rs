//! JSON-RPC 2.0 over `Content-Length` framing, as used by the Language Server
//! Protocol and the Debug Adapter Protocol.

use serde_json::Value;

/// Upper bound for one message; a larger header means a broken stream.
const MAX_MESSAGE: usize = 64 * 1024 * 1024;

/// Wraps a JSON message in a `Content-Length` header.
pub fn encode(message: &Value) -> Vec<u8> {
    let body = serde_json::to_vec(message).unwrap_or_default();
    let mut out = format!("Content-Length: {}\r\n\r\n", body.len()).into_bytes();
    out.extend_from_slice(&body);
    out
}

/// Splits a byte stream into messages. Reads may cut a message anywhere or
/// carry several at once; bytes are buffered until a whole message arrived.
#[derive(Default)]
pub struct Framer {
    buf: Vec<u8>,
}

#[derive(Debug, PartialEq)]
pub enum Frame {
    Message(Value),
    /// A complete frame whose body is not JSON; skipped, the stream goes on.
    Invalid(String),
}

impl Framer {
    pub fn push(&mut self, bytes: &[u8]) {
        self.buf.extend_from_slice(bytes);
    }

    /// The next complete message, if one is buffered.
    pub fn next(&mut self) -> Result<Option<Frame>, String> {
        let Some(header_end) = find(&self.buf, b"\r\n\r\n") else {
            if self.buf.len() > 8192 {
                return Err("message header is too long".into());
            }
            return Ok(None);
        };
        let header = String::from_utf8_lossy(&self.buf[..header_end]).into_owned();
        let length = header
            .lines()
            .filter_map(|l| l.split_once(':'))
            .find(|(k, _)| k.trim().eq_ignore_ascii_case("content-length"))
            .and_then(|(_, v)| v.trim().parse::<usize>().ok())
            .ok_or_else(|| format!("missing Content-Length in header '{}'", header.trim()))?;
        if length > MAX_MESSAGE {
            return Err(format!("message of {length} bytes is too large"));
        }
        let start = header_end + 4;
        if self.buf.len() < start + length {
            return Ok(None);
        }
        let body: Vec<u8> = self.buf.drain(..start + length).skip(start).collect();
        Ok(Some(match serde_json::from_slice(&body) {
            Ok(v) => Frame::Message(v),
            Err(e) => Frame::Invalid(e.to_string()),
        }))
    }
}

fn find(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack.windows(needle.len()).position(|w| w == needle)
}

/// What an incoming message is, by the JSON-RPC rules.
#[derive(Debug, PartialEq)]
pub enum Kind {
    /// A reply to one of our requests.
    Response { id: i64 },
    /// The other side asks us something and waits for a reply.
    Request { id: Value, method: String },
    Notification { method: String },
    Unknown,
}

pub fn classify(msg: &Value) -> Kind {
    let method = msg.get("method").and_then(Value::as_str).map(str::to_string);
    let id = msg.get("id").filter(|v| !v.is_null());
    match (method, id) {
        (Some(method), Some(id)) => Kind::Request { id: id.clone(), method },
        (Some(method), None) => Kind::Notification { method },
        (None, Some(id)) => id
            .as_i64()
            .or_else(|| id.as_str().and_then(|s| s.parse().ok()))
            .map_or(Kind::Unknown, |id| Kind::Response { id }),
        (None, None) => Kind::Unknown,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn round_trip() {
        let msg = json!({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"name": "Привет"}});
        let mut f = Framer::default();
        f.push(&encode(&msg));
        assert_eq!(f.next().unwrap(), Some(Frame::Message(msg)));
        assert_eq!(f.next().unwrap(), None);
    }

    #[test]
    fn split_and_glued_messages() {
        let a = json!({"jsonrpc": "2.0", "method": "a"});
        let b = json!({"jsonrpc": "2.0", "id": 7, "result": [1, 2, 3]});
        let mut bytes = encode(&a);
        bytes.extend(encode(&b));
        let mut f = Framer::default();
        let mut got = Vec::new();
        // One byte at a time: header and body are cut everywhere.
        for byte in &bytes {
            f.push(std::slice::from_ref(byte));
            while let Some(Frame::Message(m)) = f.next().unwrap() {
                got.push(m);
            }
        }
        assert_eq!(got, vec![a.clone(), b.clone()]);
        // Both at once.
        f.push(&bytes);
        assert_eq!(f.next().unwrap(), Some(Frame::Message(a)));
        assert_eq!(f.next().unwrap(), Some(Frame::Message(b)));
    }

    #[test]
    fn extra_headers_and_bad_bodies() {
        let mut f = Framer::default();
        f.push(b"Content-Type: application/vscode-jsonrpc; charset=utf-8\r\ncontent-length: 2\r\n\r\n{}");
        assert_eq!(f.next().unwrap(), Some(Frame::Message(json!({}))));
        f.push(b"Content-Length: 3\r\n\r\n{x}");
        assert!(matches!(f.next().unwrap(), Some(Frame::Invalid(_))));
        f.push(b"Content-Length: 2\r\n\r\n[]");
        assert_eq!(f.next().unwrap(), Some(Frame::Message(json!([]))));
        f.push(b"Bogus: 1\r\n\r\n");
        assert!(f.next().is_err());
    }

    #[test]
    fn classifies_messages() {
        assert_eq!(classify(&json!({"id": 3, "result": null})), Kind::Response { id: 3 });
        assert_eq!(classify(&json!({"id": "4", "error": {}})), Kind::Response { id: 4 });
        assert_eq!(
            classify(&json!({"id": "x", "method": "workspace/configuration"})),
            Kind::Request { id: json!("x"), method: "workspace/configuration".into() }
        );
        assert_eq!(classify(&json!({"method": "textDocument/publishDiagnostics"})), Kind::Notification {
            method: "textDocument/publishDiagnostics".into()
        });
        assert_eq!(classify(&json!({"id": null, "method": "x"})), Kind::Notification { method: "x".into() });
    }
}
