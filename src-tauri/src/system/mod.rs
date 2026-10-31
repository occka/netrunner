//! Hardware and OS monitoring. Only reports values the OS actually provides;
//! anything unavailable is returned as `None` / empty, never estimated.

pub mod monitor;
pub mod network;
pub mod perf;
pub mod power;
pub mod services;
pub mod startup;

/// Smoke tests against the real OS APIs on the build machine. They check that
/// the FFI code returns plausible data without crashing.
#[cfg(test)]
mod smoke {
    #[test]
    fn services_enumerate() {
        let list = super::services::list().unwrap();
        assert!(list.iter().any(|s| s.state == "running"), "some service must be running");
    }

    #[test]
    fn network_adapters_enumerate() {
        let status = super::network::status();
        assert!(!status.adapters.is_empty());
        assert!(status.adapters.iter().all(|a| !a.name.is_empty()));
    }

    #[test]
    fn power_and_startup_do_not_fail() {
        let p = super::power::info();
        assert!(p.plans.iter().filter(|x| x.active).count() <= 1);
        let _ = super::startup::list();
    }

    #[test]
    fn perf_counters_sample() {
        if let Some(mut perf) = super::perf::PerfCounters::new() {
            std::thread::sleep(std::time::Duration::from_millis(300));
            let (gpu, disk) = perf.sample();
            if let Some(u) = gpu.usage_percent {
                assert!((0.0..=100.0).contains(&u));
            }
            if let Some(d) = disk {
                assert!(d.read_bytes_per_sec >= 0.0);
            }
        }
    }

    #[test]
    fn game_scan_does_not_fail() {
        let scan = crate::services::games::scan();
        assert_eq!(scan.sources.len(), 4);
        for g in scan.games.iter().filter(|g| g.source == "prism") {
            println!("prism instance: {} -> {} {}", g.name, g.launch_target, crate::services::games::launch_params(g));
        }
    }
}
