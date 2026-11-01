//! Alarms and timers at run time: a scheduler thread that checks every second
//! (independent of any window, so alarms ring while NETRUNNER is in the tray),
//! an audio thread, and the always-on-top "ringing" window with Snooze / Stop.

use std::collections::HashMap;
use std::fs::File;
use std::io::BufReader;
use std::path::PathBuf;
use std::sync::mpsc::{self, Sender};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use chrono::Local;
use rodio::buffer::SamplesBuffer;
use rodio::cpal::traits::{DeviceTrait, HostTrait};
use rodio::{Decoder, OutputStream, OutputStreamHandle, Sink, Source};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

use crate::error::{AppError, AppResult};
use crate::services::activity::{self, Level};
use crate::services::{alarms, sounds};
use crate::state::AppState;

pub const RING_WINDOW: &str = "alarm-ring";
/// A ringing alarm nobody answers stops after this long.
const RING_LIMIT_MS: i64 = 10 * 60_000;
/// After sleep or a stalled thread, alarms up to this old still ring (late).
const CATCH_UP: chrono::Duration = chrono::Duration::minutes(10);

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Ringing {
    /// `alarm-<id>` or `timer-<id>`.
    pub key: String,
    pub kind: &'static str,
    pub id: i64,
    pub label: String,
    pub since: i64,
}

static RINGING: Mutex<Vec<Ringing>> = Mutex::new(Vec::new());

pub fn ringing() -> Vec<Ringing> {
    RINGING.lock().map(|r| r.clone()).unwrap_or_default()
}

// ---------- Sound ----------

enum Cmd {
    Play { key: String, sound: String, volume: u8, limit: Option<Duration> },
    Stop(String),
}

static AUDIO: OnceLock<Mutex<Sender<Cmd>>> = OnceLock::new();

fn audio(cmd: Cmd) {
    if let Some(tx) = AUDIO.get().and_then(|m| m.lock().ok()) {
        let _ = tx.send(cmd);
    }
}

pub fn play(key: &str, sound: &str, volume: u8, limit: Option<Duration>) {
    audio(Cmd::Play { key: key.into(), sound: sound.into(), volume, limit });
}

pub fn stop_sound(key: &str) {
    audio(Cmd::Stop(key.into()));
}

/// The output stream is not `Send`, so it lives on its own thread.
fn audio_thread(data_dir: PathBuf, rx: mpsc::Receiver<Cmd>) {
    let mut stream: Option<(OutputStream, OutputStreamHandle)> = None;
    // The output's own rate: built-in sounds are rendered at it, so nothing is resampled.
    let mut rate = 48_000;
    let mut sinks: HashMap<String, Sink> = HashMap::new();
    for cmd in rx {
        sinks.retain(|_, s| !s.empty());
        match cmd {
            Cmd::Play { key, sound, volume, limit } => {
                if let Some(old) = sinks.remove(&key) {
                    old.stop();
                }
                // Reopen the device when nothing plays, so a changed default output is used.
                if sinks.is_empty() {
                    drop(stream.take());
                    rate = output_rate().unwrap_or(48_000);
                    stream = match OutputStream::try_default() {
                        Ok(s) => Some(s),
                        Err(err) => {
                            log::error!("alarm sound: no audio output ({err})");
                            None
                        }
                    };
                }
                let Some((_, handle)) = &stream else { continue };
                let sink = match Sink::try_new(handle) {
                    Ok(s) => s,
                    Err(err) => {
                        log::error!("alarm sound: {err}");
                        continue;
                    }
                };
                sink.set_volume(f32::from(volume.min(100)) / 100.0);
                let source = load(&data_dir, &sound, rate);
                match limit {
                    Some(d) => sink.append(source.take_duration(d)),
                    None => sink.append(source),
                }
                sinks.insert(key, sink);
            }
            Cmd::Stop(key) => {
                if let Some(s) = sinks.remove(&key) {
                    s.stop();
                }
            }
        }
    }
}

/// Sample rate of the default output device (what `OutputStream::try_default` opens).
fn output_rate() -> Option<u32> {
    let device = rodio::cpal::default_host().default_output_device()?;
    Some(device.default_output_config().ok()?.sample_rate().0)
}

type BoxedSource = Box<dyn Source<Item = f32> + Send>;

/// A looping source for a sound id; unreadable files fall back to "pulse".
fn load(data_dir: &std::path::Path, sound: &str, rate: u32) -> BoxedSource {
    let fallback = || Box::new(synth("pulse", rate).repeat_infinite());
    match sounds::file(data_dir, sound) {
        Ok(None) => Box::new(synth(sound, rate).repeat_infinite()),
        Ok(Some(path)) => match File::open(&path).map(BufReader::new).map(Decoder::new) {
            Ok(Ok(decoder)) => Box::new(decoder.convert_samples::<f32>().buffered().repeat_infinite()),
            Ok(Err(err)) => {
                log::warn!("alarm sound {sound} cannot be decoded ({err}); using the built-in sound");
                fallback()
            }
            Err(err) => {
                log::warn!("alarm sound {sound} cannot be opened ({err}); using the built-in sound");
                fallback()
            }
        },
        Err(_) => fallback(),
    }
}

