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

/** Playtime of one game (services/playtime.rs). */
export interface Playtime {
  gameId: string;
  name: string;
  /** Seconds in the requested period. */
  seconds: number;
  sessions: number;
  /** Unix ms, any period. */
  lastPlayed: number;
}

export interface PlayDay {
  /** Local date, YYYY-MM-DD. */
  date: string;
  seconds: number;
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

export type TriggerKind =
  | "netrunner_start"
  | "manual"
  | "app_started"
  | "app_stopped"
  | "profile_changed"
  | "time"
  | "interval"
  | "file_created"
  | "download_finished"
  | "network_up"
  | "network_down"
  | "game_started"
  | "game_stopped"
  | "power_source"
  | "power_plan";
export type ConditionKind = "profile" | "time_between" | "weekday" | "process_running" | "process_not_running" | "power_source" | "vpn";
export type ActionKind =
  | "launch_program"
  | "launch_entry"
  | "switch_profile"
  | "notify"
  | "show_overlay"
  | "hide_overlay"
  | "show_overlay_set"
  | "hide_overlay_set"
  | "set_volume"
  | "power_plan"
  | "open_url"
  | "wait";

export interface RuleCondition {
  kind: ConditionKind;
  value: string;
}

export interface RuleAction {
  kind: ActionKind;
  value: string;
  /** Arguments for launch_program. */
  args: string;
}

/** One trigger, conditions that must all hold, and actions run in order (services/automation.rs). */
export interface AutomationRule {
  id: number;
  name: string;
  enabled: boolean;
  triggerKind: TriggerKind;
  triggerValue: string;
  conditions: RuleCondition[];
  actions: RuleAction[];
  runCount: number;
  lastRunAt: string | null;
}

export type AutomationInput = Omit<AutomationRule, "id" | "runCount" | "lastRunAt">;

/** Result of checking a rule without running it. */
export interface DryRun {
  triggerValue: string;
  conditions: { kind: ConditionKind; value: string; met: boolean }[];
  wouldRun: boolean;
  actions: string[];
}

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
  /** Profile whose overlay set this belongs to; null = shown in every profile. */
  profileId: number | null;
  /** While locked, the mouse passes through the overlay to the window below. */
  clickThrough: boolean;
}
