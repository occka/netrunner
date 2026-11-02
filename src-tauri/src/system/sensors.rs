//! Temperatures and fan speeds from HWiNFO's shared memory (an optional source,
//! off by default). The user runs HWiNFO with "Shared Memory Support" on;
//! NETRUNNER only reads the block. Nothing here trusts the block's contents:
//! every size and offset is checked before use.

use serde::Serialize;

pub const SETTING_KEY: &str = "sensors.hwinfo";
pub const MAP_NAME: &str = r"Global\HWiNFO_SENS_SM2";

/// "HWiS" in memory.
const SIGNATURE: u32 = 0x5369_5748;
const HEADER_LEN: usize = 44;
const STRING_LEN: usize = 128;
const UNIT_LEN: usize = 16;
const MIN_SENSOR_LEN: usize = 8 + 2 * STRING_LEN;
const MIN_READING_LEN: usize = 12 + 2 * STRING_LEN + UNIT_LEN + 4 * 8;
const MAX_SENSORS: usize = 4096;
const MAX_READINGS: usize = 65_536;
/// HWiNFO updates at least every few seconds while it runs.
const STALE_AFTER_SECS: i64 = 60;

#[derive(Debug, Clone, PartialEq)]
pub struct Reading {
    pub sensor: String,
    pub label: String,
    /// HWiNFO reading type: 1 temperature, 3 fan, others are not used here.
    pub kind: u32,
    pub unit: String,
    pub value: f64,
}

#[derive(Debug, PartialEq)]
pub struct Block {
    pub poll_time: i64,
    pub readings: Vec<Reading>,
}

fn u32_at(b: &[u8], at: usize) -> Option<u32> {
    b.get(at..at + 4).map(|s| u32::from_le_bytes([s[0], s[1], s[2], s[3]]))
}

/// A NUL-terminated string: UTF-8 when valid, else Windows-1252-like bytes
/// (HWiNFO writes the degree sign as a single 0xB0 byte).
fn text_at(b: &[u8], at: usize, len: usize) -> String {
    let Some(raw) = b.get(at..at + len) else { return String::new() };
    let raw = &raw[..raw.iter().position(|c| *c == 0).unwrap_or(len)];
    match std::str::from_utf8(raw) {
        Ok(s) => s.trim().to_string(),
        Err(_) => raw.iter().map(|c| *c as char).collect::<String>().trim().to_string(),
    }
}

