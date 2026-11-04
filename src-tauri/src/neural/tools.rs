//! What the NEURAL agent can do: files in its own chat folder, the time and,
//! in Play, dice. Nothing here runs a program or reaches beyond the folder.
//! Python goes to Gemini's own hosted code execution, not this machine.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use super::folder::{Change, ChatFolder};

/// One thing the agent did, shown as a card under its reply.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Action {
    /// write, append, edit, dice or python.
    pub kind: String,
    pub label: String,
    pub detail: Option<String>,
    pub error: Option<String>,
    pub added: usize,
    pub removed: usize,
    /// Undo id while the change can still be undone.
    pub change: Option<u64>,
}

fn string_arg(name: &str, description: &str) -> (String, Value) {
    (name.to_string(), json!({ "type": "string", "description": description }))
}

fn declare(name: &str, description: &str, args: &[(&str, &str)], required: &[&str]) -> Value {
    let properties: serde_json::Map<String, Value> = args.iter().map(|(n, d)| string_arg(n, d)).collect();
    if properties.is_empty() {
        return json!({ "name": name, "description": description });
    }
    json!({
        "name": name,
        "description": description,
        "parameters": { "type": "object", "properties": properties, "required": required }
    })
}

/// The `tools` array of a request.
pub fn declarations(play: bool, code_execution: bool) -> Value {
    const PATH: (&str, &str) = ("path", "Path relative to your folder, for example npcs/mira.md");
    let mut functions = vec![
        declare("list_files", "Lists every file in your folder with its size.", &[], &[]),
        declare("read_file", "Reads a text file from your folder.", &[PATH], &["path"]),
        declare("write_file", "Creates a file or replaces it completely. Prefer edit_file or append_to_file for small changes.", &[PATH, ("content", "The whole new content")], &["path", "content"]),
        declare("append_to_file", "Adds text to the end of a file, creating it if needed. Ideal for logs.", &[PATH, ("content", "Text to add")], &["path", "content"]),
        declare("edit_file", "Replaces one exact piece of text that occurs once in the file.", &[PATH, ("old_text", "Exact text to replace"), ("new_text", "Replacement")], &["path", "old_text", "new_text"]),
        declare("get_system_time", "Returns the current local date and time.", &[], &[]),
    ];
    if play {
        functions.push(declare("roll_dice", "Rolls real dice on the user's computer. Always use this for dice; never invent results.", &[("notation", "Dice notation such as 1d20, 2d6+3 or 1d8-1")], &["notation"]));
    }
    let mut tools = vec![json!({ "functionDeclarations": functions })];
    if code_execution {
        tools.push(json!({ "codeExecution": {} }));
    }
    Value::Array(tools)
}

fn random_below(limit: u32) -> Result<u32, String> {
    // Rejection sampling: taking a remainder alone would favour low numbers.
    let zone = u32::MAX - (u32::MAX % limit);
    loop {
        let mut bytes = [0u8; 4];
        getrandom::fill(&mut bytes).map_err(|e| e.to_string())?;
        let value = u32::from_le_bytes(bytes);
        if value < zone {
            return Ok(value % limit);
        }
    }
}

/// `NdM`, `NdM+K` or `NdM-K`, with N up to 100 and M from 2 to 1000.
pub fn parse_dice(notation: &str) -> Result<(u32, u32, i64), String> {
    let text = notation.trim().to_lowercase().replace(' ', "");
    let bad = || format!("invalid dice notation: {notation}");
    let (count, rest) = text.split_once('d').ok_or_else(bad)?;
    let count: u32 = if count.is_empty() { 1 } else { count.parse().map_err(|_| bad())? };
    let split = rest.find(['+', '-']).unwrap_or(rest.len());
    let sides: u32 = rest[..split].parse().map_err(|_| bad())?;
    let modifier: i64 = if split < rest.len() { rest[split..].parse().map_err(|_| bad())? } else { 0 };
    if !(1..=100).contains(&count) || !(2..=1000).contains(&sides) || modifier.abs() > 10_000 {
        return Err(format!("dice out of range: {notation}"));
    }
    Ok((count, sides, modifier))
}

fn roll(notation: &str) -> Result<(Vec<u32>, i64), String> {
    let (count, sides, modifier) = parse_dice(notation)?;
    let rolls = (0..count).map(|_| random_below(sides).map(|v| v + 1)).collect::<Result<Vec<_>, _>>()?;
    let total = rolls.iter().map(|r| i64::from(*r)).sum::<i64>() + modifier;
    Ok((rolls, total))
}

