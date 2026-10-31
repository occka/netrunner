/** Payload types for Phase 2 commands (system control, games, integrations, automation, overlays). */

export interface GpuMetrics {
  adapters: { name: string; dedicatedTotalBytes: number | null }[];
  usagePercent: number | null;
  dedicatedUsedBytes: number | null;
  sharedUsedBytes: number | null;
}

export interface DiskIo {
  readBytesPerSec: number;
  writeBytesPerSec: number;
}

export interface ProcessInfo {
  pid: number;
  name: string;
  cpuPercent: number;
  memoryBytes: number;
  exe: string | null;
  canTerminate: boolean;
}

export interface StartupEntry {
  id: string;
  name: string;
  command: string;
  source: string;
  enabled: boolean;
  canToggle: boolean;
}

export interface ServiceInfo {
  name: string;
  displayName: string;
  state: "stopped" | "starting" | "stopping" | "running" | "resuming" | "pausing" | "paused" | "unknown";
  pid: number | null;
}

export interface PowerInfo {
  onAcPower: boolean | null;
  hasBattery: boolean;
  batteryPercent: number | null;
  batterySecondsLeft: number | null;
  batterySaver: boolean;
  plans: { guid: string; name: string; active: boolean }[];
}

export interface NetworkAdapter {
  name: string;
  description: string;
  kind: "ethernet" | "wifi" | "ppp" | "tunnel" | "virtual" | "cellular" | "other";
  up: boolean;
  linkSpeedBps: number | null;
  hasGateway: boolean;
  mac: string | null;
  vpnLike: boolean;
}

export interface NetworkStatus {
  connectivity: "unknown" | "none" | "local" | "internet" | "constrained";
  metered: boolean | null;
  adapters: NetworkAdapter[];
}

export interface Game {
  id: string;
  source: "steam" | "epic" | "gog" | "prism";
  name: string;
  installDir: string | null;
  sizeBytes: number | null;
}

export interface LibraryScan {
  games: Game[];
  sources: { source: Game["source"]; detected: boolean; count: number }[];
}

export interface Capability {
  available: boolean;
  detail: string;
}

export interface Integration {
  id: string;
  name: string;
  category: string;
  installed: boolean;
  path: string | null;
  args: string;
  running: boolean;
  launch: Capability;
  detect: Capability;
  status: Capability;
  control: Capability;
}

export type TriggerKind = "netrunner_start" | "app_started" | "app_stopped" | "profile_changed" | "manual";
export type ActionKind = "launch_program" | "launch_entry" | "switch_profile" | "notify" | "show_overlay" | "hide_overlay";

export interface AutomationRule {
  id: number;
  name: string;
  enabled: boolean;
  triggerKind: TriggerKind;
  triggerValue: string;
  conditionProfileId: number | null;
  actionKind: ActionKind;
  actionValue: string;
  /** Arguments for launch_program. */
  actionArgs: string;
  runCount: number;
  lastRunAt: string | null;
}

export type AutomationInput = Omit<AutomationRule, "id" | "runCount" | "lastRunAt">;

export interface Overlay {
  id: number;
  widgetType: string;
  x: number;
  y: number;
  width: number;
  height: number;
  opacity: number;
  locked: boolean;
  visible: boolean;
  showOnStartup: boolean;
  /** Widget settings (frame + content), see widgets/settings.ts. */
  config: Record<string, unknown>;
  /** Web overlays (widgetType "web"): the page shown. */
  url: string;
  title: string;
}
