//! Windows Performance Data Helper (PDH) counters: GPU engine utilisation,
//! GPU memory and physical disk throughput. These are the same counters Task
//! Manager reads, so they work for any GPU vendor without vendor SDKs.
//! GPU temperature is not exposed by PDH and is therefore not reported.

use std::ptr;

use serde::Serialize;
use windows_sys::Win32::System::Performance::{
    PdhAddEnglishCounterW, PdhCloseQuery, PdhCollectQueryData, PdhGetFormattedCounterArrayW,
    PdhGetFormattedCounterValue, PdhOpenQueryW, PDH_FMT_COUNTERVALUE, PDH_FMT_COUNTERVALUE_ITEM_W, PDH_FMT_DOUBLE,
    PDH_FMT_LARGE,
};

const PDH_MORE_DATA: u32 = 0x8000_07D2;
const PDH_FMT_NOCAP100: u32 = 0x8000;
const ERROR_SUCCESS: u32 = 0;
const PDH_CSTATUS_VALID_DATA: u32 = 0;
const PDH_CSTATUS_NEW_DATA: u32 = 1;

type Handle = isize;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GpuAdapter {
    pub name: String,
    pub dedicated_total_bytes: Option<u64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GpuMetrics {
    pub adapters: Vec<GpuAdapter>,
    /// 3D engine utilisation summed across processes, capped at 100.
    pub usage_percent: Option<f64>,
    pub dedicated_used_bytes: Option<u64>,
    pub shared_used_bytes: Option<u64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiskIo {
    pub read_bytes_per_sec: f64,
    pub write_bytes_per_sec: f64,
}

pub struct PerfCounters {
    query: Handle,
    gpu_3d: Option<Handle>,
    gpu_dedicated: Option<Handle>,
    gpu_shared: Option<Handle>,
    disk_read: Option<Handle>,
    disk_write: Option<Handle>,
    samples: u32,
    adapters: Vec<GpuAdapter>,
}

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

impl PerfCounters {
    pub fn new() -> Option<Self> {
        let mut query: Handle = 0;
        // SAFETY: out-pointer is valid; null data source means live data.
        if unsafe { PdhOpenQueryW(ptr::null(), 0, &mut query) } != ERROR_SUCCESS {
            return None;
        }
        let add = |path: &str| -> Option<Handle> {
            let mut counter: Handle = 0;
            let w = wide(path);
            // SAFETY: query is open, path is NUL-terminated, out-pointer valid.
            (unsafe { PdhAddEnglishCounterW(query, w.as_ptr(), 0, &mut counter) } == ERROR_SUCCESS).then_some(counter)
        };
        let mut counters = Self {
            query,
            gpu_3d: add(r"\GPU Engine(*engtype_3D)\Utilization Percentage"),
            gpu_dedicated: add(r"\GPU Adapter Memory(*)\Dedicated Usage"),
            gpu_shared: add(r"\GPU Adapter Memory(*)\Shared Usage"),
            disk_read: add(r"\PhysicalDisk(_Total)\Disk Read Bytes/sec"),
            disk_write: add(r"\PhysicalDisk(_Total)\Disk Write Bytes/sec"),
            samples: 0,
            adapters: read_gpu_adapters(),
        };
        counters.collect();
        Some(counters)
    }

    fn collect(&mut self) {
        // SAFETY: query handle is valid for the lifetime of self.
        if unsafe { PdhCollectQueryData(self.query) } == ERROR_SUCCESS {
            self.samples = self.samples.saturating_add(1);
        }
    }

    /// Rate counters need two collections; until then values are `None`.
    pub fn sample(&mut self) -> (GpuMetrics, Option<DiskIo>) {
        self.collect();
        let ready = self.samples >= 2;
        let gpu = GpuMetrics {
            adapters: self.adapters.clone(),
            usage_percent: if ready { self.gpu_3d.and_then(|c| sum_array(c, false)).map(|v| v.min(100.0)) } else { None },
            dedicated_used_bytes: self.gpu_dedicated.and_then(|c| sum_array(c, true)).map(|v| v as u64),
            shared_used_bytes: self.gpu_shared.and_then(|c| sum_array(c, true)).map(|v| v as u64),
        };
        let disk = if ready {
            match (self.disk_read.and_then(single), self.disk_write.and_then(single)) {
                (Some(r), Some(w)) => Some(DiskIo { read_bytes_per_sec: r, write_bytes_per_sec: w }),
                _ => None,
            }
        } else {
            None
        };
        (gpu, disk)
    }
}

impl Drop for PerfCounters {
    fn drop(&mut self) {
        // SAFETY: closing the query also frees its counters.
        unsafe { PdhCloseQuery(self.query) };
    }
}

fn single(counter: Handle) -> Option<f64> {
    let mut value: PDH_FMT_COUNTERVALUE = unsafe { std::mem::zeroed() };
    // SAFETY: counter belongs to a collected query; value is a valid out-pointer.
    let status = unsafe { PdhGetFormattedCounterValue(counter, PDH_FMT_DOUBLE, ptr::null_mut(), &mut value) };
    if status != ERROR_SUCCESS || !matches!(value.CStatus, PDH_CSTATUS_VALID_DATA | PDH_CSTATUS_NEW_DATA) {
        return None;
    }
    // SAFETY: PDH_FMT_DOUBLE was requested, so the double member is active.
    Some(unsafe { value.Anonymous.doubleValue })
}

/// Sums all instances of a wildcard counter. `Some(0.0)` when there are no
/// instances (e.g. an idle GPU), `None` when the counter cannot be read.
fn sum_array(counter: Handle, large: bool) -> Option<f64> {
    let format = if large { PDH_FMT_LARGE } else { PDH_FMT_DOUBLE | PDH_FMT_NOCAP100 };
    let mut size: u32 = 0;
    let mut count: u32 = 0;
    // SAFETY: first call with a null buffer only queries the required size.
    let status = unsafe { PdhGetFormattedCounterArrayW(counter, format, &mut size, &mut count, ptr::null_mut()) };
    if status != PDH_MORE_DATA {
        return if status == ERROR_SUCCESS { Some(0.0) } else { None };
    }
    let item_size = std::mem::size_of::<PDH_FMT_COUNTERVALUE_ITEM_W>();
    let mut buf: Vec<PDH_FMT_COUNTERVALUE_ITEM_W> = Vec::with_capacity(size as usize / item_size + 1);
    // SAFETY: buffer capacity covers `size` bytes as requested by PDH.
    let status = unsafe { PdhGetFormattedCounterArrayW(counter, format, &mut size, &mut count, buf.as_mut_ptr()) };
    if status != ERROR_SUCCESS {
        return None;
    }
    // SAFETY: PDH initialised `count` items.
    unsafe { buf.set_len(count as usize) };
    let total = buf
        .iter()
        .filter(|i| matches!(i.FmtValue.CStatus, PDH_CSTATUS_VALID_DATA | PDH_CSTATUS_NEW_DATA))
        // SAFETY: the union member matches the requested format.
        .map(|i| unsafe { if large { i.FmtValue.Anonymous.largeValue as f64 } else { i.FmtValue.Anonymous.doubleValue } })
        .sum();
    Some(total)
}

/// Reads display adapters from the display device class in the registry
/// (readable by standard users). Software adapters are skipped.
fn read_gpu_adapters() -> Vec<GpuAdapter> {
    use winreg::enums::HKEY_LOCAL_MACHINE;
    use winreg::RegKey;
    const CLASS: &str = r"SYSTEM\CurrentControlSet\Control\Class\{4d36e968-e325-11ce-bfc1-08002be10318}";
    let Ok(class) = RegKey::predef(HKEY_LOCAL_MACHINE).open_subkey(CLASS) else {
        return Vec::new();
    };
    let mut out: Vec<GpuAdapter> = Vec::new();
    for name in class.enum_keys().flatten().filter(|k| k.chars().all(|c| c.is_ascii_digit())) {
        let Ok(key) = class.open_subkey(&name) else { continue };
        let Ok(desc) = key.get_value::<String, _>("DriverDesc") else { continue };
        if desc.contains("Microsoft Basic") || desc.contains("Remote Display") || out.iter().any(|a| a.name == desc) {
            continue;
        }
        let memory = key
            .get_value::<u64, _>("HardwareInformation.qwMemorySize")
            .ok()
            .or_else(|| key.get_value::<u32, _>("HardwareInformation.MemorySize").ok().map(u64::from))
            .or_else(|| {
                key.get_raw_value("HardwareInformation.MemorySize")
                    .ok()
                    .filter(|v| v.bytes.len() >= 4)
                    .map(|v| u32::from_le_bytes([v.bytes[0], v.bytes[1], v.bytes[2], v.bytes[3]]) as u64)
            })
            .filter(|m| *m > 0);
        out.push(GpuAdapter { name: desc, dedicated_total_bytes: memory });
    }
    out
}
