//! Runs short-lived developer tools (git, version probes) without a console
//! window, with a timeout, capturing stdout/stderr concurrently so large
//! outputs cannot dead-lock the pipes.

use std::io::Read;
use std::path::Path;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use crate::error::{AppError, AppResult};

pub struct Output {
    pub code: Option<i32>,
    pub stdout: Vec<u8>,
    pub stderr: String,
}

impl Output {
    pub fn ok(&self) -> bool {
        self.code == Some(0)
    }
    pub fn stdout_str(&self) -> String {
        String::from_utf8_lossy(&self.stdout).into_owned()
    }
}

pub fn command(program: &str) -> Command {
    let mut c = Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        c.creation_flags(CREATE_NO_WINDOW);
    }
    c
}

pub fn run(program: &str, args: &[&str], cwd: Option<&Path>, timeout: Duration) -> AppResult<Output> {
    let mut cmd = command(program);
    cmd.args(args).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    // Never let git or credential helpers wait for terminal input that will never come.
    cmd.env("GIT_TERMINAL_PROMPT", "0");
    if let Some(dir) = cwd {
        cmd.current_dir(dir);
    }
    let mut child = cmd.spawn().map_err(|e| AppError::Launch(format!("cannot run {program}: {e}")))?;
    let mut out = child.stdout.take().expect("piped stdout");
    let mut err = child.stderr.take().expect("piped stderr");
    let out_t = std::thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = out.read_to_end(&mut buf);
        buf
    });
    let err_t = std::thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = err.read_to_end(&mut buf);
        String::from_utf8_lossy(&buf).into_owned()
    });
    let start = Instant::now();
    let code = loop {
        if let Some(status) = child.try_wait()? {
            break status.code();
        }
        if start.elapsed() > timeout {
            let _ = child.kill();
            let _ = child.wait();
            return Err(AppError::Launch(format!("{program} timed out after {}s", timeout.as_secs())));
        }
        std::thread::sleep(Duration::from_millis(15));
    };
    Ok(Output { code, stdout: out_t.join().unwrap_or_default(), stderr: err_t.join().unwrap_or_default() })
}
