//! System metrics via `sysinfo`.
//!
//! The monitor is created lazily on the first request, so an idle dashboard
//! without system widgets costs nothing. The frontend decides the polling rate.

use std::time::Instant;

use serde::Serialize;
use sysinfo::{Components, Disks, Networks, Pid, ProcessesToUpdate, System, MINIMUM_CPU_UPDATE_INTERVAL};

use super::perf::{DiskIo, GpuMetrics, PerfCounters};
use crate::error::{AppError, AppResult};

/// Processes NETRUNNER refuses to terminate: killing them crashes or
/// destabilises Windows.
const PROTECTED: &[&str] = &[
    "system", "registry", "smss.exe", "csrss.exe", "wininit.exe", "winlogon.exe", "services.exe", "lsass.exe",
    "lsaiso.exe", "svchost.exe", "fontdrvhost.exe", "dwm.exe", "memory compression", "secure system", "msmpeng.exe",
];

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemInfo {
    pub host_name: Option<String>,
    pub os_name: Option<String>,
    pub os_version: Option<String>,
    pub kernel_version: Option<String>,
    pub cpu_brand: Option<String>,
    pub physical_cores: Option<usize>,
    pub logical_cores: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub timestamp_ms: u128,
    pub uptime_secs: u64,
    pub cpu: CpuMetrics,
    pub memory: MemoryMetrics,
    pub disks: Vec<DiskMetrics>,
    pub network: NetworkMetrics,
    /// Temperatures exposed by the OS. On Windows this is frequently empty
    /// (ACPI thermal zones need elevation); the UI shows "unavailable" then.
    pub temperatures: Vec<TemperatureReading>,
    /// `None` when Windows performance counters are unavailable.
    pub gpu: Option<GpuMetrics>,
    /// Physical disk throughput; `None` until two samples exist.
    pub disk_io: Option<DiskIo>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CpuMetrics {
    /// `None` until two samples exist (CPU usage is a delta measurement).
    pub usage_percent: Option<f32>,
    pub per_core_percent: Vec<f32>,
    /// Frequency as reported by the OS. On Windows this is usually the base
    /// clock rather than the live boost clock.
    pub frequency_mhz: Option<u64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryMetrics {
    pub total_bytes: u64,
    pub used_bytes: u64,
    pub available_bytes: u64,
    pub swap_total_bytes: u64,
    pub swap_used_bytes: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiskMetrics {
    pub name: String,
    pub mount_point: String,
    pub file_system: String,
    pub kind: String,
    pub removable: bool,
    pub total_bytes: u64,
    pub available_bytes: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NetworkMetrics {
    /// `None` on the first sample, when no interval exists yet.
    pub rx_bytes_per_sec: Option<f64>,
    pub tx_bytes_per_sec: Option<f64>,
    pub interfaces: Vec<InterfaceMetrics>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InterfaceMetrics {
    pub name: String,
    pub rx_bytes_per_sec: Option<f64>,
    pub tx_bytes_per_sec: Option<f64>,
    pub total_rx_bytes: u64,
    pub total_tx_bytes: u64,
    pub addresses: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TemperatureReading {
    pub label: String,
    pub celsius: f32,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessInfo {
    pub pid: u32,
    pub name: String,
    /// Normalised to 0–100 % of total CPU capacity.
    pub cpu_percent: f32,
    pub memory_bytes: u64,
    pub exe: Option<String>,
    /// False for processes NETRUNNER refuses to terminate.
    pub can_terminate: bool,
}

pub struct SystemMonitor {
    sys: System,
    disks: Disks,
    networks: Networks,
    components: Components,
    perf: Option<PerfCounters>,
    last_cpu_refresh: Instant,
    cpu_samples: u32,
    last_net_refresh: Option<Instant>,
    processes_primed: bool,
}

fn is_protected(name: &str, pid: u32) -> bool {
    pid <= 4 || pid == std::process::id() || PROTECTED.iter().any(|p| name.eq_ignore_ascii_case(p))
}

impl SystemMonitor {
    pub fn new() -> Self {
        let mut sys = System::new();
        sys.refresh_cpu_all();
        sys.refresh_memory();
        Self {
            sys,
            disks: Disks::new_with_refreshed_list(),
            networks: Networks::new_with_refreshed_list(),
            components: Components::new_with_refreshed_list(),
            perf: PerfCounters::new(),
            last_cpu_refresh: Instant::now(),
            cpu_samples: 1,
            last_net_refresh: None,
            processes_primed: false,
        }
    }

    /// Terminates a process after re-checking it against the protected list.
    pub fn terminate(&mut self, pid: u32) -> AppResult<String> {
        let pid_t = Pid::from_u32(pid);
        self.sys.refresh_processes(ProcessesToUpdate::Some(&[pid_t]), true);
        let process = self.sys.process(pid_t).ok_or_else(|| AppError::NotFound(format!("process {pid} is not running")))?;
        let name = process.name().to_string_lossy().into_owned();
        if is_protected(&name, pid) {
            return Err(AppError::Invalid(format!("{name} is a protected system process and cannot be terminated")));
        }
        if process.kill() {
            Ok(name)
        } else {
            Err(AppError::Launch(format!("Windows refused to terminate {name} (it may need administrator rights)")))
        }
    }

    /// Lower-cased names of running processes, for automation and integrations.
    pub fn running_names(&mut self) -> std::collections::HashSet<String> {
        self.sys.refresh_processes(ProcessesToUpdate::All, true);
        self.sys.processes().values().map(|p| p.name().to_string_lossy().to_lowercase()).collect()
    }

    pub fn info(&self) -> SystemInfo {
        SystemInfo {
            host_name: System::host_name(),
            os_name: System::long_os_version().or_else(System::name),
            os_version: System::os_version(),
            kernel_version: System::kernel_version(),
            cpu_brand: self.sys.cpus().first().map(|c| c.brand().trim().to_string()).filter(|b| !b.is_empty()),
            physical_cores: self.sys.physical_core_count(),
            logical_cores: self.sys.cpus().len(),
        }
    }

    pub fn snapshot(&mut self) -> Snapshot {
        // CPU usage is only meaningful once two refreshes are far enough apart.
        let cpu_ready = self.last_cpu_refresh.elapsed() >= MINIMUM_CPU_UPDATE_INTERVAL;
        if cpu_ready {
            self.sys.refresh_cpu_all();
            self.last_cpu_refresh = Instant::now();
            self.cpu_samples = self.cpu_samples.saturating_add(1);
        }
        let usage_valid = self.cpu_samples >= 2;
        self.sys.refresh_memory();
        self.disks.refresh(true);

        let now = Instant::now();
        let elapsed = self.last_net_refresh.map(|t| now.duration_since(t).as_secs_f64());
        self.networks.refresh(true);
        self.last_net_refresh = Some(now);

        if !self.components.is_empty() {
            self.components.refresh(false);
        }

        let cpus = self.sys.cpus();
        let cpu = CpuMetrics {
            usage_percent: usage_valid.then(|| self.sys.global_cpu_usage()),
            per_core_percent: if usage_valid { cpus.iter().map(|c| c.cpu_usage()).collect() } else { Vec::new() },
            frequency_mhz: cpus.iter().map(|c| c.frequency()).max().filter(|f| *f > 0),
        };

        let memory = MemoryMetrics {
            total_bytes: self.sys.total_memory(),
            used_bytes: self.sys.used_memory(),
            available_bytes: self.sys.available_memory(),
            swap_total_bytes: self.sys.total_swap(),
            swap_used_bytes: self.sys.used_swap(),
        };

        let disks = self
            .disks
            .list()
            .iter()
            .map(|d| DiskMetrics {
                name: d.name().to_string_lossy().into_owned(),
                mount_point: d.mount_point().to_string_lossy().into_owned(),
                file_system: d.file_system().to_string_lossy().into_owned(),
                kind: d.kind().to_string(),
                removable: d.is_removable(),
                total_bytes: d.total_space(),
                available_bytes: d.available_space(),
            })
            .collect();

        let rate = |bytes: u64| elapsed.filter(|e| *e > 0.0).map(|e| bytes as f64 / e);
        let mut interfaces: Vec<InterfaceMetrics> = self
            .networks
            .iter()
            .filter(|(_, data)| data.total_received() > 0 || data.total_transmitted() > 0)
            .map(|(name, data)| InterfaceMetrics {
                name: name.clone(),
                rx_bytes_per_sec: rate(data.received()),
                tx_bytes_per_sec: rate(data.transmitted()),
                total_rx_bytes: data.total_received(),
                total_tx_bytes: data.total_transmitted(),
                addresses: data.ip_networks().iter().map(|ip| ip.addr.to_string()).collect(),
            })
            .collect();
        interfaces.sort_by_key(|i| std::cmp::Reverse(i.total_rx_bytes));
        let sum = |f: fn(&InterfaceMetrics) -> Option<f64>| -> Option<f64> {
            elapsed.map(|_| interfaces.iter().filter_map(f).sum())
        };
        let network = NetworkMetrics {
            rx_bytes_per_sec: sum(|i| i.rx_bytes_per_sec),
            tx_bytes_per_sec: sum(|i| i.tx_bytes_per_sec),
            interfaces,
        };

        let temperatures = self
            .components
            .iter()
            .filter_map(|c| {
                let celsius = c.temperature()?;
                (celsius.is_finite() && celsius > 0.0)
                    .then(|| TemperatureReading { label: c.label().to_string(), celsius })
            })
            .collect();

        let (gpu, disk_io) = match self.perf.as_mut().map(|p| p.sample()) {
            Some((gpu, io)) => (Some(gpu), io),
            None => (None, None),
        };

        Snapshot {
            timestamp_ms: std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis())
                .unwrap_or_default(),
            uptime_secs: System::uptime(),
            cpu,
            memory,
            disks,
            network,
            temperatures,
            gpu,
            disk_io,
        }
    }

    /// Top processes by CPU, then memory. Process CPU usage is also a delta,
    /// so the very first call reports zero CPU for every process.
    pub fn top_processes(&mut self, limit: usize) -> (bool, Vec<ProcessInfo>) {
        self.sys.refresh_processes(ProcessesToUpdate::All, true);
        let primed = self.processes_primed;
        self.processes_primed = true;
        let cores = self.sys.cpus().len().max(1) as f32;
        let mut list: Vec<ProcessInfo> = self
            .sys
            .processes()
            .values()
            .filter(|p| p.pid().as_u32() != 0)
            .map(|p| {
                let name = p.name().to_string_lossy().into_owned();
                ProcessInfo {
                    pid: p.pid().as_u32(),
                    can_terminate: !is_protected(&name, p.pid().as_u32()),
                    name,
                    cpu_percent: p.cpu_usage() / cores,
                    memory_bytes: p.memory(),
                    exe: p.exe().map(|e| e.display().to_string()),
                }
            })
            .collect();
        list.sort_by(|a, b| {
            b.cpu_percent
                .partial_cmp(&a.cpu_percent)
                .unwrap_or(std::cmp::Ordering::Equal)
                .then(b.memory_bytes.cmp(&a.memory_bytes))
        });
        list.truncate(limit);
        (primed, list)
    }
}