/// Built-in alarm sounds are generated, not bundled files. One period of the
/// pattern is rendered up front at the device's rate and then looped, so the
/// audio callback only copies samples (no maths, no resampling).
fn synth(kind: &str, rate: u32) -> SamplesBuffer<f32> {
    let kind = alarms::BUILTIN_SOUNDS.iter().map(|(id, _)| *id).find(|id| *id == kind).unwrap_or("pulse");
    let period = match kind {
        "digital" => 1.0,
        "chime" | "soft" | "siren" => 2.0,
        _ => 1.4,
    };
    let n = (period * f64::from(rate)).round() as usize;
    let samples = (0..n).map(|i| sample(kind, i as f64 / f64::from(rate)) as f32).collect::<Vec<_>>();
    SamplesBuffer::new(1, rate, samples)
}

use std::f64::consts::TAU;

/// Linear 5 ms attack / 20 ms release inside [start, start + len), 0 outside.
fn gate(t: f64, start: f64, len: f64) -> f64 {
    let x = t - start;
    if x < 0.0 || x >= len {
        return 0.0;
    }
    (x / 0.005).min(1.0) * ((len - x) / 0.02).min(1.0)
}

fn tone(f: f64, t: f64) -> f64 {
    (TAU * f * t).sin()
}

pub(crate) fn sample(kind: &str, t: f64) -> f64 {
    match kind {
        "digital" => {
            let g: f64 = [0.0, 0.14, 0.28].iter().map(|s| gate(t, *s, 0.08)).sum();
            g * 0.32 * (tone(1320.0, t) + 0.3 * tone(2640.0, t))
        }
        "chime" => {
            // Decaying bell strokes; `gate` is 0 outside each stroke.
            let a = (-t * 3.5).exp() * gate(t, 0.0, 1.2);
            let b = (-(t - 0.45) * 3.0).exp() * gate(t, 0.45, 1.35);
            0.38 * (a * (tone(660.0, t) + 0.2 * tone(1320.0, t)) + b * (tone(990.0, t) + 0.2 * tone(1980.0, t)))
        }
        "soft" => {
            let env = if t < 1.6 { (std::f64::consts::PI * t / 1.6).sin().powi(2) } else { 0.0 };
            0.3 * env * (tone(523.25, t) + 0.6 * tone(784.0, t))
        }
        "siren" => {
            // Frequency 700 ± 400 Hz over the 2 s period; phase is its integral.
            let phase = 700.0 * t - 400.0 / std::f64::consts::PI * (std::f64::consts::PI * t).cos();
            0.28 * (TAU * phase).sin()
        }
        _ => {
            let g: f64 = [0.0, 0.2, 0.4, 0.6].iter().map(|s| gate(t, *s, 0.12)).sum();
            g * 0.36 * (tone(880.0, t) + 0.25 * tone(2640.0, t))
        }
    }
}

// ---------- Ringing ----------

fn changed(app: &AppHandle) {
    let _ = app.emit("alarms://changed", ());
}

fn ring(app: &AppHandle, kind: &'static str, id: i64, label: &str, sound: &str, volume: u8) {
    let key = format!("{kind}-{id}");
    if let Ok(mut list) = RINGING.lock() {
        list.retain(|r| r.key != key);
        list.push(Ringing { key: key.clone(), kind, id, label: label.to_string(), since: alarms::now_ms() });
    }
    play(&key, sound, volume, None);
    if let Some(state) = app.try_state::<AppState>() {
        if let Ok(conn) = state.db.conn() {
            let what = if kind == "alarm" { "Alarm" } else { "Timer" };
            let name = if label.is_empty() { String::new() } else { format!(" '{label}'") };
            activity::record(&conn, Level::Info, "alarms", &format!("{what}{name} is ringing"));
        }
    }
    show_window(app);
    let _ = app.emit("alarms://ringing", ringing());
}

fn show_window(app: &AppHandle) {
    if let Some(win) = app.get_window(RING_WINDOW) {
        let _ = win.show();
        let _ = win.set_focus();
        return;
    }
    let built = WebviewWindowBuilder::new(app, RING_WINDOW, WebviewUrl::App("index.html?ring=1".into()))
        .title("NETRUNNER · alarm")
        .inner_size(380.0, 240.0)
        .resizable(false)
        .decorations(false)
        .always_on_top(true)
        .center()
        .focused(true)
        .build();
    match built {
        Ok(win) => {
            let _ = win.request_user_attention(Some(tauri::UserAttentionType::Critical));
        }
        Err(err) => log::error!("cannot open the alarm window: {err}"),
    }
}

