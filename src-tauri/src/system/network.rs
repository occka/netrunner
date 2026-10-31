//! Network adapters and connectivity from the Windows IP Helper API.
//!
//! Connectivity comes from `GetNetworkConnectivityHint`, the same signal the
//! taskbar network icon uses; NETRUNNER sends no probe traffic of its own.
//! VPN detection is limited to "a VPN-type adapter is up". It never claims a
//! VPN is protecting traffic.

use serde::Serialize;
use windows_sys::Win32::NetworkManagement::IpHelper::{
    GetAdaptersAddresses, GetNetworkConnectivityHint, GAA_FLAG_INCLUDE_GATEWAYS, GAA_FLAG_SKIP_ANYCAST,
    GAA_FLAG_SKIP_MULTICAST, IP_ADAPTER_ADDRESSES_LH,
};
use windows_sys::Win32::Networking::WinSock::NL_NETWORK_CONNECTIVITY_HINT;

const ERROR_BUFFER_OVERFLOW: u32 = 111;
const IF_TYPE_SOFTWARE_LOOPBACK: u32 = 24;
const IF_TYPE_PPP: u32 = 23;
const IF_TYPE_PROP_VIRTUAL: u32 = 53;
const IF_TYPE_TUNNEL: u32 = 131;
const IF_OPER_UP: i32 = 1;

const VPN_HINTS: &[&str] = &[
    "wireguard", "wintun", "tap-windows", "tap adapter", "openvpn", "nordlynx", "protonvpn", "mullvad", "anyconnect",
    "fortinet", "fortissl", "globalprotect", "pangp", "zerotier", "tailscale", "expressvpn", "surfshark", "hamachi",
    "vpn",
];

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Adapter {
    pub name: String,
    pub description: String,
    pub kind: &'static str,
    pub up: bool,
    pub link_speed_bps: Option<u64>,
    pub has_gateway: bool,
    pub mac: Option<String>,
    pub vpn_like: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NetworkStatus {
    /// unknown | none | local | internet | constrained
    pub connectivity: &'static str,
    pub metered: Option<bool>,
    pub adapters: Vec<Adapter>,
}

unsafe fn pwstr(p: *const u16) -> String {
    if p.is_null() {
        return String::new();
    }
    let mut len = 0;
    while *p.add(len) != 0 {
        len += 1;
    }
    String::from_utf16_lossy(std::slice::from_raw_parts(p, len))
}

fn kind(if_type: u32) -> &'static str {
    match if_type {
        6 => "ethernet",
        71 => "wifi",
        IF_TYPE_PPP => "ppp",
        IF_TYPE_TUNNEL => "tunnel",
        IF_TYPE_PROP_VIRTUAL => "virtual",
        243 | 244 => "cellular",
        _ => "other",
    }
}

fn connectivity() -> (&'static str, Option<bool>) {
    let mut hint: NL_NETWORK_CONNECTIVITY_HINT = unsafe { std::mem::zeroed() };
    // SAFETY: valid out-pointer; API available on Windows 10 2004+.
    if unsafe { GetNetworkConnectivityHint(&mut hint) } != 0 {
        return ("unknown", None);
    }
    let level = match hint.ConnectivityLevel {
        1 => "none",
        2 => "local",
        3 => "internet",
        4 => "constrained",
        _ => "unknown",
    };
    // ConnectivityCost: 1 = unrestricted, 2 = fixed, 3 = variable (metered).
    let metered = match hint.ConnectivityCost {
        1 => Some(false),
        2 | 3 => Some(true),
        _ => None,
    };
    (level, metered)
}

pub fn status() -> NetworkStatus {
    let (connectivity, metered) = connectivity();
    NetworkStatus { connectivity, metered, adapters: adapters() }
}

fn adapters() -> Vec<Adapter> {
    let flags = GAA_FLAG_INCLUDE_GATEWAYS | GAA_FLAG_SKIP_ANYCAST | GAA_FLAG_SKIP_MULTICAST;
    let mut size: u32 = 16 * 1024;
    let mut buf: Vec<u64> = Vec::new(); // u64 for 8-byte alignment of the structs
    for _ in 0..3 {
        buf = vec![0u64; size as usize / 8 + 1];
        // SAFETY: buffer has `size` bytes; Windows reports the needed size on overflow.
        let status = unsafe { GetAdaptersAddresses(0, flags, std::ptr::null(), buf.as_mut_ptr() as *mut IP_ADAPTER_ADDRESSES_LH, &mut size) };
        match status {
            0 => break,
            ERROR_BUFFER_OVERFLOW => continue,
            _ => return Vec::new(),
        }
    }
    let mut out = Vec::new();
    let mut cur = buf.as_ptr() as *const IP_ADAPTER_ADDRESSES_LH;
    // SAFETY: walking the linked list Windows wrote into `buf`, which outlives the loop.
    unsafe {
        while !cur.is_null() {
            let a = &*cur;
            cur = a.Next;
            if a.IfType == IF_TYPE_SOFTWARE_LOOPBACK {
                continue;
            }
            let description = pwstr(a.Description);
            let lower = description.to_lowercase();
            let up = a.OperStatus == IF_OPER_UP;
            let vpn_like = matches!(a.IfType, IF_TYPE_PPP | IF_TYPE_PROP_VIRTUAL | IF_TYPE_TUNNEL | 6)
                && VPN_HINTS.iter().any(|h| lower.contains(h))
                && !lower.contains("hyper-v");
            let mac = (a.PhysicalAddressLength == 6).then(|| {
                a.PhysicalAddress[..6].iter().map(|b| format!("{b:02X}")).collect::<Vec<_>>().join("-")
            });
            let speed = a.ReceiveLinkSpeed.max(a.TransmitLinkSpeed);
            out.push(Adapter {
                name: pwstr(a.FriendlyName),
                description,
                kind: kind(a.IfType),
                up,
                link_speed_bps: (up && speed > 0 && speed != u64::MAX).then_some(speed),
                has_gateway: !a.FirstGatewayAddress.is_null(),
                mac,
                vpn_like,
            });
        }
    }
    out.sort_by_key(|a| (!a.up, !a.has_gateway, a.name.to_lowercase()));
    out
}