/// Parses a copy of the shared memory. `Err` says why the block is unusable.
pub fn parse(b: &[u8]) -> Result<Block, String> {
    if b.len() < HEADER_LEN {
        return Err("the block is too short".into());
    }
    if u32_at(b, 0) != Some(SIGNATURE) {
        return Err("HWiNFO is not sharing its sensors".into());
    }
    let version = u32_at(b, 4).unwrap_or(0);
    if version < 2 {
        return Err(format!("HWiNFO shared memory version {version} is not supported"));
    }
    let poll_time = b.get(12..20).map(|s| i64::from_le_bytes(s.try_into().unwrap_or_default())).unwrap_or(0);
    let field = |at| u32_at(b, at).unwrap_or(0) as usize;
    let (sensor_off, sensor_len, sensors) = (field(20), field(24), field(28));
    let (reading_off, reading_len, readings) = (field(32), field(36), field(40));
    if sensor_len < MIN_SENSOR_LEN || reading_len < MIN_READING_LEN || sensors > MAX_SENSORS || readings > MAX_READINGS {
        return Err("the block's layout is not recognised".into());
    }
    let fits = |off: usize, len: usize, n: usize| len.checked_mul(n).and_then(|t| t.checked_add(off)).is_some_and(|end| end <= b.len());
    if !fits(sensor_off, sensor_len, sensors) || !fits(reading_off, reading_len, readings) {
        return Err("the block is truncated".into());
    }
    let names: Vec<String> = (0..sensors)
        .map(|i| {
            let at = sensor_off + i * sensor_len;
            let user = text_at(b, at + 8 + STRING_LEN, STRING_LEN);
            if user.is_empty() { text_at(b, at + 8, STRING_LEN) } else { user }
        })
        .collect();
    let out = (0..readings)
        .filter_map(|i| {
            let at = reading_off + i * reading_len;
            let kind = u32_at(b, at)?;
            let sensor = names.get(u32_at(b, at + 4)? as usize).cloned().unwrap_or_default();
            let user = text_at(b, at + 12 + STRING_LEN, STRING_LEN);
            let label = if user.is_empty() { text_at(b, at + 12, STRING_LEN) } else { user };
            let unit = text_at(b, at + 12 + 2 * STRING_LEN, UNIT_LEN);
            let raw = b.get(at + 12 + 2 * STRING_LEN + UNIT_LEN..at + 12 + 2 * STRING_LEN + UNIT_LEN + 8)?;
            let value = f64::from_le_bytes(raw.try_into().ok()?);
            value.is_finite().then_some(Reading { sensor, label, kind, unit, value })
        })
        .collect();
    Ok(Block { poll_time, readings: out })
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Temp {
    pub label: String,
    pub celsius: f32,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Fan {
    pub label: String,
    pub rpm: f32,
}

#[derive(Debug, Default, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Sensors {
    pub cpu: Option<f32>,
    pub gpu: Option<f32>,
    pub temperatures: Vec<Temp>,
    pub fans: Vec<Fan>,
}

fn celsius(r: &Reading) -> Option<f32> {
    let c = if r.unit.ends_with('F') { (r.value - 32.0) * 5.0 / 9.0 } else { r.value };
    (-40.0..=150.0).contains(&c).then_some(c as f32)
}

/// CPU and GPU temperature (the reading that best describes the whole chip),
/// every temperature, and the fans that report a speed.
pub fn summarize(readings: &[Reading]) -> Sensors {
    let is_cpu = |r: &Reading| r.sensor.to_uppercase().contains("CPU") || r.label.to_uppercase().starts_with("CPU");
    let is_gpu = |r: &Reading| r.sensor.to_uppercase().contains("GPU") || r.label.to_uppercase().starts_with("GPU");
    let pick = |in_chip: &dyn Fn(&Reading) -> bool, names: &[&str]| -> Option<f32> {
        let temps: Vec<&Reading> = readings.iter().filter(|r| r.kind == 1 && in_chip(r)).collect();
        names
            .iter()
            .find_map(|n| temps.iter().find(|r| r.label.to_lowercase().contains(n)).and_then(|r| celsius(r)))
            .or_else(|| temps.iter().find_map(|r| celsius(r)))
    };
    let temperatures = readings
        .iter()
        .filter(|r| r.kind == 1)
        .filter_map(|r| celsius(r).map(|c| Temp { label: if r.sensor.is_empty() { r.label.clone() } else { format!("{} · {}", r.label, r.sensor) }, celsius: c }))
        .collect();
    let fans = readings
        .iter()
        .filter(|r| r.kind == 3 && r.unit.eq_ignore_ascii_case("RPM") && (0.0..=50_000.0).contains(&r.value))
        .map(|r| Fan { label: r.label.clone(), rpm: r.value as f32 })
        .collect();
    Sensors {
        cpu: pick(&is_cpu, &["package", "tctl/tdie", "tdie", "cpu (tctl", "die (average", "core max"]),
        gpu: pick(&is_gpu, &["gpu temperature", "gpu core", "edge"]),
        temperatures,
        fans,
    }
}

pub fn fresh(block: &Block, now_secs: i64) -> bool {
    (now_secs - block.poll_time).abs() <= STALE_AFTER_SECS
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub available: bool,
    pub message: String,
    pub temperatures: usize,
    pub fans: usize,
}

/// Copies the shared memory block named `name`.
#[cfg(windows)]
fn read_map(name: &str) -> Result<Vec<u8>, String> {
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::Memory::{MapViewOfFile, OpenFileMappingW, UnmapViewOfFile, VirtualQuery, FILE_MAP_READ, MEMORY_BASIC_INFORMATION};

    let wide: Vec<u16> = name.encode_utf16().chain(Some(0)).collect();
    // SAFETY: the mapping is opened read-only; the copy length comes from
    // VirtualQuery, so it stays inside the mapped region; handle and view are
    // released on every path.
    unsafe {
        let handle = OpenFileMappingW(FILE_MAP_READ, 0, wide.as_ptr());
        if handle.is_null() {
            return Err("HWiNFO is not running, or its Shared Memory Support is off".into());
        }
        let view = MapViewOfFile(handle, FILE_MAP_READ, 0, 0, 0);
        if view.Value.is_null() {
            CloseHandle(handle);
            return Err("cannot read HWiNFO's shared memory".into());
        }
        let mut info: MEMORY_BASIC_INFORMATION = std::mem::zeroed();
        let got = VirtualQuery(view.Value, &mut info, std::mem::size_of::<MEMORY_BASIC_INFORMATION>());
        let out = if got == 0 { Vec::new() } else { std::slice::from_raw_parts(view.Value as *const u8, info.RegionSize.min(32 * 1024 * 1024)).to_vec() };
        UnmapViewOfFile(view);
        CloseHandle(handle);
        Ok(out)
    }
}

#[cfg(not(windows))]
fn read_map(_name: &str) -> Result<Vec<u8>, String> {
    Err("HWiNFO is a Windows program".into())
}

fn read_named(name: &str, now_secs: i64) -> Result<Sensors, String> {
    let block = parse(&read_map(name)?)?;
    if !fresh(&block, now_secs) {
        return Err("HWiNFO stopped updating its sensors".into());
    }
    Ok(summarize(&block.readings))
}

fn now_secs() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0)
}