/// Stops a ringing alarm or timer. Closes the ringing window when nothing is left.
pub fn stop(app: &AppHandle, key: &str) {
    stop_sound(key);
    let empty = RINGING.lock().map(|mut l| {
        l.retain(|r| r.key != key);
        l.is_empty()
    });
    if empty.unwrap_or(true) {
        if let Some(win) = app.get_window(RING_WINDOW) {
            let _ = win.destroy();
        }
    }
    let _ = app.emit("alarms://ringing", ringing());
    changed(app);
}

pub fn stop_all(app: &AppHandle) {
    for r in ringing() {
        stop(app, &r.key);
    }
    if let Some(win) = app.get_window(RING_WINDOW) {
        let _ = win.destroy();
    }
}

/// Snooze: an alarm rings again after its snooze time, a timer runs one more minute.
pub fn snooze(app: &AppHandle, key: &str) -> AppResult<()> {
    let r = ringing().into_iter().find(|r| r.key == key).ok_or_else(|| AppError::NotFound("nothing is ringing".into()))?;
    {
        let state = app.state::<AppState>();
        let conn = state.db.conn()?;
        if r.kind == "alarm" {
            alarms::snooze(&conn, r.id, alarms::now_ms())?;
        } else {
            alarms::extend_timer(&conn, r.id, alarms::now_ms(), 60_000)?;
        }
    }
    stop(app, key);
    Ok(())
}

// ---------- Scheduler ----------

fn tick(app: &AppHandle, from: chrono::DateTime<Local>, to: chrono::DateTime<Local>) -> AppResult<()> {
    let state = app.state::<AppState>();
    let mut rang = false;
    let (due_alarms, timers) = {
        let conn = state.db.conn()?;
        let list = alarms::list_alarms(&conn)?;
        let due = alarms::due(&list, from.naive_local(), to.naive_local(), from.timestamp_millis(), to.timestamp_millis());
        let mut out = Vec::new();
        for (id, _) in due {
            alarms::mark_rang(&conn, id)?;
            if let Some(a) = list.iter().find(|a| a.id == id) {
                out.push(a.clone());
            }
        }
        (out, alarms::take_finished_timers(&conn, to.timestamp_millis())?)
    };
    for a in due_alarms {
        ring(app, "alarm", a.id, &a.label, &a.sound, a.volume);
        rang = true;
    }
    for t in timers {
        ring(app, "timer", t.id, &t.label, &t.sound, t.volume);
        rang = true;
    }
    // Nobody answered: stop after the limit so it does not ring all day.
    let stale: Vec<String> =
        ringing().into_iter().filter(|r| to.timestamp_millis() - r.since > RING_LIMIT_MS).map(|r| r.key).collect();
    for key in stale {
        log::info!("{key} rang unanswered for 10 minutes; stopped");
        stop(app, &key);
    }
    if rang {
        changed(app);
    }
    Ok(())
}

pub fn start(app: &AppHandle, data_dir: PathBuf) {
    let (tx, rx) = mpsc::channel();
    let _ = AUDIO.set(Mutex::new(tx));
    std::thread::Builder::new()
        .name("alarm-audio".into())
        .spawn(move || audio_thread(data_dir, rx))
        .expect("spawn audio thread");
    let app = app.clone();
    std::thread::Builder::new()
        .name("alarm-scheduler".into())
        .spawn(move || {
            let mut last = Local::now();
            loop {
                std::thread::sleep(Duration::from_secs(1));
                let now = Local::now();
                // Clock moved back: start again from now. Long gap (sleep): ring only recent alarms.
                let from = if now < last { now } else { last.max(now - CATCH_UP) };
                if let Err(err) = tick(&app, from, now) {
                    log::error!("alarm scheduler: {err}");
                }
                last = now;
            }
        })
        .expect("spawn alarm scheduler");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn built_in_sounds_are_audible_and_never_clip() {
        for (id, _) in alarms::BUILTIN_SOUNDS {
            let samples: Vec<f32> = synth(id, 48_000).collect();
            let peak = samples.iter().fold(0f32, |m, s| m.max(s.abs()));
            assert!(peak > 0.1, "{id} is silent");
            assert!(peak <= 1.0, "{id} clips ({peak})");
            // Looping must not click: the period ends where it starts.
            let (first, last) = (samples[0], samples[samples.len() - 1]);
            assert!((first - last).abs() < 0.05, "{id} jumps at the loop point ({last} → {first})");
            // No sudden jumps inside the pattern either (a click is a large sample-to-sample step).
            let step = samples.windows(2).fold(0f32, |m, w| m.max((w[1] - w[0]).abs()));
            assert!(step < 0.15, "{id} has a {step} step");
        }
        // Unknown ids play the default sound instead of failing.
        assert_eq!(synth("nope", 48_000).count(), synth("pulse", 48_000).count());
    }
}