fn file_action(kind: &str, path: &str, change: Result<Change, crate::error::AppError>) -> (Value, Action) {
    match change {
        Ok(c) => (
            json!({ "result": "saved", "path": path, "added_lines": c.added, "removed_lines": c.removed }),
            Action { kind: kind.into(), label: path.into(), detail: Some(c.diff), added: c.added, removed: c.removed, change: Some(c.id), error: None },
        ),
        Err(e) => (json!({ "error": e.to_string() }), Action { kind: kind.into(), label: path.into(), error: Some(e.to_string()), ..Action::default() }),
    }
}

/// Runs one tool call. Reads and listings are not shown as cards.
pub fn execute(folder: &ChatFolder, name: &str, args: &Value, play: bool) -> (Value, Option<Action>) {
    let arg = |key: &str| args[key].as_str().unwrap_or("");
    let path = arg("path");
    match name {
        "list_files" => (json!({ "files": folder.list() }), None),
        "read_file" => match folder.read(path) {
            Ok(text) => (json!({ "content": text }), None),
            Err(e) => (json!({ "error": e.to_string() }), None),
        },
        "write_file" => {
            let (result, action) = file_action("write", path, folder.write(path, arg("content")));
            (result, Some(action))
        }
        "append_to_file" => {
            let (result, action) = file_action("append", path, folder.append(path, arg("content")));
            (result, Some(action))
        }
        "edit_file" => {
            let (result, action) = file_action("edit", path, folder.edit(path, arg("old_text"), arg("new_text")));
            (result, Some(action))
        }
        "get_system_time" => (json!({ "now": chrono::Local::now().format("%A %Y-%m-%d %H:%M:%S %:z").to_string() }), None),
        "roll_dice" if play => {
            let notation = arg("notation");
            match roll(notation) {
                Ok((rolls, total)) => {
                    let shown = rolls.iter().map(u32::to_string).collect::<Vec<_>>().join(", ");
                    let label = format!("{notation} → {total}");
                    (
                        json!({ "notation": notation, "rolls": rolls, "total": total }),
                        Some(Action { kind: "dice".into(), label, detail: Some(format!("rolls: {shown}")), ..Action::default() }),
                    )
                }
                Err(e) => (json!({ "error": e }), Some(Action { kind: "dice".into(), label: notation.into(), error: Some(e), ..Action::default() })),
            }
        }
        other => (json!({ "error": format!("unknown tool: {other}") }), None),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_dice() {
        assert_eq!(parse_dice("1d20").unwrap(), (1, 20, 0));
        assert_eq!(parse_dice(" 2D6 + 3 ").unwrap(), (2, 6, 3));
        assert_eq!(parse_dice("d8-1").unwrap(), (1, 8, -1));
        for bad in ["", "d", "20", "0d6", "101d6", "1d1", "1d1001", "1d6+", "xd6", "1d6*2", "1d6+99999"] {
            assert!(parse_dice(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn dice_stay_in_range_and_cover_every_side() {
        let mut seen = [0u32; 6];
        for _ in 0..2000 {
            let (rolls, total) = roll("1d6").unwrap();
            assert!((1..=6).contains(&rolls[0]));
            assert_eq!(total, i64::from(rolls[0]));
            seen[rolls[0] as usize - 1] += 1;
        }
        assert!(seen.iter().all(|n| *n > 200), "{seen:?}");
        let (rolls, total) = roll("3d4+2").unwrap();
        assert_eq!(total, rolls.iter().map(|r| i64::from(*r)).sum::<i64>() + 2);
    }

    #[test]
    fn runs_tools_only_inside_the_folder() {
        let base = std::env::temp_dir().join(format!("nr-tools-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let folder = ChatFolder::new(&base, 1);
        let (ok, action) = execute(&folder, "write_file", &json!({ "path": "a.md", "content": "hi" }), false);
        assert_eq!(ok["result"], "saved");
        assert!(action.unwrap().change.is_some());
        assert_eq!(execute(&folder, "read_file", &json!({ "path": "a.md" }), false).0["content"], "hi");

        let (out, action) = execute(&folder, "write_file", &json!({ "path": "../../../x.md", "content": "no" }), false);
        assert!(out["error"].is_string());
        assert!(action.unwrap().error.is_some());
        assert!(!base.join("x.md").exists());

        assert!(execute(&folder, "roll_dice", &json!({ "notation": "1d20" }), false).0["error"].is_string(), "no dice in Work");
        assert!(execute(&folder, "roll_dice", &json!({ "notation": "1d20" }), true).0["total"].is_i64());
        assert!(execute(&folder, "run_shell", &json!({ "command": "calc" }), true).0["error"].is_string());
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn declares_dice_and_python_only_when_asked() {
        let work = declarations(false, false).to_string();
        assert!(work.contains("write_file") && !work.contains("roll_dice") && !work.contains("codeExecution"));
        let play = declarations(true, true).to_string();
        assert!(play.contains("roll_dice") && play.contains("codeExecution"));
    }
}