pub fn read() -> Result<Sensors, String> {
    read_named(MAP_NAME, now_secs())
}

pub fn status() -> Status {
    match read() {
        Ok(s) => Status { available: true, message: format!("Reading {} temperatures and {} fans from HWiNFO", s.temperatures.len(), s.fans.len()), temperatures: s.temperatures.len(), fans: s.fans.len() },
        Err(message) => Status { available: false, message, temperatures: 0, fans: 0 },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn put(b: &mut [u8], at: usize, text: &[u8]) {
        b[at..at + text.len()].copy_from_slice(text);
    }

    /// A block as HWiNFO lays it out, with `extra` bytes on each element (newer versions).
    fn sample(poll: i64, extra: usize) -> Vec<u8> {
        let (sensor_len, reading_len) = (MIN_SENSOR_LEN + extra, MIN_READING_LEN + extra);
        type Row<'a> = (u32, u32, &'a [u8], &'a [u8], &'a [u8], f64);
        let rows: [Row; 6] = [
            (1, 0, b"Core 0", b"", b"\xB0C", 40.0),
            (1, 0, b"CPU Package", b"", b"\xB0C", 55.5),
            (1, 1, b"GPU Temperature", b"", b"\xB0F", 122.0),
            (3, 2, b"Chassis1", b"Front fan", b"RPM", 812.0),
            (7, 0, b"Total CPU Usage", b"", b"%", 9.0),
            (1, 0, b"Broken", b"", b"\xB0C", f64::NAN),
        ];
        let sensor_off = HEADER_LEN;
        let reading_off = sensor_off + 3 * sensor_len;
        let mut b = vec![0u8; reading_off + rows.len() * reading_len];
        put(&mut b, 0, &SIGNATURE.to_le_bytes());
        put(&mut b, 4, &2u32.to_le_bytes());
        put(&mut b, 12, &poll.to_le_bytes());
        for (at, v) in [(20, sensor_off), (24, sensor_len), (28, 3), (32, reading_off), (36, reading_len), (40, rows.len())] {
            put(&mut b, at, &(v as u32).to_le_bytes());
        }
        for (i, name) in [&b"CPU [#0]: AMD Ryzen"[..], b"GPU [#0]: NVIDIA", b"Nuvoton"].iter().enumerate() {
            put(&mut b, sensor_off + i * sensor_len + 8, name);
        }
        for (i, (kind, sensor, label, user, unit, value)) in rows.iter().enumerate() {
            let at = reading_off + i * reading_len;
            put(&mut b, at, &kind.to_le_bytes());
            put(&mut b, at + 4, &sensor.to_le_bytes());
            put(&mut b, at + 12, label);
            put(&mut b, at + 12 + STRING_LEN, user);
            put(&mut b, at + 12 + 2 * STRING_LEN, unit);
            put(&mut b, at + 12 + 2 * STRING_LEN + UNIT_LEN, &value.to_le_bytes());
        }
        b
    }

    #[test]
    fn parses_a_block_and_picks_chips() {
        for extra in [0, 256] {
            let block = parse(&sample(1000, extra)).unwrap();
            assert_eq!(block.poll_time, 1000);
            assert_eq!(block.readings.len(), 5, "NaN is dropped");
            assert_eq!(block.readings[0].unit, "\u{b0}C");
            assert_eq!(block.readings[3].label, "Front fan");
            let s = summarize(&block.readings);
            assert_eq!(s.cpu, Some(55.5));
            assert_eq!(s.gpu, Some(50.0), "Fahrenheit is converted");
            assert_eq!(s.fans, vec![Fan { label: "Front fan".into(), rpm: 812.0 }]);
            assert_eq!(s.temperatures[1].label, "CPU Package · CPU [#0]: AMD Ryzen");
        }
    }

    #[test]
    fn survives_damaged_blocks() {
        let good = sample(1, 0);
        assert!(parse(&[]).is_err());
        assert!(parse(&good[..20]).is_err());
        assert!(parse(&good[..good.len() - 1]).is_err(), "truncated");
        let mut bad = good.clone();
        bad[0] = b'X';
        assert!(parse(&bad).is_err(), "signature");
        let mut bad = good.clone();
        bad[4..8].copy_from_slice(&1u32.to_le_bytes());
        assert!(parse(&bad).is_err(), "old version");
        let mut bad = good.clone();
        bad[40..44].copy_from_slice(&u32::MAX.to_le_bytes());
        assert!(parse(&bad).is_err(), "huge count");
        let mut bad = good.clone();
        bad[32..36].copy_from_slice(&u32::MAX.to_le_bytes());
        assert!(parse(&bad).is_err(), "offset past the end");
        let mut bad = good.clone();
        bad[24..28].copy_from_slice(&10u32.to_le_bytes());
        assert!(parse(&bad).is_err(), "element too small");
        // A reading pointing at a sensor that does not exist keeps an empty sensor name.
        let mut odd = good;
        let at = HEADER_LEN + 3 * MIN_SENSOR_LEN + 4;
        odd[at..at + 4].copy_from_slice(&999u32.to_le_bytes());
        assert_eq!(parse(&odd).unwrap().readings[0].sensor, "");
    }

    #[test]
    fn ignores_implausible_values_and_stale_blocks() {
        let r = |kind, unit: &str, value| Reading { sensor: String::new(), label: "x".into(), kind, unit: unit.into(), value };
        let s = summarize(&[r(1, "\u{b0}C", 900.0), r(3, "%", 40.0), r(3, "RPM", -1.0)]);
        assert!(s.temperatures.is_empty() && s.fans.is_empty() && s.cpu.is_none());
        let b = Block { poll_time: 1000, readings: vec![] };
        assert!(fresh(&b, 1030) && !fresh(&b, 1100));
    }

    /// The real Windows calls against a temporary named mapping.
    #[cfg(windows)]
    #[test]
    fn reads_a_named_mapping() {
        use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
        use windows_sys::Win32::System::Memory::{CreateFileMappingW, MapViewOfFile, UnmapViewOfFile, FILE_MAP_WRITE, PAGE_READWRITE};
        let name = format!(r"Local\nr-sensors-test-{}", std::process::id());
        assert!(read_named(&name, 1000).is_err(), "no mapping yet");
        let wide: Vec<u16> = name.encode_utf16().chain(Some(0)).collect();
        let data = sample(1000, 0);
        // SAFETY: a test-local mapping sized for `data`.
        unsafe {
            let h = CreateFileMappingW(INVALID_HANDLE_VALUE, std::ptr::null(), PAGE_READWRITE, 0, data.len() as u32, wide.as_ptr());
            assert!(!h.is_null());
            let v = MapViewOfFile(h, FILE_MAP_WRITE, 0, 0, 0);
            std::ptr::copy_nonoverlapping(data.as_ptr(), v.Value as *mut u8, data.len());
            let s = read_named(&name, 1010).unwrap();
            assert_eq!((s.cpu, s.fans.len()), (Some(55.5), 1));
            assert!(read_named(&name, 5000).is_err(), "stale");
            UnmapViewOfFile(v);
            CloseHandle(h);
        }
        assert!(!status().available || status().temperatures > 0);
    }
}
